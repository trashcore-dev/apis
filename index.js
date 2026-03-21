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

// ── Dynamic season — auto-updates every year ─────────────
// Football season runs Aug–May
// Aug or later  → use current year  (e.g. Aug 2025 → season 2025)
// Before Aug    → use last year     (e.g. Mar 2026 → season 2025)
function currentSeason() {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}
const SEASON = currentSeason();
console.log(`📅 Current season: ${SEASON}/${SEASON + 1}`);

// ── Cache ────────────────────────────────────────────────
const cache = new NodeCache({ useClones: false });

// ── CORS ─────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ── API-Football client ───────────────────────────────────
const apif = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: {
    'x-rapidapi-key': KEY,
    'x-rapidapi-host': 'v3.football.api-sports.io',
  },
  timeout: 12000,
});

// ── League map ────────────────────────────────────────────
const LEAGUE_IDS = {
  epl:        { id: 39,  season: SEASON },
  laliga:     { id: 140, season: SEASON },
  ucl:        { id: 2,   season: SEASON },
  bundesliga: { id: 78,  season: SEASON },
  seriea:     { id: 135, season: SEASON },
  ligue1:     { id: 61,  season: SEASON },
  euros:      { id: 4,   season: 2024  },  // every 4 years
  fifa:       { id: 1,   season: 2026  },  // next World Cup
};

// ── Helpers ───────────────────────────────────────────────
async function apiFetch(cacheKey, endpoint, params, ttl = 3600) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const { data } = await apif.get(endpoint, { params });
  cache.set(cacheKey, data, ttl);
  return data;
}
const ok  = (res, result) => res.json({ status: true, result });
const err = (res, msg, code = 500) => res.status(code).json({ status: false, error: msg });

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: true,
    message: 'Football API is running',
    currentSeason: `${SEASON}/${SEASON + 1}`,
  });
});

// ── 1. LIVE SCORES ────────────────────────────────────────
app.get('/livescore', async (req, res) => {
  try {
    const data = await apiFetch('livescore', '/fixtures', { live: 'all' }, 60);
    const games = {};
    let idx = 0;

    (data.response || []).forEach(f => {
      games[idx++] = {
        p1: f.teams.home.name, p2: f.teams.away.name,
        league: f.league.name,
        R: { r1: f.goals.home ?? 0, r2: f.goals.away ?? 0, st: f.fixture.status.short },
      };
    });

    // No live → show today's fixtures
    if (idx === 0) {
      const today = new Date().toISOString().split('T')[0];
      const todayData = await apiFetch(
        `fixtures_today_${today}`, '/fixtures',
        { date: today, timezone: 'Africa/Nairobi' }, 300
      );
      (todayData.response || []).slice(0, 25).forEach(f => {
        const st = f.fixture.status.short;
        const time = new Date(f.fixture.date).toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi',
        });
        games[idx++] = {
          p1: f.teams.home.name, p2: f.teams.away.name,
          league: f.league.name,
          R: { r1: f.goals.home ?? '-', r2: f.goals.away ?? '-',
               st: ['NS','TBD'].includes(st) ? time : st },
        };
      });
    }

    ok(res, { games });
  } catch(e) { console.error('livescore:', e.message); err(res, e.message); }
});

// ── 2. STANDINGS ──────────────────────────────────────────
app.get('/:league/standings', async (req, res) => {
  const slug = req.params.league.toLowerCase();
  const lg = LEAGUE_IDS[slug];
  if (!lg) return err(res, `Unknown league: ${slug}`, 404);

  try {
    const data = await apiFetch(
      `standings_${slug}_${lg.season}`, '/standings',
      { league: lg.id, season: lg.season }, 3600
    );
    const raw = data.response?.[0]?.league;
    if (!raw) return err(res, 'No standings data');

    const table = raw.standings?.[0] || raw.standings || [];
    const standings = table.map(t => ({
      position: t.rank, team: t.team.name,
      played: t.all.played, won: t.all.win,
      draw: t.all.draw, lost: t.all.lose,
      goalsFor: t.all.goals.for, goalsAgainst: t.all.goals.against,
      goalDifference: t.goalsDiff, points: t.points, form: t.form || '',
    }));

    ok(res, { competition: `${raw.name} ${lg.season}/${lg.season + 1}`, standings });
  } catch(e) { console.error('standings:', e.message); err(res, e.message); }
});

