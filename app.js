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
const APP_VERSION = 12;

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
    const [d] = await Promise.all([loadData(), loadSharedNotes().catch(() => { /* keep cached notes */ })]);
    setData(d);
    writeCache(d);
    loadError = null;
  } catch (e) {
    loadError = e;
  } finally {
    refreshing = false;
    document.body.classList.remove('is-refreshing');
    // Re-rendering the notes page would wipe a note mid-typing; it doesn't need fresh scores anyway.
    if (data && route().tab === 'notes') updateFooter(); else render();
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
      if (yx > xy) grp.reverse(); else if (xy === yx && x.played) grp.forEach(r => { r.tied = true; });
    } else if (grp.length > 2 && grp[0].played) grp.forEach(r => { r.tied = true; });
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

  // Live table position, from the same standings as the טבלאות tab.
  const table = standings(ourTeam.league_id);
  const row = table.find(r => r.team.id === ourTeam.id);
  const started = table.some(r => r.played);
  const rankBox = row ? `
      <a class="rank-box" href="#/standings" onclick="setLeague('${esc(ourTeam.league_id)}')">
        <div class="rank-main"><span class="rank-label">מקום בטבלה</span>
          <span class="rank-num">${started ? row.rank : '—'}</span><span class="rank-of">מתוך ${table.length}</span></div>
        <div class="rank-side">${started
          ? `<span><b>${row.pts}</b> נק׳</span><span dir="ltr">${row.diff > 0 ? '+' : ''}${row.diff}</span><small>הפרש</small>`
          : '<small>יתעדכן אחרי המחזור הראשון</small>'}</div>
        <span class="chev">‹</span>
      </a>` : '';

  let html = `
    <section class="hero">
      <div class="hero-team">${dot(ourTeam)}<h1>${esc(ourTeam.name)}</h1></div>
      <div class="players">${ourTeam.players.map(p => `<span class="chip">${esc(p)}</span>`).join('')}</div>
      ${rankBox}
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
            <div class="game-opp">${dot(opp)}<span>נגד <strong>${esc(teamName(g, os))}</strong>${oppId && noteFor(oppId) ? ' <span class="has-note" title="יש הערות">📝</span>' : ''}${playersParen(opp)}</span></div>
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

  const note = isUs ? '' : noteFor(id);
  if (note || (!isUs && canEdit())) {
    html += `<section class="note-view">
      <div class="note-view-head"><strong>📝 הערות</strong>${canEdit() ? `<a class="note-edit" href="#/notes/${esc(id)}">${note ? '✏️ עריכה' : '➕ הוספת הערה'}</a>` : ''}</div>
      ${note ? `<div class="note-body">${esc(note)}</div>` : '<div class="muted">עדיין אין הערות על הקבוצה הזו.</div>'}
    </section>`;
  }

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
      <td class="t-name"><div class="t-cell">${dot(r.team)}<span>${esc(r.team.name)}</span></div></td>
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
  if (navigated) history.back(); else navigate('#/');
}
window.goBack = goBack;

// ---- Render / routing ---------------------------------------------------
// ---- Notes (shared: notes.json in the GitHub repo) ----------------------
// Everyone reads notes.json; editing needs a GitHub token (Contents: read & write on this repo)
// that an editor pastes once and that stays on their own device.
const REPO = 'OriAha/footvolly_league';
const NOTES_FILE = 'notes.json';
const NOTES_RAW = `https://raw.githubusercontent.com/${REPO}/main/${NOTES_FILE}`;
const NOTES_API = `https://api.github.com/repos/${REPO}/contents/${NOTES_FILE}`;
const NOTES_CACHE_KEY = 'fl-notes-shared';
const OLD_LOCAL_NOTES_KEY = 'fl-notes-v1';
const TOKEN_KEY = 'fl-gh-token';

let sharedNotes = (() => { try { return JSON.parse(localStorage.getItem(NOTES_CACHE_KEY)) || {}; } catch { return {}; } })();

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
const canEdit = () => !!getToken();

