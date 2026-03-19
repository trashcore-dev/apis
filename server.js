const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const youtubedl = require('youtube-dl-exec');

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

// GET /api/health
app.get('/api/health', async (req, res) => {
  try {
    const info = await youtubedl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      simulate: true,
    });
    res.json({ status: 'ok', title: info.title });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// GET /api/info?url=
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Only YouTube and SoundCloud URLs are supported' });

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
    });

    const formats = (info.formats || [])
      .filter(f => f.ext && (f.acodec !== 'none' || f.vcodec !== 'none'))
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        quality: f.quality,
        filesize: f.filesize,
        acodec: f.acodec,
        vcodec: f.vcodec,
        format_note: f.format_note || '',
        type: f.vcodec === 'none' ? 'audio' : f.acodec === 'none' ? 'video-only' : 'video+audio',
      }));

    return res.json({
      platform,
      id: info.id,
      title: info.title,
      uploader: info.uploader || info.artist || null,
      duration: info.duration,
      thumbnail: info.thumbnail,
      webpage_url: info.webpage_url || url,
      view_count: info.view_count,
      upload_date: info.upload_date,
      formats,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/search?q=&platform=&limit=
app.get('/api/search', async (req, res) => {
  const { q, platform = 'youtube', limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q (query) is required' });

  const source = platform === 'soundcloud' ? 'scsearch' : 'ytsearch';
  const searchUrl = `${source}${limit}:${q}`;

  try {
    const result = await youtubedl(searchUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      flatPlaylist: true,
    });

    const entries = result.entries || [result];
    const results = entries.map(item => ({
      id: item.id,
      title: item.title,
      uploader: item.uploader || item.channel || null,
      duration: item.duration,
      thumbnail: item.thumbnail,
      url: item.url || item.webpage_url || `https://www.youtube.com/watch?v=${item.id}`,
      platform,
    }));

    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/download?url=&format=audio|video&quality=best
app.get('/api/download', async (req, res) => {
  const { url, format = 'audio', quality = 'best' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported platform' });

  const tmpFile = path.join(TMP_DIR, `drexmusic_${Date.now()}`);
  const ext = format === 'audio' ? 'mp3' : 'mp4';
  const outFile = `${tmpFile}.${ext}`;

  try {
    // Get title first
    const info = await youtubedl(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true });
    const safeName = info.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);

    const dlOptions = format === 'audio'
      ? { extractAudio: true, audioFormat: 'mp3', audioQuality: 0, output: outFile, noPlaylist: true }
      : { format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', output: outFile, noPlaylist: true };

    await youtubedl(url, dlOptions);

    if (!fs.existsSync(outFile)) throw new Error('Download failed, file not found');

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('end', () => { fs.unlink(outFile, () => {}); });
    stream.on('error', () => { fs.unlink(outFile, () => {}); res.status(500).end(); });
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
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      format: format === 'audio' ? 'bestaudio' : 'bestvideo+bestaudio/best',
    });

    const streamUrl = format === 'audio'
      ? (info.formats || []).filter(f => f.vcodec === 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]?.url || info.url
      : info.url;

    return res.json({ stream_url: streamUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