// ── 3. TOP SCORERS ────────────────────────────────────────
app.get('/:league/scorers', async (req, res) => {
  const slug = req.params.league.toLowerCase();
  const lg = LEAGUE_IDS[slug];
  if (!lg) return err(res, `Unknown league: ${slug}`, 404);

  try {
    const data = await apiFetch(
      `scorers_${slug}_${lg.season}`, '/players/topscorers',
      { league: lg.id, season: lg.season }, 3600
    );
    const topScorers = (data.response || []).map((p, i) => ({
      rank: i + 1, player: p.player.name,
      team: p.statistics[0]?.team?.name || 'N/A',
      goals: p.statistics[0]?.goals?.total || 0,
      assists: p.statistics[0]?.goals?.assists ?? 'N/A',
      photo: p.player.photo || null,
    }));

    ok(res, {
      competition: `${slug.toUpperCase()} ${lg.season}/${lg.season + 1}`,
      topScorers,
    });
  } catch(e) { console.error('scorers:', e.message); err(res, e.message); }
});

// ── 4. UPCOMING FIXTURES ──────────────────────────────────
app.get('/:league/upcomingmatches', async (req, res) => {
  const slug = req.params.league.toLowerCase();
  const lg = LEAGUE_IDS[slug];
  if (!lg) return err(res, `Unknown league: ${slug}`, 404);

  try {
    const data = await apiFetch(
      `upcoming_${slug}_${lg.season}`, '/fixtures',
      { league: lg.id, season: lg.season, next: 15, timezone: 'Africa/Nairobi' },
      1800
    );
    const upcomingMatches = (data.response || []).map(f => ({
      date: f.fixture.date,
      homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
      venue: f.fixture.venue?.name || 'TBD',
      status: f.fixture.status.short,
    }));

    ok(res, {
      competition: `${data.response?.[0]?.league?.name || slug} ${lg.season}/${lg.season + 1}`,
      upcomingMatches,
    });
  } catch(e) { console.error('upcoming:', e.message); err(res, e.message); }
});

// ── 5. BET PREDICTIONS ────────────────────────────────────
app.get('/bet', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data  = await apiFetch(
      `bet_${today}`, '/fixtures',
      { date: today, timezone: 'Africa/Nairobi' }, 1800
    );

    const fixtures = (data.response || []).slice(0, 12);
    if (!fixtures.length) return ok(res, []);

    const tips = await Promise.allSettled(
      fixtures.map(async f => {
        const fid  = f.fixture.id;
        const pred = await apiFetch(`pred_${fid}`, '/predictions', { fixture: fid }, 7200);
        const p    = pred.response?.[0]?.predictions;
        return {
          match:  `${f.teams.home.name} vs ${f.teams.away.name}`,
          league: f.league.name,
          time:   f.fixture.date,
          predictions: {
            fulltime: p?.percent ? {
              home: parseInt(p.percent.home) || 0,
              draw: parseInt(p.percent.draw) || 0,
              away: parseInt(p.percent.away) || 0,
            } : null,
            over_2_5:        { yes: p?.goals?.over  || 50 },
            bothTeamToScore: { yes: p?.goals?.under ? 100 - parseInt(p.goals.under) : 50 },
          },
        };
      })
    );

    ok(res, tips.filter(r => r.status === 'fulfilled').map(r => r.value));
  } catch(e) { console.error('bet:', e.message); err(res, e.message); }
});

// ── 6. NEWS ───────────────────────────────────────────────
app.get('/football/news', async (req, res) => {
  try {
    const cached = cache.get('news');
    if (cached) return ok(res, cached);

    const { data } = await axios.get(
      'https://api.rss2json.com/v1/api.json?rss_url=' +
      encodeURIComponent('https://feeds.bbci.co.uk/sport/football/rss.xml') +
      '&count=15', { timeout: 8000 }
    );
    const items  = (data.items || []).map(n => ({
      title: n.title,
      summary: n.description?.replace(/<[^>]+>/g, '') || '',
      url: n.link, date: n.pubDate, image: n.thumbnail || null,
    }));
    const result = { data: { items } };
    cache.set('news', result, 900);
    ok(res, result);
  } catch(e) { console.error('news:', e.message); err(res, e.message); }
});

