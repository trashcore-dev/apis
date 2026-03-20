const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const playdl = require('play-dl');

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

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'play-dl', node: process.version });
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

// GET /api/info?url=
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const info = await playdl.video_info(url);
    const d = info.video_details;
    return res.json({
      id: d.id, title: d.title,
      uploader: d.channel?.name || null,
      duration: d.durationInSec,
      thumbnail: d.thumbnails?.slice(-1)[0]?.url || null,
      webpage_url: d.url,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/stream-url?url=&format=audio
// Returns direct stream URL for preview/download
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const info = await playdl.video_info(url);
    const d = info.video_details;
    const stream = await playdl.stream_from_info(info, { quality: 2 });
    return res.json({
      stream_url: `${req.protocol}://${req.get('host')}/api/stream?url=${encodeURIComponent(url)}&format=${format}`,
      title: d.title,
      uploader: d.channel?.name || null,
      duration: d.durationInSec,
      thumbnail: d.thumbnails?.slice(-1)[0]?.url || null,
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/stream?url=&format=audio|video
// Actual streaming endpoint — pipes audio/video to client
app.get('/api/stream', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const info = await playdl.video_info(url);
    const d = info.video_details;
    const safeName = (d.title || 'audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);

    const stream = await playdl.stream_from_info(info, { quality: 2 });

    res.setHeader('Content-Type', stream.type === 'video/webm' ? 'video/webm' : 'audio/webm');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.webm"`);

    stream.stream.pipe(res);

    req.on('close', () => { try { stream.stream.destroy(); } catch {} });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/download?url=&format=audio|video
// Downloads file with attachment header
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const info = await playdl.video_info(url);
    const d = info.video_details;
    const safeName = (d.title || 'audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);

    const stream = await playdl.stream_from_info(info, { quality: 2 });

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.webm"`);
    res.setHeader('Content-Type', 'audio/webm');

    stream.stream.pipe(res);

    req.on('close', () => { try { stream.stream.destroy(); } catch {} });
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

// GET /download/youtube?q=&type=mp3|mp4
app.get('/download/youtube', async (req, res) => {
  const { q, type = 'mp3' } = req.query;
  if (!q) return res.status(400).json({ status: false, message: 'q is required' });
  try {
    let videoUrl = q;
    let title = q;

    if (!isYouTubeUrl(q)) {
      const r = await yts(q);
      if (!r.videos.length) return res.status(404).json({ status: false, message: 'No results found' });
      videoUrl = r.videos[0].url;
    }

    const info = await playdl.video_info(videoUrl);
    const d = info.video_details;
    const host = `${req.protocol}://${req.get('host')}`;

    return res.json({
      status: true,
      creator: 'DrexMusic',
      result: {
        id: d.id,
        title: d.title,
        author: d.channel?.name || null,
        duration: d.durationInSec,
        thumbnail: d.thumbnails?.slice(-1)[0]?.url || null,
        format: type,
        stream_url: `${host}/api/stream?url=${encodeURIComponent(videoUrl)}`,
        download_url: `${host}/api/download?url=${encodeURIComponent(videoUrl)}&format=${type === 'mp3' ? 'audio' : 'video'}`,
      }
    });
  } catch (err) { return res.status(500).json({ status: false, message: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
