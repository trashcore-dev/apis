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
  if (!yt) yt = await Innertube.create({ cache: false, generate_session_locally: true });
  return yt;
}

function isYouTubeUrl(url) {
  return url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com');
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function getStreamUrl(videoId, format = 'audio') {
  const youtube = await getYT();
  const info = await youtube.getInfo(videoId);
  const chosen = format === 'audio'
    ? info.chooseFormat({ type: 'audio', quality: 'best' })
    : info.chooseFormat({ type: 'video+audio', quality: '360p' });
  const streamUrl = chosen.decipher(youtube.session.player);
  return { streamUrl, info };
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

// GET /api/info?url=
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });
  try {
    const youtube = await getYT();
    const info = await youtube.getInfo(videoId);
    const d = info.basic_info;
    return res.json({
      id: d.id, title: d.title,
      uploader: d.channel?.name || d.author || null,
      duration: d.duration,
      thumbnail: d.thumbnail?.[0]?.url || null,
      webpage_url: `https://www.youtube.com/watch?v=${d.id}`,
      view_count: d.view_count,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
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

// GET /api/stream-url?url=&format=audio|video
// Returns direct CDN URL — bot should fetch/download from this URL
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });
  try {
    const { streamUrl, info } = await getStreamUrl(videoId, format);
    const d = info.basic_info;
    return res.json({
      stream_url: streamUrl,
      title: d.title,
      uploader: d.channel?.name || d.author || null,
      duration: d.duration,
      thumbnail: d.thumbnail?.[0]?.url || null,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/download?url=&format=audio|video
// Proxies the stream through the server
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });
  try {
    const { streamUrl, info } = await getStreamUrl(videoId, format);
    const title = (info.basic_info.title || 'audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
    const ext = format === 'audio' ? 'm4a' : 'mp4';
    const mime = format === 'audio' ? 'audio/mp4' : 'video/mp4';

    // Proxy the CDN stream
    const upstream = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.youtube.com/',
      }
    });

    if (!upstream.ok) throw new Error(`Upstream error: ${upstream.status}`);

    res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
    res.setHeader('Content-Type', mime);
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
    const r = await yts(isYouTubeUrl(q) ? { videoId: extractVideoId(q) } : q);
    const videos = isYouTubeUrl(q) ? (r.video ? [r.video] : []) : r.videos.slice(0, parseInt(limit));
    const host = `${req.protocol}://${req.get('host')}`;
    const results = videos.map(v => {
      const ytUrl = v.url || `https://www.youtube.com/watch?v=${v.videoId}`;
      return {
        id: v.videoId, title: v.title,
        uploader: v.author?.name || null,
        duration: v.duration?.seconds || null,
        thumbnail: v.thumbnail, url: ytUrl,
        stream_url: `${host}/api/stream-url?url=${encodeURIComponent(ytUrl)}&format=audio`,
        download_url: `${host}/api/download?url=${encodeURIComponent(ytUrl)}&format=audio`,
      };
    });
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /downloader/youtubemp4?q=&limit=
app.get('/downloader/youtubemp4', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(isYouTubeUrl(q) ? { videoId: extractVideoId(q) } : q);
    const videos = isYouTubeUrl(q) ? (r.video ? [r.video] : []) : r.videos.slice(0, parseInt(limit));
    const host = `${req.protocol}://${req.get('host')}`;
    const results = videos.map(v => {
      const ytUrl = v.url || `https://www.youtube.com/watch?v=${v.videoId}`;
      return {
        id: v.videoId, title: v.title,
        uploader: v.author?.name || null,
        duration: v.duration?.seconds || null,
        thumbnail: v.thumbnail, url: ytUrl,
        stream_url: `${host}/api/stream-url?url=${encodeURIComponent(ytUrl)}&format=video`,
        download_url: `${host}/api/download?url=${encodeURIComponent(ytUrl)}&format=video`,
      };
    });
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`DrexMusic API running on port ${PORT}`);
  getYT().then(() => console.log('YouTube session ready')).catch(console.error);
});
