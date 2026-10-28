'use strict';

// ---- Config -------------------------------------------------------------
const APP_ID = '6a9815ee144fbfc9006da8b0';
const API = `https://octopus-league-hub.base44.app/api/apps/${APP_ID}/entities`;
const OUR_TEAM_ID = '6ac7b37db830138dfc0f7106'; // חות'ים
const OUR_TEAM_NAME_RE = /חות/;
const OUR_LEAGUE_NAME = 'ליגה שנייה';
const FINISHED = 'הסתיים';
const CACHE_KEY = 'fl-cache-v1';
const AUTO_REFRESH_MS = 2 * 60 * 1000;

// Same queries the league site itself makes for its public pages.
const SOURCES = {
  games: 'Game?sort=-updated_date&limit=500',
  teams: 'Team?sort=-updated_date&limit=300',
  leagues: 'League?sort=order&limit=20',
  settings: 'Settings?sort=-updated_date&limit=5',
};
const LEAGUE_KEY = 'fl-league';
const SITE = 'https://octopus-league-hub.base44.app';

// ---- State --------------------------------------------------------------
let data = null; // { games, teams, leagues, fetchedAt }
let ourTeam = null;
let loadError = null;

// ---- Data loading -------------------------------------------------------
async function fetchEntity(path) {
  const res = await fetch(`${API}/${path}`, { headers: { 'X-App-Id': APP_ID } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Keep only the fields the app shows (team records also hold registration/payment data).
function slimTeam(t) {
  return { id: t.id, name: t.name, league_id: t.league_id, league_name: t.league_name,
    players: Array.isArray(t.players) ? t.players : [], color: t.color || null,
    logo_url: t.logo_url || null, approval_status: t.approval_status };
}

// Only the scoring rules; the settings record also holds payment/registration data.
function slimSettings(s) {
  s = s || {};
  return { season_name: s.season_name || '', win_points: s.win_points ?? 2, loss_points: s.loss_points ?? 1,
    tiebreakers: s.tiebreakers || 'הפרש נקודות, מפגש ישיר' };
}

async function loadData() {
  const [games, teams, leagues, settings] = await Promise.all([
    fetchEntity(SOURCES.games), fetchEntity(SOURCES.teams), fetchEntity(SOURCES.leagues),
    fetchEntity(SOURCES.settings),
  ]);
  return { games, teams: teams.map(slimTeam), leagues, settings: slimSettings(settings[0]), fetchedAt: Date.now() };
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}
function writeCache(d) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
}

function setData(d) {
  data = d;
  ourTeam = data.teams.find(t => t.id === OUR_TEAM_ID)
    || data.teams.find(t => OUR_TEAM_NAME_RE.test(t.name) && t.league_name === OUR_LEAGUE_NAME)
    || null;
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  document.body.classList.add('is-refreshing');
  try {
    const d = await loadData();
    setData(d);
    writeCache(d);
    loadError = null;
  } catch (e) {
    loadError = e;
  } finally {
    refreshing = false;
    document.body.classList.remove('is-refreshing');
    render();
  }
}

// ---- Game helpers -------------------------------------------------------
const isFinished = g => g.status === FINISHED;
const sideOf = (g, teamId) => (g.team_a_id === teamId ? 'a' : g.team_b_id === teamId ? 'b' : null);
const other = s => (s === 'a' ? 'b' : 'a');
const teamName = (g, s) => g[`team_${s}_name`] || g[`team_${s}_placeholder`] || '—';
const teamIdOf = (g, s) => g[`team_${s}_id`] || null;

// Mirrors the league site's own winner logic.
function winnerSide(g) {
  if (!isFinished(g)) return null;
  if (g.winner_team_id) {
    if (g.winner_team_id === g.team_a_id) return 'a';
    if (g.winner_team_id === g.team_b_id) return 'b';
    return null;
  }
  const a = Number(g.score_a), b = Number(g.score_b);
  return a > b ? 'a' : b > a ? 'b' : null;
}

// 'W' | 'L' | 'T' | null from the given team's point of view.
function resultFor(g, teamId) {
  const s = sideOf(g, teamId);
  if (!s || !isFinished(g)) return null;
  const w = winnerSide(g);
  return w === null ? 'T' : w === s ? 'W' : 'L';
}

// Score text from the given side's point of view (that side's score first).
function scoreText(g, s) {
  if (g.is_technical_win) return 'ניצחון טכני';
  const o = other(s);
  const sets = Array.isArray(g.sets) ? g.sets.filter(x => x && x.a !== '' && x.a != null && x.b !== '' && x.b != null) : [];
  if (sets.length) return sets.map(x => `${x[s]}:${x[o]}`).join(' · ');
  if (g[`score_${s}`] != null && g[`score_${o}`] != null) return `${g[`score_${s}`]}:${g[`score_${o}`]}`;
  return g.sets_summary || '';
}

function gameSort(a, b) {
  return (a.date || '9999').localeCompare(b.date || '9999')
    || (a.time || '99:99').localeCompare(b.time || '99:99')
    || (a.round_number || 0) - (b.round_number || 0);
}

function gamesOf(teamId) {
  return data.games.filter(g => g.team_a_id === teamId || g.team_b_id === teamId).sort(gameSort);
}

function recordOf(teamId) {
  const r = { W: 0, L: 0, T: 0, played: 0 };
  for (const g of gamesOf(teamId)) {
    const res = resultFor(g, teamId);
    if (res) { r[res]++; r.played++; }
  }
  return r;
}

const teamById = id => data.teams.find(t => t.id === id) || null;
const isApproved = t => t.approval_status === 'אושרה';

// Mirrors the league site's standings: regular-season finished games only,
// sorted by league points then points difference, 2-way ties by head-to-head.
function standings(leagueId) {
  const { win_points: wp, loss_points: lp } = data.settings || slimSettings();
  const rows = data.teams.filter(t => t.league_id === leagueId && isApproved(t)).map(t => ({
    team: t, played: 0, wins: 0, losses: 0, pf: 0, pa: 0, diff: 0, pts: 0, tied: false,
  }));
  const byId = Object.fromEntries(rows.map(r => [r.team.id, r]));
  const h2h = {};
  for (const g of data.games) {
    if (!isFinished(g) || g.is_final_four || (g.game_type && g.game_type !== 'regular')) continue;
    const A = byId[g.team_a_id], B = byId[g.team_b_id];
    if (!A || !B) continue;
    const a = Number(g.score_a) || 0, b = Number(g.score_b) || 0;
    A.played++; B.played++; A.pf += a; A.pa += b; B.pf += b; B.pa += a;
    let w = null;
    if (g.winner_team_id && (g.winner_team_id === g.team_a_id || g.winner_team_id === g.team_b_id)) w = g.winner_team_id;
    else if (a > b) w = g.team_a_id;
    else if (b > a) w = g.team_b_id;
    if (!w) continue;
    const l = w === g.team_a_id ? g.team_b_id : g.team_a_id;
    byId[w].wins++; byId[w].pts += wp; byId[l].losses++; byId[l].pts += lp;
    (h2h[w] ||= {})[l] = (h2h[w][l] || 0) + 1;
  }
  rows.forEach(r => { r.diff = r.pf - r.pa; });
  rows.sort((x, y) => y.pts - x.pts || y.diff - x.diff || x.team.name.localeCompare(y.team.name, 'he'));
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].pts === rows[i].pts && rows[j].diff === rows[i].diff) j++;
    const grp = rows.slice(i, j);
    if (grp.length === 2) {
      const [x, y] = grp, xy = h2h[x.team.id]?.[y.team.id] || 0, yx = h2h[y.team.id]?.[x.team.id] || 0;
      if (yx > xy) grp.reverse(); else if (xy === yx) grp.forEach(r => { r.tied = true; });
    } else if (grp.length > 2) grp.forEach(r => { r.tied = true; });
    out.push(...grp);
    i = j;
  }
  out.forEach((r, i) => { r.rank = i + 1; });
  return out;
}

