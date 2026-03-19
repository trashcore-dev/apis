# DrexMusic API 🎵

Music downloader API + site for YouTube & SoundCloud.  
Powers **TrashBot** (Baileys WhatsApp bot) — built by drextrash.online

---

## Features

- 🔍 **Search** — YouTube & SoundCloud by keyword
- 📄 **Info** — Get metadata (title, artist, thumbnail, duration, formats)
- ⬇️ **Download** — Stream MP3 or MP4 directly
- 🔗 **Stream URL** — Get raw CDN URL (useful for WhatsApp bot)
- 🌐 **Frontend** — Clean modern web UI included

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Install yt-dlp (required!)

```bash
# Linux / Railway / Render
pip install yt-dlp

# Or download binary
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

# Also install ffmpeg (required for MP3 conversion)
apt-get install -y ffmpeg   # Ubuntu/Debian
```

### 3. Start

```bash
# Development
npm run dev

# Production
npm start
```

---

## API Endpoints

### `GET /api/info?url=`
Get metadata for a YouTube or SoundCloud URL.

```
GET /api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### `GET /api/search?q=&platform=&limit=`
Search by keyword.

```
GET /api/search?q=never+gonna+give+you+up&platform=youtube&limit=5
GET /api/search?q=lofi+hip+hop&platform=soundcloud&limit=3
```

### `GET /api/download?url=&format=&quality=`
Download as MP3 or MP4. Streams the file directly.

```
GET /api/download?url=https://youtu.be/dQw4w9WgXcQ&format=audio
GET /api/download?url=https://youtu.be/dQw4w9WgXcQ&format=video&quality=best
```

### `GET /api/stream-url?url=&format=`
Get raw CDN stream URL (for TrashBot to pass directly to WhatsApp).

```
GET /api/stream-url?url=https://youtu.be/dQw4w9WgXcQ&format=audio
```

---

## TrashBot Plugin

```js
// plugins/music.js
const API_BASE = 'https://your-domain.com/api';

export default async (m, { sock, text }) => {
  if (!text) return m.reply('Usage: .play <song name or URL>');

  await m.reply('🔍 Searching...');

  const search = await fetch(`${API_BASE}/search?q=${encodeURIComponent(text)}&limit=1`);
  const { results } = await search.json();
  if (!results.length) return m.reply('❌ No results found.');

  const song = results[0];
  await m.reply(`🎵 Found: *${song.title}*\nDownloading...`);

  const dl = await fetch(`${API_BASE}/download?url=${encodeURIComponent(song.url)}&format=audio`);
  const buffer = Buffer.from(await dl.arrayBuffer());

  await sock.sendMessage(m.chat, {
    audio: buffer,
    mimetype: 'audio/mpeg',
    fileName: `${song.title}.mp3`,
    ptt: false,
  }, { quoted: m });
};
```

---

## Deploy

### Railway (recommended)
1. Push to GitHub
2. New Railway project → Deploy from GitHub
3. Add buildpack or Nixpacks with `yt-dlp` + `ffmpeg` installed
4. Set PORT env if needed

### Render / VPS
Same — just make sure `yt-dlp` and `ffmpeg` are installed on the system.

---

## .env (optional)
```
PORT=3000
```
