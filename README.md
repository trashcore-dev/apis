# ⚽ Football API — Self-Hosted

Your own football API server that powers KickStat. Uses **API-Football** free tier (100 req/day, no credit card).

---

## 🚀 Setup in 5 Minutes

### 1. Get your FREE API key
1. Go to → https://dashboard.api-football.com/register
2. Sign up (free, no credit card)
3. Copy your API key from the dashboard

### 2. Install & configure
```bash
# Install dependencies
npm install

# Create your .env file
cp .env.example .env

# Open .env and paste your API key
nano .env   # or use any text editor
```

Your `.env` should look like:
```
API_FOOTBALL_KEY=abc123yourrealkeyhere
PORT=3000
ALLOWED_ORIGIN=*
```

### 3. Run locally
```bash
npm start
# or for auto-restart on changes:
npm run dev
```

Visit http://localhost:3000 to confirm it's running.

---

## ☁️ Deploy to Railway (Free, Recommended)

Railway gives you a free hosted URL so your KickStat site can call it from anywhere.

1. Push this folder to a GitHub repo
2. Go to → https://railway.app
3. Click **New Project → Deploy from GitHub**
4. Select your repo
5. Go to **Variables** tab → add `API_FOOTBALL_KEY = your_key`
6. Railway auto-deploys and gives you a URL like `https://football-api-xxx.railway.app`

### Update KickStat HTML
Change the `BASE` variable at the top of the script:
```js
const BASE = 'https://your-railway-url.railway.app';
const USE_DIRECT = true;  // No proxy needed — your API has CORS enabled!
```

---

## 🌐 Other Free Deploy Options

| Platform | Free Tier | Notes |
|----------|-----------|-------|
| **Railway** | $5 credit/mo | Easiest, always-on |
| **Render** | 750 hrs/mo | Sleeps after 15min idle |
| **Cyclic** | Unlimited | Node.js only |
| **Glitch** | Always free | Slower cold start |

---

## 📡 API Endpoints

| Endpoint | Description | Cache |
|----------|-------------|-------|
| `GET /` | Health check + endpoint list | — |
| `GET /livescore` | Live matches (falls back to today's fixtures) | 60s |
| `GET /epl/standings` | League table | 1hr |
| `GET /epl/scorers` | Top goalscorers | 1hr |
| `GET /epl/upcomingmatches` | Next 15 fixtures | 30min |
| `GET /bet` | Match predictions for today | 30min |
| `GET /football/news` | BBC Sport football news | 15min |
| `GET /sport/playersearch?q=Salah` | Player search | 1hr |
| `GET /sport/teamsearch?q=Arsenal` | Team search | 1hr |
| `GET /sport/venuesearch?q=Wembley` | Venue search | 24hr |
| `GET /sport/gameevents?q=Arsenal` | Team match history | 30min |

### Supported League Slugs
`epl` · `laliga` · `ucl` · `bundesliga` · `seriea` · `euros` · `fifa`

---

## 💡 Free Tier Tips (100 req/day)

- **Caching** is built-in — repeated requests use cache, not your quota
- Live scores refresh every 60s but only make 1 API call per minute
- Standings/Scorers cached for 1 hour
- News comes from BBC RSS (no API quota used)
- If you run out of requests, the API returns cached data until midnight reset

---

## 🔒 Security

- Your API key stays on the server — never exposed to browser
- CORS is configured to allow your frontend domain
- For production, change `ALLOWED_ORIGIN=https://yourdomain.com` in `.env`
