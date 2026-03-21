require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const NodeCache = require('node-cache');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.API_FOOTBALL_KEY;

if (!KEY || KEY === 'your_api_key_here') {
  console.error('❌  API_FOOTBALL_KEY missing in .env file');
  console.error('   Get a free key at: https://dashboard.api-football.com/register');
  process.exit(1);
}

// ── Cache (saves API quota) ─────────────────────────────
// Live scores: 60s  |  Standings/Scorers: 1 hour  |  Fixtures: 30 min
const cache = new NodeCache({ useClones: false });

// ── CORS ────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ── API-Football base client ────────────────────────────
const apif = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: {
    'x-rapidapi-key': KEY,
    'x-rapidapi-host': 'v3.football.api-sports.io',
  },
  timeout: 10000,
});

// ── League ID map (matching your KickStat slugs) ────────
const LEAGUE_IDS = {
  epl:        { id: 39,  season: 2024 },  // Premier League
  laliga:     { id: 140, season: 2024 },  // La Liga
  ucl:        { id: 2,   season: 2024 },  // UEFA Champions League
  bundesliga: { id: 78,  season: 2024 },  // Bundesliga
  seriea:     { id: 135, season: 2024 },  // Serie A
  euros:      { id: 4,   season: 2024 },  // Euro Championship
  fifa:       { id: 1,   season: 2026 },  // FIFA World Cup (next)
};

// ── Helper: cached API fetch ────────────────────────────
async function apiFetch(cacheKey, endpoint, params, ttl = 3600) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { data } = await apif.get(endpoint, { params });
  cache.set(cacheKey, data, ttl);
  return data;
}

// ── Helper: standard response wrapper ──────────────────
const ok  = (res, result) => res.json({ status: true,  result });
const err = (res, msg, code = 500) => res.status(code).json({ status: false, error: msg });

// ══════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: true,
    message: '⚽ Football API is running',
    endpoints: [
      'GET /livescore',
      'GET /:league/standings',
      'GET /:league/scorers',
      'GET /:league/upcomingmatches',
      'GET /football/news',
      'GET /bet',
      'GET /sport/playersearch?q=',
      'GET /sport/teamsearch?q=',
      'GET /sport/venuesearch?q=',
      'GET /sport/gameevents?q=',
    ],
  });
});

// ── 1. LIVE SCORES ──────────────────────────────────────
app.get('/livescore', async (req, res) => {
  try {
    const data = await apiFetch('livescore', '/fixtures', {
      live: 'all',
    }, 60); // 60 second cache for live data

    const games = {};
    (data.response || []).forEach((f, i) => {
      games[i] = {
        p1: f.teams.home.name,
        p2: f.teams.away.name,
        league: f.league.name,
        R: {
          r1: f.goals.home ?? 0,
          r2: f.goals.away ?? 0,
          st: f.fixture.status.short, // 'LIVE', 'HT', 'FT', '45+', etc.
        },
      };
    });

    // If no live games, get today's fixtures instead
    if (Object.keys(games).length === 0) {
      const today = new Date().toISOString().split('T')[0];
      const todayData = await apiFetch(`fixtures_today_${today}`, '/fixtures', {
        date: today,
        timezone: 'Africa/Nairobi',
      }, 300);

      (todayData.response || []).slice(0, 20).forEach((f, i) => {
        const status = f.fixture.status.short;
        const time   = new Date(f.fixture.date).toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi'
        });
        games[i] = {
          p1: f.teams.home.name,
          p2: f.teams.away.name,
          league: f.league.name,
          R: {
            r1: f.goals.home ?? '-',
            r2: f.goals.away ?? '-',
            st: ['NS', 'TBD'].includes(status) ? time : status,
          },
        };
      });
    }

    ok(res, { games });
  } catch(e) {
    console.error('livescore error:', e.message);
    err(res, e.message);
  }
});

// ── 2. STANDINGS ─────────────────────────────────────────
app.get('/:league/standings', async (req, res) => {
  const slug = req.params.league.toLowerCase();
  const lg   = LEAGUE_IDS[slug];
  if (!lg) return err(res, `Unknown league: ${slug}`, 404);

  try {
    const data = await apiFetch(
      `standings_${slug}_${lg.season}`,
      '/standings',
      { league: lg.id, season: lg.season }
    );

    const raw = data.response?.[0]?.league;
    if (!raw) return err(res, 'No standings data');

    const table = raw.standings?.[0] || raw.standings || [];
    const standings = table.map(t => ({
      position:       t.rank,
      team:           t.team.name,
      played:         t.all.played,
      won:            t.all.win,
      draw:           t.all.draw,
      lost:           t.all.lose,
      goalsFor:       t.all.goals.for,
      goalsAgainst:   t.all.goals.against,
      goalDifference: t.goalsDiff,
      points:         t.points,
      form:           t.form || '',
    }));

    ok(res, { competition: raw.name, standings });
  } catch(e) {
    console.error('standings error:', e.message);
    err(res, e.message);
  }
});