// Selected league for the league-wide tabs (defaults to ours).
function currentLeagueId() {
  let id = null;
  try { id = localStorage.getItem(LEAGUE_KEY); } catch { /* storage unavailable */ }
  if (id && data.leagues.some(l => l.id === id)) return id;
  return (ourTeam && ourTeam.league_id) || (data.leagues.find(l => l.name === OUR_LEAGUE_NAME) || data.leagues[0] || {}).id;
}
function setLeague(id) {
  try { localStorage.setItem(LEAGUE_KEY, id); } catch { /* storage unavailable */ }
  render();
}
window.setLeague = setLeague;

// ---- Formatting ---------------------------------------------------------
const WEEKDAY = new Intl.DateTimeFormat('he-IL', { weekday: 'long' });
function parseDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}
function fmtDate(d) {
  const dt = parseDate(d);
  if (!dt) return 'תאריך ייקבע';
  return `${WEEKDAY.format(dt)} ${dt.getDate()}.${dt.getMonth() + 1}`;
}
function daysUntil(d) {
  const dt = parseDate(d);
  if (!dt) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((dt - today) / 86400000);
}
function relDay(n) {
  if (n === null) return '';
  if (n === 0) return 'היום!';
  if (n === 1) return 'מחר';
  if (n > 1) return `בעוד ${n} ימים`;
  return '';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const RESULT_LABEL = { W: 'ניצחון', L: 'הפסד', T: 'תיקו' };
function badge(res) {
  if (!res) return '';
  return `<span class="badge badge-${res}">${RESULT_LABEL[res]}</span>`;
}
function dot(team) {
  const c = team && /^#[0-9a-f]{3,8}$/i.test(team.color || '') ? team.color : 'var(--muted)';
  return `<span class="dot" style="background:${c}"></span>`;
}
function recordText(r) {
  if (!r.played) return 'טרם שיחקו';
  return `${r.W} נצ׳ · ${r.L} הפ׳${r.T ? ` · ${r.T} תיקו` : ''}`;
}
function playersParen(team) {
  return team && team.players.length ? ` <span class="players-paren">(${team.players.map(esc).join(', ')})</span>` : '';
}
function teamLink(id, name) {
  return id ? `<a class="team-link" href="#/team/${esc(id)}">${esc(name)}</a>` : `<span>${esc(name)}</span>`;
}
function whenText(g) {
  const bits = [];
  bits.push(g.time ? g.time : 'שעה תפורסם');
  if (g.court) bits.push(`מגרש ${esc(g.court)}`);
  return bits.join(' · ');
}

// ---- Views --------------------------------------------------------------
function viewHome() {
  if (!ourTeam) return `<div class="empty">לא נמצאה הקבוצה חות'ים בנתוני הליגה.</div>`;
  const games = gamesOf(ourTeam.id);
  const rec = recordOf(ourTeam.id);
  const next = games.find(g => !isFinished(g) && (daysUntil(g.date) ?? 0) >= 0);

  let html = `
    <section class="hero">
      <div class="hero-team">${dot(ourTeam)}<h1>${esc(ourTeam.name)}</h1></div>
      <div class="players">${ourTeam.players.map(p => `<span class="chip">${esc(p)}</span>`).join('')}</div>
      <div class="stats">
        <div><b>${games.length}</b><small>משחקים</small></div>
        <div><b class="c-W">${rec.W}</b><small>ניצחונות</small></div>
        <div><b class="c-L">${rec.L}</b><small>הפסדים</small></div>
        <div><b>${games.length - rec.played}</b><small>נותרו</small></div>
      </div>
    </section>`;

  if (next) {
    const s = sideOf(next, ourTeam.id), os = other(s);
    const oppId = teamIdOf(next, os), opp = teamById(oppId);
    html += `
      <a class="next-card" href="${oppId ? `#/team/${esc(oppId)}` : '#/'}">
        <div class="next-label">המשחק הבא · ${relDay(daysUntil(next.date)) || fmtDate(next.date)}</div>
        <div class="next-vs">נגד ${dot(opp)} <strong>${esc(teamName(next, os))}</strong></div>
        ${opp && opp.players.length ? `<div class="next-players">(${opp.players.map(esc).join(', ')})</div>` : ''}
        <div class="next-meta">מחזור ${next.round_number ?? '—'} · ${fmtDate(next.date)} · ${whenText(next)}</div>
        ${opp ? `<div class="next-meta">מאזן היריבה: ${recordText(recordOf(opp.id))}</div>` : ''}
        <div class="next-cta">לחצו לפרטי היריבה ←</div>
      </a>`;
  }

  html += `<h2 class="section-title">לוח המשחקים שלנו</h2>`;
  if (!games.length) return html + `<div class="empty">עדיין לא פורסם לוח משחקים.</div>`;

  // Group by round/date.
  const groups = [];
  for (const g of games) {
    const key = `${g.round_number ?? ''}|${g.date ?? ''}`;
    let grp = groups[groups.length - 1];
    if (!grp || grp.key !== key) groups.push(grp = { key, round: g.round_number, date: g.date, games: [] });
    grp.games.push(g);
  }

  for (const grp of groups) {
    const dd = daysUntil(grp.date);
    html += `<div class="round">
      <div class="round-head"><span>מחזור ${grp.round ?? '—'}</span><span>${fmtDate(grp.date)}${dd !== null && dd >= 0 && dd <= 7 ? ` · ${relDay(dd)}` : ''}</span></div>`;
    for (const g of grp.games) {
      const s = sideOf(g, ourTeam.id), os = other(s);
      const oppId = teamIdOf(g, os), opp = teamById(oppId);
      const res = resultFor(g, ourTeam.id);
      const oppRec = opp ? recordOf(opp.id) : null;
      html += `
        <a class="game ${res ? `game-${res}` : ''} ${next === g ? 'game-next' : ''}" href="${oppId ? `#/team/${esc(oppId)}` : '#/'}">
          <div class="game-main">
            <div class="game-opp">${dot(opp)}<span>נגד <strong>${esc(teamName(g, os))}</strong>${playersParen(opp)}</span></div>
            <div class="game-meta">${whenText(g)}${oppRec ? ` · מאזן יריבה ${oppRec.played ? `${oppRec.W}-${oppRec.L}` : '0-0'}` : ''}</div>
          </div>
          <div class="game-side">
            ${res ? `${badge(res)}<span class="score">${esc(scoreText(g, s))}</span>` : `<span class="chev">‹</span>`}
          </div>
        </a>`;
    }
    html += `</div>`;
  }
  return html;
}

function viewTeam(id) {
  const team = teamById(id);
  if (!team) return `<div class="empty">הקבוצה לא נמצאה. <a href="#/">חזרה ללוח</a></div>`;
  const games = gamesOf(id);
  const played = games.filter(isFinished).reverse(); // newest first
  const upcoming = games.filter(g => !isFinished(g));
  const rec = recordOf(id);
  const isUs = ourTeam && id === ourTeam.id;
  const vsUs = ourTeam && !isUs ? games.filter(g => sideOf(g, ourTeam.id)) : [];

  let html = `
    <button class="back" onclick="goBack()">→ חזרה</button>
    <section class="hero">
      <div class="hero-team">${dot(team)}<h1>${esc(team.name)}</h1></div>
      <div class="sub">${esc(team.league_name || '')}</div>
      <h3 class="mini-title">שחקנים</h3>
      <div class="players">${team.players.length ? team.players.map(p => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="muted">לא פורסמו שחקנים</span>'}</div>
      <div class="stats">
        <div><b>${rec.played}</b><small>שוחקו</small></div>
        <div><b class="c-W">${rec.W}</b><small>ניצחונות</small></div>
        <div><b class="c-L">${rec.L}</b><small>הפסדים</small></div>
        <div><b>${rec.played ? Math.round((rec.W / rec.played) * 100) + '%' : '—'}</b><small>אחוז ניצחון</small></div>
      </div>
      ${played.length ? `<div class="form">${played.slice(0, 5).map(g => { const r = resultFor(g, id); return `<span class="form-${r}" title="${RESULT_LABEL[r]}">${r === 'W' ? 'נ' : r === 'L' ? 'ה' : 'ת'}</span>`; }).join('')}<small>5 אחרונים</small></div>` : ''}
    </section>`;

  if (vsUs.length) {
    html += `<h2 class="section-title">המשחקים שלנו מולם</h2><div class="round">`;
    for (const g of vsUs) html += gameRow(g, ourTeam.id, true);
    html += `</div>`;
  }

  html += `<h2 class="section-title">תוצאות קודמות</h2>`;
  if (!played.length) {
    html += `<div class="empty">הקבוצה עדיין לא שיחקה העונה. התוצאות יופיעו כאן אוטומטית כשיתעדכנו באתר הליגה.</div>`;
  } else {
    html += `<div class="round">${played.map(g => gameRow(g, id)).join('')}</div>`;
  }

  if (upcoming.length) {
    html += `<details class="upcoming"><summary>המשחקים הבאים שלהם (${upcoming.length})</summary><div class="round">${upcoming.map(g => gameRow(g, id)).join('')}</div></details>`;
  }
  return html;
}

// A game row from `teamId`'s point of view: date, opponent, score, W/L.
// `ours` labels the row as our own game ("חות'ים נגד ...").
function gameRow(g, teamId, ours = false) {
  const s = sideOf(g, teamId), os = other(s);
  const oppId = teamIdOf(g, os), opp = teamById(oppId);
  const res = resultFor(g, teamId);
  const vsOurs = ourTeam && oppId === ourTeam.id;
  const label = ours
    ? `<strong>${esc(teamName(g, s))}</strong> נגד ${esc(teamName(g, os))}`
    : `נגד ${vsOurs ? `<strong>${esc(teamName(g, os))}</strong> <span class="us-tag">אנחנו</span>` : teamLink(oppId, teamName(g, os))}`;
  return `
    <div class="game ${res ? `game-${res}` : ''}">
      <div class="game-main">
        <div class="game-opp">${dot(ours ? ourTeam : opp)}<span>${label}</span></div>
        <div class="game-meta">מחזור ${g.round_number ?? '—'} · ${fmtDate(g.date)}${isFinished(g) ? '' : ` · ${whenText(g)}`}</div>
      </div>
      <div class="game-side">${res ? `${badge(res)}<span class="score">${esc(scoreText(g, s))}</span>` : ''}</div>
    </div>`;
}

function leaguePicker(selected) {
  return `<div class="seg" role="tablist">${data.leagues.map(l =>
    `<button role="tab" class="${l.id === selected ? 'on' : ''}" onclick="setLeague('${esc(l.id)}')">${esc(l.name)}</button>`).join('')}</div>`;
}

function viewStandings() {
  const lid = currentLeagueId();
  const rows = standings(lid);
  const st = data.settings || slimSettings();
  let html = `<h1 class="page-title">טבלאות</h1>${leaguePicker(lid)}`;
  if (!rows.length) return html + `<div class="empty">אין קבוצות בליגה הזו.</div>`;
  html += `<div class="table-card"><table class="standings">
    <thead><tr><th>#</th><th class="t-name">קבוצה</th><th>מש׳</th><th>נ׳</th><th>ה׳</th><th>הפרש</th><th>נק׳</th></tr></thead><tbody>`;
  for (const r of rows) {
    const us = ourTeam && r.team.id === ourTeam.id;
    html += `<tr class="${us ? 'us' : ''}" onclick="location.hash='#/team/${esc(r.team.id)}'">
      <td>${r.rank}${r.tied ? '*' : ''}</td>
      <td class="t-name">${dot(r.team)}<span>${esc(r.team.name)}</span></td>
      <td>${r.played}</td><td class="c-W">${r.wins}</td><td class="c-L">${r.losses}</td>
      <td dir="ltr">${r.diff > 0 ? '+' : ''}${r.diff}</td><td><b>${r.pts}</b></td></tr>`;
  }
  html += `</tbody></table>
    <div class="legend">ניצחון = ${esc(st.win_points)} נק׳ ליגה · הפסד = ${esc(st.loss_points)} נק׳ ליגה · שוברי שוויון: ${esc(st.tiebreakers)}${rows.some(r => r.tied) ? ' · * שוויון שיוכרע ע״י הנהלת הליגה' : ''}</div>
  </div>`;
  return html;
}

function viewSchedule(roundParam) {
  const lid = currentLeagueId();
  const games = data.games.filter(g => g.league_id === lid).sort(gameSort);
  const rounds = [...new Set(games.map(g => g.round_number).filter(n => n != null))].sort((a, b) => a - b);
  // Default to the first round that still has unplayed games.
  const nextRound = (games.find(g => !isFinished(g)) || {}).round_number;
  const round = roundParam === 'all' ? 'all' : roundParam != null && rounds.includes(Number(roundParam)) ? Number(roundParam) : (nextRound ?? rounds[0] ?? 'all');
  let html = `<h1 class="page-title">לוח משחקים</h1>${leaguePicker(lid)}
    <div class="chips-scroll">${rounds.map(n => `<a class="pill ${round === n ? 'on' : ''}" href="#/schedule/${n}">מחזור ${n}</a>`).join('')}<a class="pill ${round === 'all' ? 'on' : ''}" href="#/schedule/all">הכל</a></div>`;
  const shown = round === 'all' ? games : games.filter(g => g.round_number === round);
  if (!shown.length) return html + `<div class="empty">אין משחקים להצגה.</div>`;

  const groups = [];
  for (const g of shown) {
    const key = `${g.round_number ?? ''}|${g.date ?? ''}`;
    let grp = groups[groups.length - 1];
    if (!grp || grp.key !== key) groups.push(grp = { key, round: g.round_number, date: g.date, games: [] });
    grp.games.push(g);
  }
  for (const grp of groups) {
    html += `<div class="round"><div class="round-head"><span>מחזור ${grp.round ?? '—'}</span><span>${fmtDate(grp.date)}</span></div>`;
    for (const g of grp.games) {
      const w = winnerSide(g);
      const ours = ourTeam && sideOf(g, ourTeam.id);
      const side = s => {
        const id = teamIdOf(g, s), t = teamById(id);
        return `<div class="fx-team ${w === s ? 'won' : w ? 'lost' : ''}">${id ? `<a href="#/team/${esc(id)}">${esc(teamName(g, s))}</a>` : esc(teamName(g, s))}${dot(t)}</div>`;
      };
      const mid = isFinished(g)
        ? `<div class="fx-score">${esc(scoreText(g, 'a'))}</div>`
        : `<div class="fx-time">${g.time ? esc(g.time) : '—'}${g.court ? `<small>מגרש ${esc(g.court)}</small>` : ''}</div>`;
      html += `<div class="fixture ${ours ? 'fx-ours' : ''}">${side('a')}${mid}${side('b').replace('fx-team', 'fx-team fx-b')}</div>`;
    }
    html += `</div>`;
  }
  return html;
}

function viewTeams() {
  const lid = currentLeagueId();
  const teams = data.teams.filter(t => t.league_id === lid && isApproved(t)).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  let html = `<h1 class="page-title">קבוצות</h1>${leaguePicker(lid)}`;
  if (!teams.length) return html + `<div class="empty">אין קבוצות בליגה הזו.</div>`;
  html += `<div class="team-grid">`;
  for (const t of teams) {
    const rec = recordOf(t.id), us = ourTeam && t.id === ourTeam.id;
    html += `<a class="team-card ${us ? 'us' : ''}" href="#/team/${esc(t.id)}">
      <div class="team-card-head">${dot(t)}<strong>${esc(t.name)}</strong>${us ? '<span class="us-tag">אנחנו</span>' : ''}</div>
      <div class="team-card-players">${t.players.map(esc).join(' · ') || '—'}</div>
      <div class="team-card-rec">${recordText(rec)}</div>
    </a>`;
  }
  return html + `</div>`;
}

// Back within the app if we navigated here; otherwise (opened by direct link) go home.
function goBack() {
  let navigated = false;
  try { navigated = !!sessionStorage.getItem('fl-nav'); } catch { /* storage unavailable */ }
  if (navigated) history.back(); else location.hash = '#/';
}
window.goBack = goBack;

// ---- Render / routing ---------------------------------------------------
const TABS = [
  { id: 'home', href: '#/', label: 'בית', icon: '🏠' },
  { id: 'standings', href: '#/standings', label: 'טבלאות', icon: '🏆' },
  { id: 'schedule', href: '#/schedule', label: 'לוח משחקים', icon: '📅' },
  { id: 'teams', href: '#/teams', label: 'קבוצות', icon: '👥' },
];

function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/team\/([\w-]+)/))) return { tab: null, html: () => viewTeam(m[1]) };
  if (h.startsWith('#/standings')) return { tab: 'standings', html: viewStandings };
  if ((m = h.match(/^#\/schedule(?:\/([\w]+))?/))) return { tab: 'schedule', html: () => viewSchedule(m[1]) };
  if (h.startsWith('#/teams')) return { tab: 'teams', html: viewTeams };
  return { tab: 'home', html: viewHome };
}

function renderTabs(active) {
  document.getElementById('tabs').innerHTML = TABS.map(t =>
    `<a href="${t.href}" class="${t.id === active ? 'on' : ''}"><span class="tab-icon" aria-hidden="true">${t.icon}</span><span>${t.label}</span></a>`).join('');
}

function render() {
  const app = document.getElementById('app');
  if (!data) {
    app.innerHTML = loadError
      ? `<div class="empty">לא הצלחנו לטעון את נתוני הליגה (${esc(loadError.message)}).<br><button class="btn" onclick="refresh()">נסו שוב</button></div>`
      : `<div class="loading">טוען נתונים מהליגה…</div>`;
    return;
  }
  const r = route();
  renderTabs(r.tab);
  app.innerHTML = (loadError ? `<div class="warn">מוצגים נתונים שמורים – אין חיבור לאתר הליגה כרגע.</div>` : '')
    + r.html();
  const upd = document.getElementById('updated');
  upd.textContent = `עודכן ${new Date(data.fetchedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
}

window.addEventListener('hashchange', () => {
  try { sessionStorage.setItem('fl-nav', '1'); } catch { /* storage unavailable */ }
  render(); window.scrollTo(0, 0);
});
document.getElementById('refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && data && Date.now() - data.fetchedAt > AUTO_REFRESH_MS) refresh();
});
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, AUTO_REFRESH_MS);

const cached = readCache();
if (cached && cached.games) { setData(cached); render(); }
refresh();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
