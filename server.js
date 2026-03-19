const express = require('express');
const cors = require('cors');
const { Innertube } = require('youtubei.js');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let yt = null;

async function getYT() {
  // Always create a fresh session to avoid stale player
  yt = await Innertube.create({
    cache: false,
    generate_session_locally: false,
  });
  return yt;
}

function isYouTubeUrl(url) {
  return url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com');
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function getAudioInfo(videoId) {
  const youtube = await getYT();
  const info = await youtube.getInfo(videoId);

  // Get streaming data with deciphered URLs
  const streamingData = info.streaming_data;
  if (!streamingData) throw new Error('No streaming data available');

  // Try adaptive formats first (audio only), then regular formats
  const allFormats = [
    ...(streamingData.adaptive_formats || []),
    ...(streamingData.formats || []),
  ];

  // Find best audio format
  const audioFormats = allFormats.filter(f => {
    const mime = f.mime_type || '';
    return mime.includes('audio') && !mime.includes('video');
  });

  // Sort by bitrate
  audioFormats.sort((a, b) => (b.average_bitrate || b.bitrate || 0) - (a.average_bitrate || a.bitrate || 0));

  const best = audioFormats[0];
  if (!best) throw new Error('No audio format found');

  // Decipher URL
  let url = best.url;
  if (!url && best.signature_cipher) {
    // Parse signature cipher
    const params = new URLSearchParams(best.signature_cipher);
    url = params.get('url');
  }

  if (!url) throw new Error('Could not get audio URL');

  return {
    url,
    mime_type: best.mime_type || 'audio/mp4',
    bitrate: best.average_bitrate || best.bitrate,
    title: info.basic_info.title,
    uploader: info.basic_info.channel?.name || info.basic_info.author || null,
    duration: info.basic_info.duration,
    thumbnail: info.basic_info.thumbnail?.[0]?.url || null,
  };
}

// GET /api/health
app.get('/api/health', async (req, res) => {
  try {
    await getYT();
    res.json({ status: 'ok', engine: 'youtubei.js' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// GET /api/search?q=&limit=
app.get('/api/search', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(q);
    const results = r.videos.slice(0, parseInt(limit)).map(v => ({
      id: v.videoId, title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail, url: v.url,
    }));
    return res.json({ results });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/stream-url?url=&format=audio
app.get('/api/stream-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs supported' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });

  try {
    const audio = await getAudioInfo(videoId);
    return res.json({
      stream_url: audio.url,
      mime_type: audio.mime_type,
      title: audio.title,
      uploader: audio.uploader,
      duration: audio.duration,
      thumbnail: audio.thumbnail,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/download?url=&format=audio|video
// Proxies audio stream back to client
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs supported' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });

  try {
    const audio = await getAudioInfo(videoId);
    const safeName = audio.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);

    const upstream = await fetch(audio.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
      }
    });

    if (!upstream.ok) throw new Error(`Upstream error: ${upstream.status}`);

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.m4a"`);
    res.setHeader('Content-Type', audio.mime_type || 'audio/mp4');
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }

    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /downloader/youtubemp3?q=&limit=
app.get('/downloader/youtubemp3', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(q);
    const videos = r.videos.slice(0, parseInt(limit));
    const host = `${req.protocol}://${req.get('host')}`;
    const results = videos.map(v => ({
      id: v.videoId, title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail,
      url: v.url,
      stream_url: `${host}/api/stream-url?url=${encodeURIComponent(v.url)}`,
      download_url: `${host}/api/download?url=${encodeURIComponent(v.url)}&format=audio`,
    }));
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /downloader/youtubemp4?q=&limit=
app.get('/downloader/youtubemp4', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(q);
    const videos = r.videos.slice(0, parseInt(limit));
    const host = `${req.protocol}://${req.get('host')}`;
    const results = videos.map(v => ({
      id: v.videoId, title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail,
      url: v.url,
      stream_url: `${host}/api/stream-url?url=${encodeURIComponent(v.url)}&format=video`,
      download_url: `${host}/api/download?url=${encodeURIComponent(v.url)}&format=video`,
    }));
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DrexMusic API running on port ${PORT}`);
});