// ── 3. TOP SCORERS ────────────────────────────────────────
app.get('/:league/scorers', async (req, res) => {
  const slug = req.params.league.toLowerCase();
  const lg   = LEAGUE_IDS[slug];
  if (!lg) return err(res, `Unknown league: ${slug}`, 404);

  try {
    const data = await apiFetch(
      `scorers_${slug}_${lg.season}`,
      '/players/topscorers',
      { league: lg.id, season: lg.season }
    );

    const topScorers = (data.response || []).map((p, i) => ({
      rank:    i + 1,
      player:  p.player.name,
      team:    p.statistics[0]?.team?.name || 'N/A',
      goals:   p.statistics[0]?.goals?.total || 0,
      assists: p.statistics[0]?.goals?.assists ?? 'N/A',
    }));

    ok(res, {
      competition: LEAGUE_IDS[slug] ? slug.toUpperCase() : slug,
      topScorers,
    });
  } catch(e) {
    console.error('scorers error:', e.message);
    err(res, e.message);
  }
});

// ── 4. UPCOMING FIXTURES ──────────────────────────────────
app.get('/:league/upcomingmatches', async (req, res) => {
  const slug = req.params.league.toLowerCase();
  const lg   = LEAGUE_IDS[slug];
  if (!lg) return err(res, `Unknown league: ${slug}`, 404);

  try {
    const data = await apiFetch(
      `upcoming_${slug}_${lg.season}`,
      '/fixtures',
      {
        league: lg.id,
        season: lg.season,
        next:   15,
        timezone: 'Africa/Nairobi',
      },
      1800 // 30 min cache
    );

    const upcomingMatches = (data.response || []).map(f => ({
      date:     f.fixture.date,
      homeTeam: f.teams.home.name,
      awayTeam: f.teams.away.name,
      venue:    f.fixture.venue?.name || 'TBD',
      status:   f.fixture.status.short,
    }));

    ok(res, {
      competition: data.response?.[0]?.league?.name || slug,
      upcomingMatches,
    });
  } catch(e) {
    console.error('upcoming error:', e.message);
    err(res, e.message);
  }
});

// ── 5. BET PREDICTIONS ───────────────────────────────────
app.get('/bet', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get fixtures for top leagues today
    const data = await apiFetch(`bet_${today}`, '/fixtures', {
      date: today,
      timezone: 'Africa/Nairobi',
    }, 1800);

    const fixtures = (data.response || []).slice(0, 15);

    // For each fixture, fetch prediction (uses quota — cached per fixture)
    const tips = await Promise.allSettled(
      fixtures.map(async f => {
        const fid = f.fixture.id;
        const pred = await apiFetch(`pred_${fid}`, '/predictions', { fixture: fid }, 7200);
        const p    = pred.response?.[0]?.predictions;
        const comp = pred.response?.[0]?.league;

        return {
          match:   `${f.teams.home.name} vs ${f.teams.away.name}`,
          league:  f.league.name,
          time:    f.fixture.date,
          predictions: {
            fulltime: p?.percent ? {
              home: parseInt(p.percent.home),
              draw: parseInt(p.percent.draw),
              away: parseInt(p.percent.away),
            } : null,
            over_2_5:        { yes: p?.goals?.over || 50 },
            bothTeamToScore: { yes: p?.goals?.under ? 100 - parseInt(p.goals.under) : 50 },
          },
        };
      })
    );

    const result = tips
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    ok(res, result);
  } catch(e) {
    console.error('bet error:', e.message);
    err(res, e.message);
  }
});

