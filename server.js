const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TMP_DIR = os.tmpdir();

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) return 'youtube';
  if (url.includes('soundcloud.com')) return 'soundcloud';
  return 'unknown';
}

// Fetch SoundCloud client_id dynamically
let SC_CLIENT_ID = process.env.SC_CLIENT_ID || null;
async function getSCClientId() {
  if (SC_CLIENT_ID) return SC_CLIENT_ID;
  const res = await fetch('https://soundcloud.com');
  const html = await res.text();
  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
  for (const src of scripts.slice(-3)) {
    try {
      const js = await fetch(src).then(r => r.text());
      const match = js.match(/client_id:"([a-zA-Z0-9]+)"/);
      if (match) { SC_CLIENT_ID = match[1]; return SC_CLIENT_ID; }
    } catch {}
  }
  throw new Error('Could not fetch SoundCloud client_id');
}

async function scRequest(endpoint) {
  const clientId = await getSCClientId();
  const res = await fetch(`https://api-v2.soundcloud.com${endpoint}&client_id=${clientId}`);
  if (!res.ok) throw new Error(`SoundCloud API error: ${res.status}`);
  return res.json();
}

async function scResolve(url) {
  const clientId = await getSCClientId();
  const res = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`);
  if (!res.ok) throw new Error(`SoundCloud resolve error: ${res.status}`);
  return res.json();
}

async function scStreamUrl(track) {
  const clientId = await getSCClientId();
  const transcodings = track?.media?.transcodings || [];
  const mp3 = transcodings.find(t => t.format?.mime_type === 'audio/mpeg' && t.format?.protocol === 'progressive')
    || transcodings.find(t => t.format?.protocol === 'progressive')
    || transcodings[0];
  if (!mp3) throw new Error('No stream found for this track');
  const res = await fetch(`${mp3.url}?client_id=${clientId}`);
  const data = await res.json();
  return data.url;
}

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: '@distube/ytdl-core + SoundCloud API' });
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
      const d = info.videoDetails;
      return res.json({
        platform, id: d.videoId, title: d.title,
        uploader: d.author?.name || null,
        duration: parseInt(d.lengthSeconds),
        thumbnail: d.thumbnails?.slice(-1)[0]?.url || null,
        webpage_url: url,
        view_count: parseInt(d.viewCount),
      });
    }
    if (platform === 'soundcloud') {
      const track = await scResolve(url);
      return res.json({
        platform, id: track.id, title: track.title,
        uploader: track.user?.username || null,
        duration: Math.floor((track.duration || 0) / 1000),
        thumbnail: track.artwork_url?.replace('large', 't500x500') || null,
        webpage_url: track.permalink_url || url,
        view_count: track.playback_count,
      });
    }
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/search?q=&platform=&limit=
app.get('/api/search', async (req, res) => {
  const { q, platform = 'youtube', limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    if (platform === 'youtube') {
      const r = await yts(q);
      const results = r.videos.slice(0, parseInt(limit)).map(v => ({
        id: v.videoId, title: v.title,
        uploader: v.author?.name || null,
        duration: v.duration?.seconds || null,
        thumbnail: v.thumbnail, url: v.url, platform: 'youtube',
      }));
      return res.json({ results });
    }
    if (platform === 'soundcloud') {
      const clientId = await getSCClientId();
      const data = await scRequest(`/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}`);
      const results = (data.collection || []).map(t => ({
        id: t.id, title: t.title,
        uploader: t.user?.username || null,
        duration: Math.floor((t.duration || 0) / 1000),
        thumbnail: t.artwork_url?.replace('large', 't500x500') || null,
        url: t.permalink_url, platform: 'soundcloud',
      }));
      return res.json({ results });
    }
    return res.status(400).json({ error: 'platform must be youtube or soundcloud' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
      const track = await scResolve(url);
      const streamUrl = await scStreamUrl(track);
      const title = (track.title || 'track').replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
      res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);
      res.setHeader('Content-Type', 'audio/mpeg');
      const stream = await fetch(streamUrl);
      const { Readable } = require('stream');
      Readable.fromWeb(stream.body).pipe(res);
      return;
    }
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
      const chosen = format === 'audio'
        ? ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' })
        : ytdl.chooseFormat(info.formats, { filter: 'videoandaudio', quality: 'highestvideo' });
      return res.json({ stream_url: chosen.url, title: info.videoDetails.title });
    }
    if (platform === 'soundcloud') {
      const track = await scResolve(url);
      const streamUrl = await scStreamUrl(track);
      return res.json({ stream_url: streamUrl, title: track.title });
    }
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
