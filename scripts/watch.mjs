// Checks the league site for changes (game times, dates, courts, results, new games, rosters)
// and sends a Web Push notification to every subscribed phone. Runs from .github/workflows/watch.yml.
//
// Firebase Realtime Database layout (admin access via FIREBASE_DB_SECRET):
//   /watch/vapid       { publicKey, privateKey }   generated on the first run
//   /watch/state       last snapshot of games + teams
//   /public/vapidPublicKey                           read by the app to subscribe
//   /subs/{id}         { endpoint, keys, scope }    written by the app
import webpush from 'web-push';

const APP_ID = '6a9815ee144fbfc9006da8b0';
const LEAGUE_API = `https://octopus-league-hub.base44.app/api/apps/${APP_ID}/entities`;
const DB = 'https://footvolly-ori-kamar-default-rtdb.europe-west1.firebasedatabase.app';
const SITE = 'https://oriaha.github.io/footvolly_league/';
const OUR_TEAM_ID = '6ac7b37db830138dfc0f7106';
const FINISHED = 'הסתיים';
const MAX_LINES = 5;

const SECRET = process.env.FIREBASE_DB_SECRET;

async function db(path, method = 'GET', body) {
  const res = await fetch(`${DB}/${path}.json?auth=${encodeURIComponent(SECRET)}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Firebase ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}
async function league(entity) {
  const res = await fetch(`${LEAGUE_API}/${entity}`, { headers: { 'X-App-Id': APP_ID } });
  if (!res.ok) throw new Error(`League ${entity}: HTTP ${res.status}`);
  return res.json();
}

// The fields we watch, per game and per team.
export function snapshot(games, teams) {
  const g = {}, t = {};
  for (const x of games) {
    g[x.id] = {
      league_id: x.league_id || '', league: x.league_name || '', round: x.round_number ?? null, date: x.date || '',
      time: x.time || '', court: x.court ? String(x.court) : '', status: x.status || '',
      a: x.team_a_id || '', b: x.team_b_id || '', an: x.team_a_name || x.team_a_placeholder || '', bn: x.team_b_name || x.team_b_placeholder || '',
      sa: x.score_a ?? null, sb: x.score_b ?? null, sets: x.sets_summary || '', win: x.winner_team_id || '', tech: !!x.is_technical_win,
    };
  }
  for (const x of teams) t[x.id] = { name: x.name || '', league_id: x.league_id || '', players: (x.players || []).join(', ') };
  return { games: g, teams: t };
}

const fmtDate = d => (d ? d.split('-').reverse().slice(0, 2).join('.') : '');
const vs = g => `${g.an} נגד ${g.bn}`;
function resultLine(g) {
  if (g.tech) return `🏁 ${g.win === g.a ? g.an : g.bn} – ניצחון טכני על ${g.win === g.a ? g.bn : g.an}`;
  const score = g.sets || (g.sa != null && g.sb != null ? `${g.sa}:${g.sb}` : '');
  const winA = g.win ? g.win === g.a : Number(g.sa) > Number(g.sb);
  const winB = g.win ? g.win === g.b : Number(g.sb) > Number(g.sa);
  if (winA || winB) return `🏁 ${winA ? g.an : g.bn} ניצחו את ${winA ? g.bn : g.an}${score ? ` ${score}` : ''}`;
  return `🏁 תוצאה: ${vs(g)}${score ? ` ${score}` : ''}`;
}

// Compare two snapshots → list of { league_id, ours, kind, round, text }.
export function diff(prev, next) {
  const out = [];
  const push = (g, kind, text) => out.push({ league_id: g.league_id, ours: g.a === OUR_TEAM_ID || g.b === OUR_TEAM_ID, kind, round: g.round, text });
  for (const [id, g] of Object.entries(next.games)) {
    const o = prev.games[id];
    const where = `(מחזור ${g.round ?? '—'}${g.date ? `, ${fmtDate(g.date)}` : ''})`;
    if (!o) { push(g, 'new', `➕ משחק חדש: ${vs(g)} ${where}`); continue; }
    if (g.status === FINISHED && (o.status !== FINISHED || o.sa !== g.sa || o.sb !== g.sb || o.sets !== g.sets || o.win !== g.win)) {
      push(g, 'result', resultLine(g));
      continue;
    }
    if (o.a !== g.a || o.b !== g.b) push(g, 'teams', `🔄 שינוי בקבוצות: ${vs(g)} ${where}`);
    if (o.date !== g.date && g.date) push(g, 'date', `📅 תאריך חדש: ${vs(g)} – ${fmtDate(g.date)}`);
    if (o.time !== g.time && g.time) {
      push(g, o.time ? 'time-change' : 'time', `🕘 ${vs(g)} – ${g.time}${o.time ? ` (במקום ${o.time})` : ''}${g.court ? ` · מגרש ${g.court}` : ''} ${where}`);
    } else if (o.court !== g.court && g.court) {
      push(g, 'court', `📍 ${vs(g)} – מגרש ${g.court} ${where}`);
    }
    if (o.status !== g.status && g.status && g.status !== FINISHED && g.status !== 'מתוכנן') push(g, 'status', `ℹ️ ${vs(g)}: ${g.status}`);
  }
  for (const [id, o] of Object.entries(prev.games)) if (!next.games[id]) push(o, 'removed', `➖ משחק בוטל/הוסר: ${vs(o)} (מחזור ${o.round ?? '—'})`);
  for (const [id, t] of Object.entries(next.teams)) {
    const o = prev.teams[id];
    if (o && o.name !== t.name && t.name) {
      out.push({ league_id: t.league_id, ours: id === OUR_TEAM_ID, kind: 'rename', round: null, text: `✏️ ${o.name} נקראת עכשיו ${t.name}` });
    }
    if (o && o.players !== t.players && t.players) {
      out.push({ league_id: t.league_id, ours: id === OUR_TEAM_ID, kind: 'players', round: null, text: `👥 ${t.name}: ${t.players}` });
    }
  }
  return out;
}

// Turn the changes relevant to one subscriber into a notification. Our games first; bulk time
// publishing (many games in one round) collapses into a single line.
export function compose(changes, leagueNames) {
  if (!changes.length) return null;
  const ours = changes.filter(c => c.ours), rest = changes.filter(c => !c.ours);
  const lines = ours.map(c => c.text);
  const bulk = {};
  for (const c of rest) if (c.kind === 'time') (bulk[`${c.league_id}|${c.round}`] ||= []).push(c);
  for (const [key, cs] of Object.entries(bulk)) {
    if (cs.length < 3) continue;
    const [lid, round] = key.split('|');
    lines.push(`🕘 פורסמו שעות למחזור ${round} ב${leagueNames[lid] || 'ליגה'} (${cs.length} משחקים)`);
    cs.forEach(c => { c.collapsed = true; });
  }
  for (const c of rest) if (!c.collapsed) lines.push(c.text);
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`ועוד ${lines.length - MAX_LINES} עדכונים`);
  return {
    title: ours.length ? "חות'ים · עדכון מהליגה" : 'עדכון מהליגה',
    body: shown.join('\n'),
    url: ours.length ? SITE : `${SITE}#/schedule`,
  };
}

