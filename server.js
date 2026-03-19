const express = require('express');
const cors = require('cors');
const os = require('os');
const path = require('path');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) return 'youtube';
  return 'unknown';
}

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: '@distube/ytdl-core', platform: 'YouTube only' });
});

// GET /api/info?url=
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (detectPlatform(url) === 'unknown') return res.status(400).json({ error: 'Only YouTube URLs are supported' });

  try {
    const info = await ytdl.getInfo(url);
    const d = info.videoDetails;
    return res.json({
      id: d.videoId,
      title: d.title,
      uploader: d.author?.name || null,
      duration: parseInt(d.lengthSeconds),
      thumbnail: d.thumbnails?.slice(-1)[0]?.url || null,
      webpage_url: url,
      view_count: parseInt(d.viewCount),
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
      id: v.videoId,
      title: v.title,
      uploader: v.author?.name || null,
      duration: v.duration?.seconds || null,
      thumbnail: v.thumbnail,
      url: v.url,
    }));
    return res.json({ results });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/download?url=&format=audio|video
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (detectPlatform(url) === 'unknown') return res.status(400).json({ error: 'Only YouTube URLs are supported' });

  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
    const ext = format === 'audio' ? 'mp3' : 'mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

    const options = format === 'audio'
      ? { filter: 'audioonly', quality: 'highestaudio' }
      : { filter: 'videoandaudio', quality: 'highestvideo' };

    ytdl(url, options).pipe(res);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/stream-url?url=&format=audio|video
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (detectPlatform(url) === 'unknown') return res.status(400).json({ error: 'Only YouTube URLs are supported' });

  try {
    const info = await ytdl.getInfo(url);
    const chosen = format === 'audio'
      ? ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' })
      : ytdl.chooseFormat(info.formats, { filter: 'videoandaudio', quality: 'highestvideo' });
    return res.json({ stream_url: chosen.url, title: info.videoDetails.title });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
