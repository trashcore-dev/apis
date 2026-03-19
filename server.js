const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function isYouTubeUrl(url) {
  return url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com');
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

const YTDL_OPTS = {
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  }
};

// GET /api/health
app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', engine: 'ytdl-core' });
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

// GET /api/info?url=
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs supported' });
  try {
    const info = await ytdl.getInfo(url, YTDL_OPTS);
    const d = info.videoDetails;
    return res.json({
      id: d.videoId, title: d.title,
      uploader: d.author?.name || null,
      duration: parseInt(d.lengthSeconds),
      thumbnail: d.thumbnails?.slice(-1)[0]?.url || null,
      webpage_url: url,
      view_count: parseInt(d.viewCount),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/stream-url?url=&format=audio|video
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs supported' });
  try {
    const info = await ytdl.getInfo(url, YTDL_OPTS);
    const format_obj = format === 'audio'
      ? ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' })
      : ytdl.chooseFormat(info.formats, { filter: 'videoandaudio', quality: 'highestvideo' });
    return res.json({
      stream_url: format_obj.url,
      mime_type: format_obj.mimeType,
      bitrate: format_obj.audioBitrate,
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
    const mime = format === 'audio' ? 'audio/mp4' : 'video/mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
    res.setHeader('Content-Type', mime);
    const options = format === 'audio'
      ? { filter: 'audioonly', quality: 'highestaudio', ...YTDL_OPTS }
      : { filter: 'videoandaudio', quality: 'highestvideo', ...YTDL_OPTS };
    ytdl(url, options).pipe(res);
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
      thumbnail: v.thumbnail, url: v.url,
      stream_url: `${host}/api/stream-url?url=${encodeURIComponent(v.url)}&format=audio`,
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
      thumbnail: v.thumbnail, url: v.url,
      stream_url: `${host}/api/stream-url?url=${encodeURIComponent(v.url)}&format=video`,
      download_url: `${host}/api/download?url=${encodeURIComponent(v.url)}&format=video`,
    }));
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