function setSharedNotes(n) {
  sharedNotes = n && typeof n === 'object' ? n : {};
  try { localStorage.setItem(NOTES_CACHE_KEY, JSON.stringify(sharedNotes)); } catch { /* storage unavailable */ }
}
function noteFor(teamId) {
  const n = sharedNotes[teamId];
  return n && n.text ? n.text : '';
}

// Editors read through the API (always current); viewers read the public raw file (can lag a few minutes).
async function loadSharedNotes() {
  if (canEdit()) {
    try { return setSharedNotes((await readRemoteNotes()).notes); } catch { /* fall back to the public file */ }
  }
  const res = await fetch(`${NOTES_RAW}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return setSharedNotes({});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  setSharedNotes(await res.json());
}

// UTF-8 safe base64 for the GitHub contents API.
const b64encode = str => { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin); };
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

function ghHeaders() {
  return { Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
async function readRemoteNotes() {
  const res = await fetch(`${NOTES_API}?ref=main&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (res.status === 404) return { notes: {}, sha: null };
  if (res.status === 401 || res.status === 403) throw new Error('auth');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { notes: JSON.parse(b64decode(j.content) || '{}'), sha: j.sha };
}

// Apply `changes` ({teamId: text}) on top of the latest remote file and commit it. Retries on a write race.
async function writeNotes(changes, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { notes, sha } = await readRemoteNotes();
    for (const [id, text] of Object.entries(changes)) {
      if (text.trim()) notes[id] = { text, updated: Date.now() }; else delete notes[id];
    }
    const body = { message, content: b64encode(JSON.stringify(notes, null, 2) + '\n'), branch: 'main' };
    if (sha) body.sha = sha;
    const res = await fetch(NOTES_API, { method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { setSharedNotes(notes); return; }
    if (res.status === 401 || res.status === 403) throw new Error('auth');
    if (res.status !== 409 && res.status !== 422) throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('conflict');
}

// Our league's other teams, ordered by when we next meet them.
function notesTeams() {
  if (!ourTeam) return [];
  const nextVs = {};
  for (const g of gamesOf(ourTeam.id)) {
    const opp = teamIdOf(g, other(sideOf(g, ourTeam.id)));
    if (opp && !isFinished(g) && !nextVs[opp]) nextVs[opp] = g;
  }
  return data.teams
    .filter(t => t.league_id === ourTeam.league_id && t.id !== ourTeam.id && isApproved(t))
    .map(t => ({ team: t, next: nextVs[t.id] || null }))
    .sort((a, b) => (a.next ? 0 : 1) - (b.next ? 0 : 1) || (a.next && b.next ? gameSort(a.next, b.next) : 0)
      || a.team.name.localeCompare(b.team.name, 'he'));
}

function viewNotes() {
  const items = notesTeams();
  const edit = canEdit();
  let html = `<h1 class="page-title">הערות על היריבות</h1>
    <p class="page-sub">ההערות גלויות לכל מי שנכנס לאתר, ומופיעות גם בעמוד של כל קבוצה.${edit ? ' שינויים נשמרים אוטומטית לכולם.' : ''}</p>`;
  if (!items.length) return html + `<div class="empty">אין קבוצות להצגה.</div>`;
  for (const { team, next } of items) {
    const note = noteFor(team.id);
    if (!edit && !note) continue;
    html += `<div class="note-card" id="note-${esc(team.id)}">
      <div class="note-head">${dot(team)}<a class="team-link" href="#/team/${esc(team.id)}">${esc(team.name)}</a>${playersParen(team)}</div>
      <div class="note-meta">${next ? `המשחק הבא מולם: ${fmtDate(next.date)}${next.time ? ` · ${esc(next.time)}` : ''}` : 'אין משחק קרוב מולם'}</div>
      ${edit
        ? `<textarea class="note-text" data-team="${esc(team.id)}" rows="3" placeholder="למשל: מי חזק בהגשה, איך הם מגנים, למה לשים לב…">${esc(note)}</textarea>
           <div class="note-status" data-status="${esc(team.id)}"></div>`
        : `<div class="note-body">${esc(note)}</div>`}
    </div>`;
  }
  if (!edit && !items.some(i => noteFor(i.team.id))) html += `<div class="empty">עדיין אין הערות.</div>`;
  html += `<div class="note-backup">${edit
    ? `<span class="muted">✏️ מצב עריכה פעיל במכשיר הזה</span><button class="btn btn-ghost" onclick="logoutEditor()">יציאה ממצב עריכה</button>`
    : `<button class="btn btn-ghost" onclick="loginEditor()">🔑 כניסה לעריכה</button><small>עריכה דורשת מפתח עריכה (GitHub token) של מנהל האתר.</small>`}</div>`;
  return html;
}

async function loginEditor() {
  const t = (prompt('הדביקו את מפתח העריכה (GitHub token):') || '').trim();
  if (!t) return;
  try { localStorage.setItem(TOKEN_KEY, t); } catch { alert('לא ניתן לשמור במכשיר הזה'); return; }
  try {
    await readRemoteNotes();
    await migrateLocalNotes();
    render();
  } catch (e) {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
    alert(e.message === 'auth' ? 'המפתח לא תקין או שאין לו הרשאת עריכה לריפו' : 'לא הצלחנו להתחבר ל-GitHub, נסו שוב');
  }
}
function logoutEditor() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  render();
}
window.loginEditor = loginEditor;
window.logoutEditor = logoutEditor;

// Notes written before sharing existed lived only on this device: upload any the shared file lacks.
async function migrateLocalNotes() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem(OLD_LOCAL_NOTES_KEY)); } catch { /* ignore */ }
  if (!old) return;
  const { notes } = await readRemoteNotes();
  const changes = {};
  for (const [id, n] of Object.entries(old)) if (n && n.text && !(notes[id] && notes[id].text)) changes[id] = n.text;
  if (Object.keys(changes).length) await writeNotes(changes, 'notes: upload notes saved on device');
  try { localStorage.removeItem(OLD_LOCAL_NOTES_KEY); } catch { /* ignore */ }
}

