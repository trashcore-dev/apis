const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Parse cookies from environment variable
function parseCookies() {
  const raw = process.env.YT_COOKIES;
  if (!raw) return [];

  // Try JSON array
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // Netscape format
  const cookies = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.trim().split('\t');
    if (parts.length >= 7) {
      cookies.push({
        domain: parts[0],
        httpOnly: parts[1] === 'TRUE',
        path: parts[2],
        secure: parts[3] === 'TRUE',
        expires: parseInt(parts[4]) || undefined,
        name: parts[5],
        value: parts[6],
      });
    }
  }
  return cookies;
}

const cookies = parseCookies();
const agent = ytdl.createAgent(cookies);

// Build cookie header string for fetch() calls
function cookieHeader() {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

const YTDL_OPTS = { agent };

function isYouTubeUrl(url) {
  return url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com');
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: '@distube/ytdl-core',
    node: process.version,
    cookies: cookies.length > 0,
    cookie_count: cookies.length,
  });
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

// GET /api/stream-url?url=&format=audio|video
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs supported' });
  try {
    const info = await ytdl.getInfo(url, YTDL_OPTS);
    const fmt = format === 'audio'
      ? ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' })
      : ytdl.chooseFormat(info.formats, { filter: 'videoandaudio', quality: 'highestvideo' });
    return res.json({
      stream_url: fmt.url,
      mime_type: fmt.mimeType,
      bitrate: fmt.audioBitrate,
      title: info.videoDetails.title,
      uploader: info.videoDetails.author?.name || null,
      duration: parseInt(info.videoDetails.lengthSeconds),
      thumbnail: info.videoDetails.thumbnails?.slice(-1)[0]?.url || null,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/download?url=&format=audio|video
// Pipes audio/video directly to client with cookies on the upstream request
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs supported' });
  try {
    const info = await ytdl.getInfo(url, YTDL_OPTS);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
    const ext = format === 'audio' ? 'm4a' : 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mp4' : 'video/mp4');

    const opts = {
      ...(format === 'audio'
        ? { filter: 'audioonly', quality: 'highestaudio' }
        : { filter: 'videoandaudio', quality: 'highestvideo' }),
      ...YTDL_OPTS,
    };
    ytdl(url, opts).pipe(res);
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
      stream_url: `${host}/api/stream-url?url=${encodeURIComponent(v.url)}&format=audio`,
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
      stream_url: `${host}/api/stream-url?url=${encodeURIComponent(v.url)}&format=video`,
      download_url: `${host}/api/download?url=${encodeURIComponent(v.url)}&format=video`,
    })));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