// ── 6. FOOTBALL NEWS (via NewsAPI or RSS) ────────────────
app.get('/football/news', async (req, res) => {
  try {
    // Using a free RSS-to-JSON service for BBC Sport football news
    const cached = cache.get('news');
    if (cached) return ok(res, cached);

    const { data } = await axios.get(
      'https://api.rss2json.com/v1/api.json?rss_url=' +
      encodeURIComponent('https://feeds.bbci.co.uk/sport/football/rss.xml') +
      '&count=15',
      { timeout: 8000 }
    );

    const items = (data.items || []).map(n => ({
      title:   n.title,
      summary: n.description?.replace(/<[^>]+>/g, '') || '',
      url:     n.link,
      date:    n.pubDate,
      image:   n.thumbnail || null,
    }));

    const result = { data: { items } };
    cache.set('news', result, 900); // 15 min cache
    ok(res, result);
  } catch(e) {
    console.error('news error:', e.message);
    err(res, e.message);
  }
});

// ── 7. PLAYER SEARCH ─────────────────────────────────────
app.get('/sport/playersearch', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing query parameter ?q=', 400);

  try {
    const data = await apiFetch(
      `player_search_${q.toLowerCase()}`,
      '/players',
      { search: q, season: 2024 },
      3600
    );

    const result = (data.response || []).slice(0, 8).map(p => ({
      name:        p.player.name,
      team:        p.statistics[0]?.team?.name || 'N/A',
      nationality: p.player.nationality || 'N/A',
      position:    p.statistics[0]?.games?.position || 'N/A',
      birthDate:   p.player.birth?.date || 'N/A',
      status:      'Active',
      photo:       p.player.photo || null,
    }));

    ok(res, result);
  } catch(e) {
    console.error('player search error:', e.message);
    err(res, e.message);
  }
});

// ── 8. TEAM SEARCH ───────────────────────────────────────
app.get('/sport/teamsearch', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing query parameter ?q=', 400);

  try {
    const data = await apiFetch(
      `team_search_${q.toLowerCase()}`,
      '/teams',
      { search: q },
      3600
    );

    const result = (data.response || []).slice(0, 5).map(t => ({
      name:            t.team.name,
      shortName:       t.team.code || '',
      stadium:         t.venue.name || 'N/A',
      stadiumCapacity: t.venue.capacity || null,
      location:        t.venue.city || 'N/A',
      league:          'N/A',
      formedYear:      t.team.founded || 'N/A',
      logo:            t.team.logo || null,
    }));

    ok(res, result);
  } catch(e) {
    console.error('team search error:', e.message);
    err(res, e.message);
  }
});

// ── 9. VENUE SEARCH ──────────────────────────────────────
app.get('/sport/venuesearch', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing query parameter ?q=', 400);

  try {
    const data = await apiFetch(
      `venue_search_${q.toLowerCase()}`,
      '/venues',
      { search: q },
      86400 // 24hr cache — venues don't change
    );

    const result = (data.response || []).slice(0, 5).map(v => ({
      name:     v.name,
      location: v.city || 'N/A',
      country:  v.country || 'N/A',
      capacity: v.capacity || null,
      sport:    'Football',
      timezone: 'N/A',
    }));

    ok(res, result);
  } catch(e) {
    console.error('venue search error:', e.message);
    err(res, e.message);
  }
});

// ── 10. MATCH HISTORY SEARCH ─────────────────────────────
app.get('/sport/gameevents', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing query parameter ?q=', 400);

  try {
    // Search teams first, then get their recent fixtures
    const teamData = await apiFetch(
      `team_for_events_${q.toLowerCase()}`,
      '/teams',
      { search: q },
      3600
    );

    const team = teamData.response?.[0]?.team;
    if (!team) return ok(res, []);

    const fixData = await apiFetch(
      `team_fixtures_${team.id}`,
      '/fixtures',
      { team: team.id, last: 8, timezone: 'Africa/Nairobi' },
      1800
    );

    const result = (fixData.response || []).map(f => ({
      match:  `${f.teams.home.name} vs ${f.teams.away.name}`,
      league: { name: f.league.name },
      season: f.league.season,
      dateTime: {
        date: new Date(f.fixture.date).toLocaleDateString('en-GB'),
        time: new Date(f.fixture.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      },
      venue:  { name: f.fixture.venue?.name || 'N/A' },
      teams: {
        home: { name: f.teams.home.name, score: f.goals.home ?? '-' },
        away: { name: f.teams.away.name, score: f.goals.away ?? '-' },
      },
      status: f.fixture.status.long,
    }));

    ok(res, result);
  } catch(e) {
    console.error('game events error:', e.message);
    err(res, e.message);
  }
});

// ── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  err(res, `Route not found: ${req.path}`, 404);
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚽ Football API running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API Key: ${KEY.slice(0, 6)}${'*'.repeat(KEY.length - 6)}\n`);
});
