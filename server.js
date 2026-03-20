const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Parse cookies from environment variable (Netscape format or JSON)
function buildAgent() {
  const raw = process.env.YT_COOKIES;
  if (!raw) {
    console.warn('[ytdl] No YT_COOKIES set — may get bot-detection errors');
    return ytdl.createAgent();
  }

  try {
    // Try JSON array format: [{ name, value, domain, ... }]
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      console.log(`[ytdl] Loaded ${parsed.length} cookies from JSON`);
      return ytdl.createAgent(parsed);
    }
  } catch {}

  // Try Netscape cookies.txt format
  try {
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
    if (cookies.length > 0) {
      console.log(`[ytdl] Loaded ${cookies.length} cookies from Netscape format`);
      return ytdl.createAgent(cookies);
    }
  } catch {}

  console.warn('[ytdl] Could not parse YT_COOKIES');
  return ytdl.createAgent();
}

const agent = buildAgent();
const YTDL_OPTS = { agent };

function isYouTubeUrl(url) {
  return url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com');
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// GET /api/health
app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    engine: '@distube/ytdl-core',
    node: process.version,
    cookies: !!process.env.YT_COOKIES,
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
    const opts = format === 'audio'
      ? { filter: 'audioonly', quality: 'highestaudio', ...YTDL_OPTS }
      : { filter: 'videoandaudio', quality: 'highestvideo', ...YTDL_OPTS };
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
