const express = require('express');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TMP_DIR = os.tmpdir();

// Auto-detect yt-dlp binary path
function getYtDlpPath() {
  const candidates = [
    'yt-dlp',
    '/usr/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/root/.local/bin/yt-dlp',
    `${os.homedir()}/.local/bin/yt-dlp`,
    '/nix/var/nix/profiles/default/bin/yt-dlp',
  ];
  for (const p of candidates) {
    try {
      execSync(`${p} --version`, { stdio: 'ignore' });
      console.log(`[yt-dlp] using: ${p}`);
      return p;
    } catch {}
  }
  try {
    const found = execSync('which yt-dlp').toString().trim();
    if (found) { console.log(`[yt-dlp] found via which: ${found}`); return found; }
  } catch {}
  console.warn('[yt-dlp] not found!');
  return 'yt-dlp';
}

const YTDLP = getYtDlpPath();

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    exec(`${YTDLP} ${args}`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) return 'youtube';
  if (url.includes('soundcloud.com')) return 'soundcloud';
  return 'unknown';
}

app.get('/api/health', (req, res) => {
  try {
    const version = execSync(`${YTDLP} --version`).toString().trim();
    res.json({ status: 'ok', ytdlp: version, ytdlp_path: YTDLP });
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'yt-dlp not found', ytdlp_path: YTDLP });
  }
});

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Only YouTube and SoundCloud URLs are supported' });
  try {
    const raw = await runYtDlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(raw);
    const formats = (info.formats || [])
      .filter(f => f.ext && (f.acodec !== 'none' || f.vcodec !== 'none'))
      .map(f => ({
        format_id: f.format_id, ext: f.ext, quality: f.quality,
        filesize: f.filesize, acodec: f.acodec, vcodec: f.vcodec,
        format_note: f.format_note || '',
        type: f.vcodec === 'none' ? 'audio' : f.acodec === 'none' ? 'video-only' : 'video+audio',
      }));
    return res.json({ platform, id: info.id, title: info.title, uploader: info.uploader || info.artist || null, duration: info.duration, thumbnail: info.thumbnail, webpage_url: info.webpage_url || url, view_count: info.view_count, upload_date: info.upload_date, formats });
  } catch (err) { return res.status(500).json({ error: err.toString() }); }
});

app.get('/api/search', async (req, res) => {
  const { q, platform = 'youtube', limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'q (query) is required' });
  const source = platform === 'soundcloud' ? 'scsearch' : 'ytsearch';
  try {
    const raw = await runYtDlp(`--dump-json --flat-playlist "${source}${limit}:${q}"`);
    const lines = raw.split('\n').filter(Boolean);
    const results = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean).map(item => ({ id: item.id, title: item.title, uploader: item.uploader || item.channel || null, duration: item.duration, thumbnail: item.thumbnail, url: item.url || item.webpage_url, platform }));
    return res.json({ results });
  } catch (err) { return res.status(500).json({ error: err.toString() }); }
});

app.get('/api/download', async (req, res) => {
  const { url, format = 'audio', quality = 'best' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported platform' });
  const tmpFile = path.join(TMP_DIR, `drexmusic_${Date.now()}`);
  let formatArg = format === 'audio' ? `-x --audio-format mp3 --audio-quality 0`
    : format === 'video' ? (quality === 'best' ? `-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"` : `-f "worstvideo+worstaudio/worst"`)
    : `-f best`;
  try {
    const raw = await runYtDlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(raw);
    const safeName = info.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().substring(0, 80);
    const ext = format === 'audio' ? 'mp3' : 'mp4';
    const outFile = `${tmpFile}.${ext}`;
    await runYtDlp(`${formatArg} -o "${outFile}" --no-playlist "${url}"`);
    if (!fs.existsSync(outFile)) throw new Error('Download failed, file not found');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');
    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('end', () => { fs.unlink(outFile, () => {}); });
    stream.on('error', () => { fs.unlink(outFile, () => {}); res.status(500).end(); });
  } catch (err) { return res.status(500).json({ error: err.toString() }); }
});

app.get('/api/stream-url', async (req, res) => {
  const { url, format = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported platform' });
  const formatArg = format === 'audio' ? `-f bestaudio` : `-f "bestvideo+bestaudio/best"`;
  try {
    const streamUrl = await runYtDlp(`${formatArg} --get-url --no-playlist "${url}"`);
    return res.json({ stream_url: streamUrl.split('\n')[0] });
  } catch (err) { return res.status(500).json({ error: err.toString() }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DrexMusic API running on port ${PORT}`));