const noteTimers = {};
const pendingNotes = {};
function setNoteStatus(id, text) {
  const st = document.querySelector(`[data-status="${CSS.escape(id)}"]`);
  if (st) st.textContent = text;
}
async function flushNote(id) {
  clearTimeout(noteTimers[id]);
  if (!(id in pendingNotes)) return;
  const text = pendingNotes[id];
  delete pendingNotes[id];
  setNoteStatus(id, 'שומר…');
  const name = (teamById(id) || {}).name || id;
  try {
    await writeNotes({ [id]: text }, `notes: ${name}`);
    setNoteStatus(id, id in pendingNotes ? 'שומר…' : 'נשמר לכולם ✓');
  } catch (e) {
    pendingNotes[id] ??= text; // keep it so the next edit or blur retries
    setNoteStatus(id, e.message === 'auth' ? 'אין הרשאה לשמור – בדקו את מפתח העריכה' : 'השמירה נכשלה – ננסה שוב בעריכה הבאה');
  }
}
document.addEventListener('input', e => {
  const ta = e.target.closest && e.target.closest('textarea.note-text');
  if (!ta) return;
  const id = ta.dataset.team;
  pendingNotes[id] = ta.value;
  setNoteStatus(id, 'ממתין לשמירה…');
  clearTimeout(noteTimers[id]);
  noteTimers[id] = setTimeout(() => flushNote(id), 1500);
});
document.addEventListener('focusout', e => {
  const ta = e.target.closest && e.target.closest('textarea.note-text');
  if (ta) flushNote(ta.dataset.team);
});
window.addEventListener('pagehide', () => Object.keys(pendingNotes).forEach(flushNote));

const TABS = [
  { id: 'home', href: '#/', label: 'בית', icon: '🏠' },
  { id: 'standings', href: '#/standings', label: 'טבלאות', icon: '🏆' },
  { id: 'schedule', href: '#/schedule', label: 'לוח משחקים', icon: '📅' },
  { id: 'teams', href: '#/teams', label: 'קבוצות', icon: '👥' },
  { id: 'notes', href: '#/notes', label: 'הערות', icon: '📝' },
];