// ── 7. PLAYER SEARCH ──────────────────────────────────────
app.get('/sport/playersearch', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing ?q=', 400);
  try {
    const data = await apiFetch(
      `player_${q.toLowerCase()}_${SEASON}`, '/players',
      { search: q, season: SEASON }, 3600  // ← current season
    );
    const result = (data.response || []).slice(0, 8).map(p => ({
      name: p.player.name,
      team: p.statistics[0]?.team?.name || 'N/A',
      nationality: p.player.nationality || 'N/A',
      position: p.statistics[0]?.games?.position || 'N/A',
      birthDate: p.player.birth?.date || 'N/A',
      status: 'Active',
      goals: p.statistics[0]?.goals?.total || 0,
      assists: p.statistics[0]?.goals?.assists || 0,
      appearances: p.statistics[0]?.games?.appearences || 0,
      photo: p.player.photo || null,
    }));
    ok(res, result);
  } catch(e) { console.error('player search:', e.message); err(res, e.message); }
});

// ── 8. TEAM SEARCH ────────────────────────────────────────
app.get('/sport/teamsearch', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing ?q=', 400);
  try {
    const data = await apiFetch(`team_${q.toLowerCase()}`, '/teams', { search: q }, 3600);
    const result = (data.response || []).slice(0, 5).map(t => ({
      name: t.team.name, shortName: t.team.code || '',
      stadium: t.venue.name || 'N/A',
      stadiumCapacity: t.venue.capacity || null,
      location: t.venue.city || 'N/A',
      league: 'N/A', formedYear: t.team.founded || 'N/A',
      logo: t.team.logo || null,
    }));
    ok(res, result);
  } catch(e) { console.error('team search:', e.message); err(res, e.message); }
});

// ── 9. VENUE SEARCH ───────────────────────────────────────
app.get('/sport/venuesearch', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing ?q=', 400);
  try {
    const data = await apiFetch(`venue_${q.toLowerCase()}`, '/venues', { search: q }, 86400);
    const result = (data.response || []).slice(0, 5).map(v => ({
      name: v.name, location: v.city || 'N/A',
      country: v.country || 'N/A', capacity: v.capacity || null,
      sport: 'Football', timezone: 'N/A',
    }));
    ok(res, result);
  } catch(e) { console.error('venue search:', e.message); err(res, e.message); }
});

// ── 10. MATCH HISTORY ─────────────────────────────────────
app.get('/sport/gameevents', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return err(res, 'Missing ?q=', 400);
  try {
    const teamData = await apiFetch(
      `team_evt_${q.toLowerCase()}`, '/teams', { search: q }, 3600
    );
    const team = teamData.response?.[0]?.team;
    if (!team) return ok(res, []);

    const fixData = await apiFetch(
      `fixtures_${team.id}_${SEASON}`, '/fixtures',
      { team: team.id, season: SEASON, last: 8, timezone: 'Africa/Nairobi' }, 1800
    );
    const result = (fixData.response || []).map(f => ({
      match: `${f.teams.home.name} vs ${f.teams.away.name}`,
      league: { name: f.league.name },
      season: `${f.league.season}/${f.league.season + 1}`,
      dateTime: {
        date: new Date(f.fixture.date).toLocaleDateString('en-GB'),
        time: new Date(f.fixture.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      },
      venue: { name: f.fixture.venue?.name || 'N/A' },
      teams: {
        home: { name: f.teams.home.name, score: f.goals.home ?? '-' },
        away: { name: f.teams.away.name, score: f.goals.away ?? '-' },
      },
      status: f.fixture.status.long,
    }));
    ok(res, result);
  } catch(e) { console.error('game events:', e.message); err(res, e.message); }
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => err(res, `Not found: ${req.path}`, 404));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚽ Football API on port ${PORT} — Season ${SEASON}/${SEASON + 1}\n`);
});
