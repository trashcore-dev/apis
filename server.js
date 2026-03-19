const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const scdl = require('soundcloud-downloader').default;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TMP_DIR = os.tmpdir();
const SC_CLIENT_ID = process.env.SC_CLIENT_ID || '';

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) return 'youtube';
  if (url.includes('soundcloud.com')) return 'soundcloud';
  return 'unknown';
}

function formatDuration(sec) {
  if (!sec) return '0:00';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'ytdl-core + soundcloud-downloader' });
});

// GET /api/info?url=
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Only YouTube and SoundCloud URLs are supported' });

  try {
    if (platform === 'youtube') {
      const info = await ytdl.getInfo(url);
      const details = info.videoDetails;
      const formats = info.formats.map(f => ({
        format_id: f.itag,
        ext: f.container,
        quality: f.quality,
        filesize: f.contentLength,
        acodec: f.audioCodec,
        vcodec: f.videoCodec,
        format_note: f.qualityLabel || f.audioQuality || '',
        type: !f.videoCodec ? 'audio' : !f.audioCodec ? 'video-only' : 'video+audio',
        bitrate: f.bitrate,
      }));

      return res.json({
        platform,
        id: details.videoId,
        title: details.title,
        uploader: details.author?.name || null,
        duration: parseInt(details.lengthSeconds),
        thumbnail: details.thumbnails?.slice(-1)[0]?.url || null,
        webpage_url: url,
        view_count: parseInt(details.viewCount),
        formats,
      });
    }

    if (platform === 'soundcloud') {
      const info = await scdl.getInfo(url, SC_CLIENT_ID);
      return res.json({
        platform,
        id: info.id,
        title: info.title,
        uploader: info.user?.username || null,
        duration: Math.floor((info.duration || 0) / 1000),
        thumbnail: info.artwork_url || null,
        webpage_url: info.permalink_url || url,
        view_count: info.playback_count,
        formats: [],
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/search?q=&platform=&limit=
app.get('/api/search', async (req, res) => {
  const { q, platform = 'youtube', limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    if (platform === 'youtube') {
      const r = await yts(q);
      const results = r.videos.slice(0, parseInt(limit)).map(v => ({
        id: v.videoId,
        title: v.title,
        uploader: v.author?.name || null,
        duration: v.duration?.seconds || null,
        thumbnail: v.thumbnail,
        url: v.url,
        platform: 'youtube',
      }));
      return res.json({ results });
    }

    if (platform === 'soundcloud') {
      const r = await scdl.search({ query: q, limit: parseInt(limit), resourceType: 'tracks' }, SC_CLIENT_ID);
      const results = (r.collection || []).map(t => ({
        id: t.id,
        title: t.title,
        uploader: t.user?.username || null,
        duration: Math.floor((t.duration || 0) / 1000),
        thumbnail: t.artwork_url || null,
        url: t.permalink_url,
        platform: 'soundcloud',
      }));
      return res.json({ results });
    }

    return res.status(400).json({ error: 'platform must be youtube or soundcloud' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/download?url=&format=audio|video
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported platform' });

  try {
    if (platform === 'youtube') {
      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
      const ext = format === 'audio' ? 'mp3' : 'mp4';

      res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
      res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

      const options = format === 'audio'
        ? { filter: 'audioonly', quality: 'highestaudio' }
        : { filter: 'videoandaudio', quality: 'highestvideo' };

      ytdl(url, options).pipe(res);
      return;
    }

    if (platform === 'soundcloud') {
      const info = await scdl.getInfo(url, SC_CLIENT_ID);
      const title = (info.title || 'track').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);

      res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);
      res.setHeader('Content-Type', 'audio/mpeg');

      const stream = await scdl.download(url, SC_CLIENT_ID);
      stream.pipe(res);
      return;
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stream-url?url=&format=audio|video
app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported platform' });

  try {
    if (platform === 'youtube') {
      const info = await ytdl.getInfo(url);
      const formats = info.formats;
      const chosen = format === 'audio'
        ? ytdl.chooseFormat(formats, { filter: 'audioonly', quality: 'highestaudio' })
        : ytdl.chooseFormat(formats, { filter: 'videoandaudio', quality: 'highestvideo' });
      return res.json({ stream_url: chosen.url, title: info.videoDetails.title });
    }

    if (platform === 'soundcloud') {
      // SoundCloud stream URL via download endpoint (redirect)
      return res.json({ stream_url: `/api/download?url=${encodeURIComponent(url)}&format=audio` });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
