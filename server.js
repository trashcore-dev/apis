const express = require('express');
const cors = require('cors');
const { Innertube } = require('youtubei.js');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let yt = null;

// Init youtubei.js once
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
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL' });

  try {
    const youtube = await getYT();
    const info = await youtube.getInfo(videoId);
    const d = info.basic_info;

    return res.json({
      id: d.id,
      title: d.title,
      uploader: d.channel?.name || d.author || null,
      duration: d.duration,
      thumbnail: d.thumbnail?.[0]?.url || null,
      webpage_url: `https://www.youtube.com/watch?v=${d.id}`,
      view_count: d.view_count,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/download?url=&format=audio|video
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });

  try {
    const youtube = await getYT();
    const info = await youtube.getInfo(videoId);
    const title = (info.basic_info.title || 'audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);

    if (format === 'audio') {
      const stream = await youtube.download(videoId, {
        type: 'audio',
        quality: 'best',
        format: 'mp4', // aac audio in mp4 container — works without ffmpeg
      });

      res.setHeader('Content-Disposition', `attachment; filename="${title}.m4a"`);
      res.setHeader('Content-Type', 'audio/mp4');

      const { Readable } = require('stream');
      Readable.from(stream).pipe(res);
    } else {
      const stream = await youtube.download(videoId, {
        type: 'video+audio',
        quality: '360p',
        format: 'mp4',
      });

      res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');

      const { Readable } = require('stream');
      Readable.from(stream).pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stream-url?url=&format=audio|video
// Returns direct URL — good for TrashBot (send as audio message)
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });

  try {
    const youtube = await getYT();
    const info = await youtube.getInfo(videoId);

    const chosen = format === 'audio'
      ? info.chooseFormat({ type: 'audio', quality: 'best' })
      : info.chooseFormat({ type: 'video+audio', quality: '360p' });

    return res.json({
      stream_url: chosen.decipher(youtube.session.player),
      title: info.basic_info.title,
      duration: info.basic_info.duration,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`DrexMusic API running on port ${PORT}`);
  // Pre-warm the YouTube session
  getYT().then(() => console.log('YouTube session ready')).catch(console.error);
});

// GET /downloader/youtubemp3?q=&limit=
app.get('/downloader/youtubemp3', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    let results = [];
    if (isYouTubeUrl(q)) {
      // Single URL — return info
      const videoId = extractVideoId(q);
      const youtube = await getYT();
      const info = await youtube.getInfo(videoId);
      const d = info.basic_info;
      const ytUrl = `https://www.youtube.com/watch?v=${d.id}`;
      results = [{
        id: d.id, title: d.title,
        uploader: d.channel?.name || d.author || null,
        duration: d.duration,
        thumbnail: d.thumbnail?.[0]?.url || null,
        url: ytUrl,
        download_url: `${req.protocol}://${req.get('host')}/api/download?url=${encodeURIComponent(ytUrl)}&format=audio`,
      }];
    } else {
      const r = await yts(q);
      results = r.videos.slice(0, parseInt(limit)).map(v => {
        const ytUrl = v.url;
        return {
          id: v.videoId, title: v.title,
          uploader: v.author?.name || null,
          duration: v.duration?.seconds || null,
          thumbnail: v.thumbnail, url: ytUrl,
          download_url: `${req.protocol}://${req.get('host')}/api/download?url=${encodeURIComponent(ytUrl)}&format=audio`,
        };
      });
    }
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /downloader/youtubemp4?q=&limit=
app.get('/downloader/youtubemp4', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    let results = [];
    if (isYouTubeUrl(q)) {
      const videoId = extractVideoId(q);
      const youtube = await getYT();
      const info = await youtube.getInfo(videoId);
      const d = info.basic_info;
      const ytUrl = `https://www.youtube.com/watch?v=${d.id}`;
      results = [{
        id: d.id, title: d.title,
        uploader: d.channel?.name || d.author || null,
        duration: d.duration,
        thumbnail: d.thumbnail?.[0]?.url || null,
        url: ytUrl,
        download_url: `${req.protocol}://${req.get('host')}/api/download?url=${encodeURIComponent(ytUrl)}&format=video`,
      }];
    } else {
      const r = await yts(q);
      results = r.videos.slice(0, parseInt(limit)).map(v => {
        const ytUrl = v.url;
        return {
          id: v.videoId, title: v.title,
          uploader: v.author?.name || null,
          duration: v.duration?.seconds || null,
          thumbnail: v.thumbnail, url: ytUrl,
          download_url: `${req.protocol}://${req.get('host')}/api/download?url=${encodeURIComponent(ytUrl)}&format=video`,
        };
      });
    }
    return res.json(results);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});