export async function main() {
  if (!SECRET) throw new Error('FIREBASE_DB_SECRET is not set');
  const [games, teams, leagues] = await Promise.all([league('Game?sort=-updated_date&limit=500'), league('Team?sort=-updated_date&limit=300'), league('League?sort=order&limit=20')]);
  const next = snapshot(games, teams);
  const leagueNames = Object.fromEntries(leagues.map(l => [l.id, l.name]));
  const ourLeague = (teams.find(t => t.id === OUR_TEAM_ID) || {}).league_id;

  const watch = (await db('watch')) || {};
  let vapid = watch.vapid;
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    await db('watch/vapid', 'PUT', vapid);
    console.log('Generated VAPID keys');
  }
  await db('public/vapidPublicKey', 'PUT', vapid.publicKey);

  if (!watch.state) {
    await db('watch/state', 'PUT', next);
    console.log('First run: saved snapshot, nothing to compare yet');
    return;
  }
  const changes = diff({ games: watch.state.games || {}, teams: watch.state.teams || {} }, next);
  console.log(`${changes.length} change(s)`);
  changes.forEach(c => console.log(' -', c.text));

  if (changes.length) {
    webpush.setVapidDetails('https://oriaha.github.io/footvolly_league/', vapid.publicKey, vapid.privateKey);
    const subs = (await db('subs')) || {};
    for (const [id, sub] of Object.entries(subs)) {
      const mine = sub.scope === 'all' ? changes : changes.filter(c => c.league_id === ourLeague || c.ours);
      const note = compose(mine.map(c => ({ ...c })), leagueNames);
      if (!note) continue;
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(note), { TTL: 6 * 3600 });
        console.log('sent to', id);
      } catch (e) {
        console.log('failed for', id, e.statusCode || e.message);
        if (e.statusCode === 404 || e.statusCode === 410) await db(`subs/${id}`, 'DELETE');
      }
    }
  }
  // Save after sending, so a failed run re-sends next time instead of losing the update.
  await db('watch/state', 'PUT', next);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
