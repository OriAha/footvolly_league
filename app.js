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
};

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

async function loadData() {
  const [games, teams, leagues] = await Promise.all([
    fetchEntity(SOURCES.games), fetchEntity(SOURCES.teams), fetchEntity(SOURCES.leagues),
  ]);
  return { games, teams: teams.map(slimTeam), leagues, fetchedAt: Date.now() };
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
            <div class="game-opp">${dot(opp)}<span>נגד <strong>${esc(teamName(g, os))}</strong></span></div>
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
    <a class="back" href="#/">→ חזרה ללוח שלנו</a>
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

// ---- Render / routing ---------------------------------------------------
function render() {
  const app = document.getElementById('app');
  if (!data) {
    app.innerHTML = loadError
      ? `<div class="empty">לא הצלחנו לטעון את נתוני הליגה (${esc(loadError.message)}).<br><button class="btn" onclick="refresh()">נסו שוב</button></div>`
      : `<div class="loading">טוען נתונים מהליגה…</div>`;
    return;
  }
  const m = location.hash.match(/^#\/team\/([\w-]+)/);
  app.innerHTML = (loadError ? `<div class="warn">מוצגים נתונים שמורים – אין חיבור לאתר הליגה כרגע.</div>` : '')
    + (m ? viewTeam(m[1]) : viewHome());
  const upd = document.getElementById('updated');
  upd.textContent = `עודכן ${new Date(data.fetchedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
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
