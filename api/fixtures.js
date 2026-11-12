const L = require('./_lib');
module.exports = async (req, res) => {
  const base = 'https://www.thesportsdb.com/api/v1/json/123';
  const [next, past, season] = await Promise.all([
    L.getJSON(`${base}/eventsnextleague.php?id=4406`),
    L.getJSON(`${base}/eventspastleague.php?id=4406`),
    L.getJSON(`${base}/eventsseason.php?id=4406&s=2026`),
  ]);
  const map = new Map();
  for (const src of [season, past, next]) for (const e of (src && src.events) || []) {
    map.set(e.idEvent, {
      id: 'tsdb-' + e.idEvent, home: e.strHomeTeam, away: e.strAwayTeam, kickoff: e.strTimestamp ? e.strTimestamp + 'Z' : `${e.dateEvent}T${e.strTime || '00:00:00'}Z`,
      round: e.intRound, venue: e.strVenue, status: e.strStatus, score: e.intHomeScore != null ? `${e.intHomeScore}-${e.intAwayScore}` : null,
      homeBadge: e.strHomeTeamBadge, awayBadge: e.strAwayTeamBadge, league: 'Liga Profesional de Fútbol', source: 'TheSportsDB',
    });
  }
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  L.send(res, 200, { fetchedAt: new Date().toISOString(), matches: [...map.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff)) });
};