function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/team\/([\w-]+)/))) return { tab: null, html: () => viewTeam(m[1]) };
  if (h.startsWith('#/standings')) return { tab: 'standings', html: viewStandings };
  if ((m = h.match(/^#\/schedule(?:\/([\w]+))?/))) return { tab: 'schedule', html: () => viewSchedule(m[1]) };
  if (h.startsWith('#/teams')) return { tab: 'teams', html: viewTeams };
  if (h.startsWith('#/notes')) return { tab: 'notes', html: viewNotes };
  return { tab: 'home', html: viewHome };
}

function renderTabs(active) {
  document.getElementById('tabs').innerHTML =
    TABS.map(t =>
      `<a href="${t.href}" class="${t.id === active ? 'on' : ''}" onclick="setMenu(false)"><span class="tab-icon" aria-hidden="true">${t.icon}</span><span>${t.label}</span></a>`).join('')
    + `<div class="theme-pick"><span>מצב תצוגה</span><div class="seg">${THEMES.map(([id, label]) =>
      `<button class="${currentTheme() === id ? 'on' : ''}" onclick="setTheme('${id}')">${label}</button>`).join('')}</div></div>`;
}

// ---- Theme (auto = follow the phone) -----------------------------------
const THEME_KEY = 'fl-theme';
const THEMES = [['auto', 'אוטומטי'], ['light', '☀️ בהיר'], ['dark', '🌙 כהה']];
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
function setTheme(t) {
  try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* storage unavailable */ }
  applyTheme(t);
  renderTabs(route().tab);
}
window.setTheme = setTheme;

// The header (with the ☰/✕ toggle) stays above the open menu, so the same button always closes it.
function setMenu(open) {
  const btn = document.getElementById('menu-btn');
  document.documentElement.style.setProperty('--hdr', document.querySelector('.topbar').offsetHeight + 'px');
  document.body.classList.toggle('menu-open', open);
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '✕' : '☰';
}
window.setMenu = setMenu;

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
  // Team pages get a back button in the sticky header, so it is visible at any scroll position.
  document.getElementById('head-back').hidden = r.tab !== null;
  app.innerHTML = (loadError ? `<div class="warn">מוצגים נתונים שמורים – אין חיבור לאתר הליגה כרגע.</div>` : '')
    + r.html();
  updateFooter();
}

function updateFooter() {
  document.getElementById('updated').textContent =
    `גרסה ${APP_VERSION} · עודכן ${new Date(data.fetchedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
}

// Navigation. In-app links switch pages with pushState instead of letting the browser follow the
// #hash itself: on iPhone the browser's own hash navigation left new pages scrolled down.
// New pages open at the top; back/forward (incl. "חזרה") returns to where you were.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const scrollPos = {};
let lastY = 0;
let shownHash = location.hash || '#/';
window.addEventListener('scroll', () => { lastY = window.scrollY; }, { passive: true });
function scrollToY(y) {
  const go = () => { window.scrollTo(0, y); document.documentElement.scrollTop = y; document.body.scrollTop = y; };
  go();
  requestAnimationFrame(go);
  setTimeout(go, 50);
  setTimeout(go, 150);
}
function showPage(restore) {
  const h = location.hash || '#/';
  if (h === shownHash) return;
  scrollPos[shownHash] = lastY;
  shownHash = h;
  setMenu(false);
  render();
  const m = h.match(/^#\/notes\/([\w-]+)/), card = m && document.getElementById('note-' + m[1]);
  if (card) {
    scrollToY(Math.max(0, card.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar').offsetHeight - 12));
    const ta = card.querySelector('textarea');
    if (ta) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  } else scrollToY(restore ? scrollPos[h] || 0 : 0);
}
function navigate(href) {
  try { sessionStorage.setItem('fl-nav', '1'); } catch { /* storage unavailable */ }
  if ((location.hash || '#/') !== href) history.pushState(null, '', href);
  showPage(false);
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  setMenu(false);
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', () => showPage(true));
// Fallback for hash changes that don't come through navigate() (e.g. typed URLs).
window.addEventListener('hashchange', () => showPage(false));
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('menu-btn').addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
const scrim = document.getElementById('scrim');
scrim.addEventListener('click', () => setMenu(false));
scrim.addEventListener('touchend', e => { e.preventDefault(); setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
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
