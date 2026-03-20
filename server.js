const express = require('express');
const cors = require('cors');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Public Invidious instances — fallback through them
const INVIDIOUS = [
  'https://iv.datura.network',
  'https://invidious.fdn.fr',
  'https://invidious.privacydev.net',
  'https://yt.cdaut.de',
  'https://invidious.nerdvpn.de',
];

async function invidiousRequest(path) {
  for (const host of INVIDIOUS) {
    try {
      const res = await fetch(`${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && !data.error) return data;
      }
    } catch {}
  }
  throw new Error('All Invidious instances failed');
}

async function getVideoInfo(videoId) {
  return invidiousRequest(`/api/v1/videos/${videoId}?fields=videoId,title,author,lengthSeconds,videoThumbnails,adaptiveFormats,formatStreams`);
}

function getBestAudio(info) {
  const audio = (info.adaptiveFormats || [])
    .filter(f => f.type?.includes('audio') && f.url)
    .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  return audio[0];
}

function getBestVideo(info) {
  // Try combined formats first
  const combined = (info.formatStreams || [])
    .filter(f => f.url && f.type?.includes('video'))
    .sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));
  if (combined.length) return combined[0];

  // Fallback to adaptive
  const adaptive = (info.adaptiveFormats || [])
    .filter(f => f.type?.includes('video') && f.url)
    .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  return adaptive[0];
}

function getBestThumb(thumbs) {
  if (!thumbs || !thumbs.length) return null;
  const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

// GET /api/health
app.get('/api/health', async (req, res) => {
  try {
    await invidiousRequest('/api/v1/videos/dQw4w9WgXcQ?fields=videoId,title');
    res.json({ status: 'ok', engine: 'invidious' });
  } catch(e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// GET /api/search?q=&limit=
app.get('/api/search', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(q);
    return res.json(r.videos.slice(0, parseInt(limit)).map(v => ({
      id: v.videoId, title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail, url: v.url,
    })));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/stream?url=&format=audio|video
// Proxies the stream through server
app.get('/api/stream', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  const videoId = match ? match[1] : url.length === 11 ? url : null;
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });

  try {
    const info = await getVideoInfo(videoId);
    const fmt = format === 'video' ? getBestVideo(info) : getBestAudio(info);
    if (!fmt?.url) throw new Error('No stream URL found');

    const safeName = (info.title || 'audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
    const isDownload = req.query.dl === '1';
    const ext = format === 'video' ? 'mp4' : 'webm';
    const mime = format === 'video' ? 'video/mp4' : 'audio/webm';

    // Proxy the stream
    const upstream = await fetch(fmt.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.youtube.com/',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok) throw new Error(`Upstream error: ${upstream.status}`);

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${safeName}.${ext}"`);
    }
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }

    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);

    req.on('close', () => {});
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/stream-url?url=&format=audio|video
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  const videoId = match ? match[1] : url.length === 11 ? url : null;
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const info = await getVideoInfo(videoId);
    const fmt = format === 'video' ? getBestVideo(info) : getBestAudio(info);
    if (!fmt?.url) throw new Error('No stream URL found');

    const host = `${req.protocol}://${req.get('host')}`;
    return res.json({
      stream_url: `${host}/api/stream?url=${encodeURIComponent(url)}&format=${format}`,
      title: info.title,
      uploader: info.author,
      duration: info.lengthSeconds,
      thumbnail: getBestThumb(info.videoThumbnails),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/download?url=&format=audio|video
app.get('/api/download', async (req, res) => {
  req.query.dl = '1';
  // Forward to stream endpoint
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  const videoId = match ? match[1] : url.length === 11 ? url : null;
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const info = await getVideoInfo(videoId);
    const fmt = format === 'video' ? getBestVideo(info) : getBestAudio(info);
    if (!fmt?.url) throw new Error('No stream URL found');

    const safeName = (info.title || 'audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
    const ext = format === 'video' ? 'mp4' : 'webm';
    const mime = format === 'video' ? 'video/mp4' : 'audio/webm';

    const upstream = await fetch(fmt.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com/' },
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok) throw new Error(`Upstream: ${upstream.status}`);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }

    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /downloader/youtubemp3?q=&limit=
app.get('/downloader/youtubemp3', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(q);
    const host = `${req.protocol}://${req.get('host')}`;
    return res.json(r.videos.slice(0, parseInt(limit)).map(v => ({
      id: v.videoId, title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail, url: v.url,
      stream_url: `${host}/api/stream?url=${encodeURIComponent(v.url)}&format=audio`,
      download_url: `${host}/api/download?url=${encodeURIComponent(v.url)}&format=audio`,
    })));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /downloader/youtubemp4?q=&limit=
app.get('/downloader/youtubemp4', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const r = await yts(q);
    const host = `${req.protocol}://${req.get('host')}`;
    return res.json(r.videos.slice(0, parseInt(limit)).map(v => ({
      id: v.videoId, title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail, url: v.url,
      stream_url: `${host}/api/stream?url=${encodeURIComponent(v.url)}&format=video`,
      download_url: `${host}/api/download?url=${encodeURIComponent(v.url)}&format=video`,
    })));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /download/youtube?q=&type=mp3|mp4
app.get('/download/youtube', async (req, res) => {
  const { q, type = 'mp3' } = req.query;
  if (!q) return res.status(400).json({ status: false, message: 'q is required' });
  try {
    let videoId;
    let searchTitle;

    const urlMatch = q.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (urlMatch) {
      videoId = urlMatch[1];
    } else {
      const r = await yts(q);
      if (!r.videos.length) return res.status(404).json({ status: false, message: 'No results found' });
      videoId = r.videos[0].videoId;
    }

    const info = await getVideoInfo(videoId);
    const host = `${req.protocol}://${req.get('host')}`;
    const format = type === 'mp4' ? 'video' : 'audio';

    return res.json({
      status: true,
      creator: 'DrexMusic',
      result: {
        id: info.videoId,
        title: info.title,
        author: info.author,
        duration: info.lengthSeconds,
        thumbnail: getBestThumb(info.videoThumbnails),
        format: type,
        stream_url: `${host}/api/stream?url=${encodeURIComponent(`https://youtube.com/watch?v=${videoId}`)}&format=${format}`,
        download_url: `${host}/api/download?url=${encodeURIComponent(`https://youtube.com/watch?v=${videoId}`)}&format=${format}`,
      }
    });
  } catch (err) { return res.status(500).json({ status: false, message: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
