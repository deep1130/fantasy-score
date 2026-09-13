const APP_VERSION = 'v1.3.8';
const API = 'https://api.sleeper.app/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const defaults = { pollSeconds: 60, trackOpponent: true, voice: false, volume: .8, kokoroVoice: 'bf_emma', voiceRate: 1, voiceMinPoints: 1, gameWindow: false, wake: false, excludedLeagues: [] };
const pollLabel = sec => { const n = Number(sec) || 60; if (n < 60) return `${n}s`; if (n % 60 === 0) return `${n / 60}m`; return `${Math.floor(n / 60)}m ${n % 60}s`; };
const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const fmt = value => Number(value || 0).toFixed(2).replace(/\.00$/, '');
function dedupeTicker(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    if (item.play === 'Turnover / point loss') return false;
    const key = `${item.leagueId || ''}|${item.rosterId || ''}|${item.player}|${item.team}|${fmt(item.delta)}|${fmt(item.playerTotal)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const state = { user: null, nfl: null, leagues: [], selectedLeague: null, matchup: null, allMatchups: [], leagueData: {}, players: {}, stats: {}, projections: {}, espnStats: {}, playerGames: {}, leagueUsers: [], leagueUsersCache: {}, ticker: dedupeTicker(readStorage('fantasy-score-ticker', readStorage('fantasy-score-dashboard-cache', {})?.ticker || [])), lastUpdated: null, error: '', loading: false, wakeLock: null };
const savedSettings = readStorage('fantasy-score-settings', {});
let settings = { ...defaults, ...savedSettings };
let pollTimer;
const $ = id => document.getElementById(id);
const saveSettings = () => localStorage.setItem('fantasy-score-settings', JSON.stringify(settings));
if (Number(savedSettings.settingsVersion || 0) < 2) { settings.voice = false; settings.settingsVersion = 2; saveSettings(); }
if (Number(savedSettings.settingsVersion || 0) < 3) { if (!savedSettings.pollSeconds || savedSettings.pollSeconds === 120) { settings.pollSeconds = 60; } settings.settingsVersion = 3; saveSettings(); }
if (Number(savedSettings.settingsVersion || 0) < 4) { settings.gameWindow = false; settings.settingsVersion = 4; saveSettings(); }
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
const api = async (path, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API}${path}${sep}_t=${Date.now()}`;
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Sleeper API returned ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};
async function ensurePlayersLoaded() {
  if (state.players && Object.keys(state.players).length > 0) return state.players;
  try {
    state.players = await api('/players/nfl', 30000) || {};
  } catch (err) {
    console.warn('Failed to load NFL players catalog:', err);
  }
  return state.players;
}
const time = value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const inGameWindow = () => {
  if (!settings.gameWindow) return true;
  if (state.playerGames && Object.values(state.playerGames).some(g => !/final|scheduled/i.test(g.status || ''))) return true;
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 4 && hour >= 23) return true;
  if (day === 5 && hour < 5) return true;
  if (day === 0 && hour >= 13) return true;
  if (day === 1 && hour < 5) return true;
  if (day === 1 && hour >= 23) return true;
  if (day === 2 && hour < 5) return true;
  if (day === 6 && hour >= 16) return true;
  return false;
};

function setupView() {
  $('app').innerHTML = `<main class="setup"><div class="brand"><div class="brand-mark">FS</div><div><div class="eyebrow">Sleeper live desk</div><h1>Fantasy Score</h1></div></div><h2>Your matchup, in motion.</h2><p>Connect a Sleeper username to follow active leagues, live player points, NFL games, and score swings from one focused view.</p><form class="setup-form" id="username-form"><input id="username" type="text" autocomplete="username" placeholder="Sleeper username" required><button class="btn primary">Connect</button></form>${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}</main>`;
  $('username-form').addEventListener('submit', event => { event.preventDefault(); connect($('username').value.trim()); });
}
function loadingView(username) {
  $('app').innerHTML = `<main class="setup"><div class="brand"><div class="brand-mark">FS</div><div><div class="eyebrow">Sleeper live desk</div><h1>Fantasy Score</h1></div></div><h2>Loading live desk...</h2><p>Connecting to Sleeper for <strong>${esc(username)}</strong>...</p></main>`;
}
function renderAllMatchups() { if (!state.allMatchups || !state.allMatchups.length) return '<div class="empty">No league matchups available for this week.</div>'; return `<div class="league-list">${state.allMatchups.map(item => `<div class="matchup-row ${item.mine ? 'active' : ''}"><div class="row-top"><span>${item.mine ? 'YOUR MATCHUP' : 'MATCHUP ' + item.id}</span><span>${item.count} rosters</span></div><div class="row-score"><span>${esc(item.a)}</span><span>${fmt(item.scoreA)} · ${fmt(item.scoreB)}</span><span>${esc(item.b)}</span></div></div>`).join('')}</div>`; }
function formatPlayerName(player) {
  if (!player || !player.full_name) return { full: 'Empty slot', short: 'Empty' };
  const full = player.full_name;
  const first = player.first_name || '';
  const last = player.last_name || '';
  const short = (first && last) ? `${first[0]}. ${last}` : full;
  return { full, short };
}

function compactStatSummary(stats, points = null, isDef = false) {
  if (!stats || !Object.keys(stats).length) {
    return Number(points) === 0 ? 'No stats' : '';
  }
  const parts = [];
  const totalTd = (Number(stats.pass_td) || 0) + (Number(stats.rush_td) || 0) + (Number(stats.rec_td) || 0) + (Number(stats.def_td) || 0) + (Number(stats.ret_td) || 0);
  if (totalTd > 0) parts.push(`${totalTd} TD`);
  if (Number(stats.pass_yd)) parts.push(`${stats.pass_yd} pYd`);
  if (Number(stats.rush_yd)) parts.push(`${stats.rush_yd} rYd`);
  if (Number(stats.rec_yd)) parts.push(`${stats.rec_yd} recYd`);
  else if (Number(stats.rec)) parts.push(`${stats.rec} rec`);
  if (Number(stats.fgm)) parts.push(`${stats.fgm} FG`);
  if (Number(stats.sack)) parts.push(`${stats.sack} sk`);
  if (isDef && Number(stats.def_int)) parts.push(`${stats.def_int} INT`);
  if (isDef && Number(stats.fum_rec)) parts.push(`${stats.fum_rec} FR`);
  const turnovers = [];
  if (!isDef && Number(stats.pass_int)) turnovers.push(`${stats.pass_int} INT`);
  if (!isDef && Number(stats.fum_lost)) turnovers.push(`${stats.fum_lost} FL`);
  const mainStats = parts.slice(0, 2);
  const combined = [...mainStats, ...turnovers];
  if (combined.length) return combined.slice(0, 3).join(' · ');
  return Number(points) === 0 ? 'No stats' : '';
}

function fullStatBreakdown(id, points = null) {
  if (!id || id === '0') return '<div class="detail-empty">No player in slot</div>';
  const stats = playerStats(id);
  if (!stats || !Object.keys(stats).length) {
    return `<div class="detail-empty">${Number(points) === 0 ? 'No stats recorded yet' : 'Live stats pending'}</div>`;
  }
  const isDef = ((state.players && state.players[id]) || {}).position === 'DEF';
  const lines = [];
  if (stats.pass_att || stats.pass_yd || stats.pass_td || stats.pass_int) {
    const cmp = stats.pass_cmp !== undefined ? `${stats.pass_cmp}/` : '';
    const att = stats.pass_att ? `${cmp}${stats.pass_att} att, ` : '';
    const yds = `${stats.pass_yd || 0} yds`;
    const td = stats.pass_td ? `, ${stats.pass_td} TD` : '';
    const int = stats.pass_int ? `, ${stats.pass_int} INT` : '';
    lines.push(`<strong>Pass:</strong> ${att}${yds}${td}${int}`);
  }
  if (stats.rush_att || stats.rush_yd || stats.rush_td) {
    const att = stats.rush_att ? `${stats.rush_att} car, ` : '';
    const yds = stats.rush_yd ? `${stats.rush_yd} yds` : stats.rush_att ? '0 yds' : '';
    const td = stats.rush_td ? `, ${stats.rush_td} TD` : '';
    lines.push(`<strong>Rush:</strong> ${att}${yds}${td}`);
  }
  if (stats.rec || stats.rec_yd || stats.rec_td || stats.rec_tgt) {
    const rec = stats.rec ? `${stats.rec} rec` : '';
    const tgt = stats.rec_tgt ? ` (${stats.rec_tgt} tgts)` : '';
    const yds = stats.rec_yd ? `, ${stats.rec_yd} yds` : '';
    const td = stats.rec_td ? `, ${stats.rec_td} TD` : '';
    lines.push(`<strong>Rec:</strong> ${rec}${tgt}${yds}${td}`.replace(/^<strong>Rec:<\/strong> , /, '<strong>Rec:</strong> '));
  }
  if (!isDef && (stats.fum_lost || stats.fum)) {
    const fl = stats.fum_lost ? `${stats.fum_lost} fum lost` : '';
    const fTotal = stats.fum && stats.fum > (stats.fum_lost || 0) ? ` (${stats.fum} fumbles)` : '';
    lines.push(`<strong>Turnovers:</strong> ${fl}${fTotal}`);
  }
  if (stats.fgm !== undefined || stats.fga !== undefined || stats.xpm !== undefined) {
    const fg = stats.fgm !== undefined ? `${stats.fgm}/${stats.fga || stats.fgm} FG` : '';
    const xp = stats.xpm !== undefined ? `, ${stats.xpm} XP` : '';
    lines.push(`<strong>Kick:</strong> ${fg}${xp}`);
  }
  if (isDef && (stats.sack || stats.def_int || stats.fum_rec || stats.def_td || stats.def_safety || stats.pts_allowed !== undefined)) {
    const s = [];
    if (stats.sack) s.push(`${stats.sack} sk`);
    if (stats.def_int) s.push(`${stats.def_int} INT`);
    if (stats.fum_rec) s.push(`${stats.fum_rec} FR`);
    if (stats.def_safety) s.push(`${stats.def_safety} safety`);
    if (stats.def_td) s.push(`${stats.def_td} TD`);
    if (stats.pts_allowed !== undefined) s.push(`${stats.pts_allowed} PA`);
    lines.push(`<strong>Def:</strong> ${s.join(', ')}`);
  }
  if (!lines.length) {
    const fallback = statSummary(stats, points);
    return `<div class="detail-stat">${fallback}</div>`;
  }
  return lines.map(l => `<div class="detail-stat">${l}</div>`).join('');
}

function playerSubText(id, points) {
  if (!id || id === '0') return 'No player set';
  const player = (state.players && state.players[id]) || {};
  const isDef = player.position === 'DEF';
  const game = state.playerGames[normalizeTeam(player.team)];
  const status = game?.status || '';
  const stats = compactStatSummary(playerStats(id), points, isDef);
  if (/final|post/i.test(status)) {
    return stats ? `Final · ${stats}` : `Final`;
  }
  if (/in|qtr|half|live|\d+:\d+/i.test(status)) {
    return stats ? `${status} · ${stats}` : status;
  }
  const proj = projectionPoints(id);
  if (proj !== null && Number(points || 0) === 0) {
    return `${game?.status || 'Scheduled'} · Proj ${fmt(proj)}`;
  }
  return game?.status || (proj !== null ? `Proj ${fmt(proj)}` : '-');
}

function getSlotPosition(index, myPlayer, oppPlayer) {
  const positions = state.selectedLeague?.roster_positions ? state.selectedLeague.roster_positions.filter(p => p !== 'BN') : [];
  if (positions[index]) {
    const raw = positions[index];
    if (raw === 'SUPER_FLEX') return 'SF';
    if (raw === 'FLEX') return 'FLX';
    return raw;
  }
  if (myPlayer?.position && oppPlayer?.position && myPlayer.position !== oppPlayer.position) {
    return 'FLX';
  }
  return myPlayer?.position || oppPlayer?.position || 'FLX';
}

function renderMatchup(expandedSlots = new Set()) {
  const team = state.matchup?.you || { starters: [], points: {}, deltas: {} };
  const opponent = state.matchup?.opponent || { starters: [], points: {}, deltas: {} };
  const teamName = matchupTeamLabel(team);
  const opponentName = matchupTeamLabel(opponent);
  const teamProjection = projectedTotal(team);
  const opponentProjection = projectedTotal(opponent);

  const totalSlots = Math.max(team.starters?.length || 0, opponent.starters?.length || 0);
  const slots = [];

  for (let i = 0; i < totalSlots; i++) {
    const myId = team.starters?.[i];
    const oppId = opponent.starters?.[i];
    const isMyEmpty = !myId || myId === '0';
    const isOppEmpty = !oppId || oppId === '0';

    const myPlayer = (isMyEmpty || !state.players) ? null : (state.players[myId] || {});
    const oppPlayer = (isOppEmpty || !state.players) ? null : (state.players[oppId] || {});

    const myName = formatPlayerName(myPlayer);
    const oppName = formatPlayerName(oppPlayer);

    const pos = getSlotPosition(i, myPlayer, oppPlayer);
    const posClass = `pos-${pos.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    const myPoints = isMyEmpty ? 0 : Number(team.points[myId] || 0);
    const oppPoints = isOppEmpty ? 0 : Number(opponent.points[oppId] || 0);

    const myProj = isMyEmpty ? null : projectionPoints(myId);
    const oppProj = isOppEmpty ? null : projectionPoints(oppId);

    const myDelta = isMyEmpty ? 0 : (team.deltas[myId] || 0);
    const oppDelta = isOppEmpty ? 0 : (opponent.deltas[oppId] || 0);

    const mySub = isMyEmpty ? 'Empty slot' : playerSubText(myId, myPoints);
    const oppSub = isOppEmpty ? 'Empty slot' : playerSubText(oppId, oppPoints);

    const slotKey = `${state.selectedLeague?.league_id || ''}:${pos}:${i}`;
    const isExpanded = expandedSlots.has(slotKey);
    const hoverTitle = `${myName.full} (${isMyEmpty ? '-' : fmt(myPoints)} pts) vs ${oppName.full} (${isOppEmpty ? '-' : fmt(oppPoints)} pts) - Tap to expand details`;

    slots.push(`
      <div class="slot-row ${isExpanded ? 'is-expanded' : ''}" data-slot-row data-slot-key="${esc(slotKey)}" tabindex="0" role="button" aria-expanded="${isExpanded ? 'true' : 'false'}" title="${esc(hoverTitle)}">
        <div class="slot-summary">
          <div class="slot-col is-mine ${isMyEmpty ? 'is-empty' : ''}">
            <div class="player-block">
              <div class="player-top">
                <span class="player-name">
                  <span class="name-full">${esc(myName.full)}</span>
                  <span class="name-short">${esc(myName.short)}</span>
                </span>
                ${myPlayer?.team ? `<span class="team-tag">${esc(myPlayer.team)}</span>` : ''}
              </div>
              <div class="player-sub">${esc(mySub)}</div>
            </div>
            <div class="player-score-block">
              <span class="score-pts">${isMyEmpty ? '-' : fmt(myPoints)}</span>
              ${myDelta > 0 ? `<span class="score-delta">+${fmt(myDelta)}</span>` : myDelta < 0 ? `<span class="score-delta negative">${fmt(myDelta)}</span>` : ''}
            </div>
          </div>

          <div class="slot-pos">
            <span class="pos-badge ${posClass}">${esc(pos)}</span>
          </div>

          <div class="slot-col is-opponent ${isOppEmpty ? 'is-empty' : ''}">
            <div class="player-score-block">
              <span class="score-pts">${isOppEmpty ? '-' : fmt(oppPoints)}</span>
              ${oppDelta > 0 ? `<span class="score-delta">+${fmt(oppDelta)}</span>` : oppDelta < 0 ? `<span class="score-delta negative">${fmt(oppDelta)}</span>` : ''}
            </div>
            <div class="player-block">
              <div class="player-top">
                ${oppPlayer?.team ? `<span class="team-tag">${esc(oppPlayer.team)}</span>` : ''}
                <span class="player-name">
                  <span class="name-full">${esc(oppName.full)}</span>
                  <span class="name-short">${esc(oppName.short)}</span>
                </span>
              </div>
              <div class="player-sub">${esc(oppSub)}</div>
            </div>
          </div>
        </div>

        <div class="slot-detail-drawer" aria-hidden="${isExpanded ? 'false' : 'true'}">
          <div class="detail-col is-mine">
            <div class="detail-header">
              <strong>${esc(myName.full)}</strong>
              <span class="detail-meta">${esc(myPlayer?.team || 'FA')} · ${esc(myPlayer?.position || pos)}</span>
            </div>
            <div class="detail-game">${esc(myId ? playerGame(myId) : 'No game')}</div>
            <div class="detail-stats">${fullStatBreakdown(myId, myPoints)}</div>
            <div class="detail-footer">
              <span>Actual: <strong>${isMyEmpty ? '0.00' : fmt(myPoints)}</strong></span>
              ${myProj !== null ? `<span>Proj: <strong>${fmt(myProj)}</strong></span>` : ''}
              ${myDelta > 0 ? `<span class="delta">+${fmt(myDelta)}</span>` : ''}
            </div>
          </div>

          <div class="detail-sep"></div>

          <div class="detail-col is-opponent">
            <div class="detail-header">
              <strong>${esc(oppName.full)}</strong>
              <span class="detail-meta">${esc(oppPlayer?.team || 'FA')} · ${esc(oppPlayer?.position || pos)}</span>
            </div>
            <div class="detail-game">${esc(oppId ? playerGame(oppId) : 'No game')}</div>
            <div class="detail-stats">${fullStatBreakdown(oppId, oppPoints)}</div>
            <div class="detail-footer">
              <span>Actual: <strong>${isOppEmpty ? '0.00' : fmt(oppPoints)}</strong></span>
              ${oppProj !== null ? `<span>Proj: <strong>${fmt(oppProj)}</strong></span>` : ''}
              ${oppDelta > 0 ? `<span class="delta">+${fmt(oppDelta)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>
    `);
  }

  return `
    <section class="matchup-card">
      <div class="matchup-head">
        <div>
          <div class="eyebrow">${esc(state.selectedLeague?.name || 'Matchup')}</div>
          <h2>Head-to-head</h2>
        </div>
        <div class="week-badge">WEEK ${esc(state.nfl?.week || '')}</div>
      </div>

      <div class="scoreboard">
        <div class="score-team you">
          <div class="team-label">${esc(teamName)} <span class="badge-you">YOU</span></div>
          <div class="score">${fmt(team.total)}</div>
          ${teamProjection === null ? '' : `<div class="score-projected">Est. ${fmt(teamProjection)}</div>`}
        </div>
        <div class="score-vs-box">
          <span class="score-vs">VS</span>
          <span class="score-status-pill">WK ${esc(state.nfl?.week || '')}</span>
        </div>
        <div class="score-team opponent">
          <div class="team-label">${esc(opponentName)}</div>
          <div class="score">${fmt(opponent.total)}</div>
          ${opponentProjection === null ? '' : `<div class="score-projected">Est. ${fmt(opponentProjection)}</div>`}
        </div>
      </div>

      <div class="matchup-slots">
        <div class="matchup-slots-hint">Tap any matchup to view stat splits</div>
        <div class="slots-header">
          <div class="header-team is-mine">
            <span class="header-team-name">${esc(teamName)}</span>
          </div>
          <div class="header-pos">POS</div>
          <div class="header-team is-opponent">
            <span class="header-team-name">${esc(opponentName)}</span>
          </div>
        </div>
        ${slots.join('') || '<div class="empty">No starters listed.</div>'}
      </div>
    </section>
  `;
}
const normalizeName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizeTeam = value => ({ SFO: 'SF', GBP: 'GB', KCC: 'KC', LAC: 'LAC', LAR: 'LAR', JAX: 'JAX', NOS: 'NO', TBB: 'TB', NEP: 'NE', SDO: 'SD' }[String(value || '').toUpperCase()] || String(value || '').toUpperCase());
function mergeEspnStatGroup(target, group) {
  const labels = (group.labels || []).map(label => String(label).toUpperCase());
  (group.athletes || []).forEach(entry => {
    const key = `${normalizeName(entry.athlete?.fullName || entry.athlete?.displayName)}|${normalizeTeam(group.team?.abbreviation)}`;
    const stats = target[key] || {};
    (entry.stats || []).forEach((value, index) => {
      const label = labels[index];
      const number = Number(String(value).replace(/[^0-9.-]/g, ''));
      if (group.name === 'rushing') {
        if (label === 'CAR' && Number.isFinite(number)) stats.rush_att = number;
        if (label === 'YDS' && Number.isFinite(number)) stats.rush_yd = number;
        if (label === 'TD' && Number.isFinite(number)) stats.rush_td = number;
      }
      if (group.name === 'receiving') {
        if (label === 'REC' && Number.isFinite(number)) stats.rec = number;
        if (label === 'YDS' && Number.isFinite(number)) stats.rec_yd = number;
        if (label === 'TD' && Number.isFinite(number)) stats.rec_td = number;
        if (label === 'TGTS' && Number.isFinite(number)) stats.rec_tgt = number;
      }
      if (group.name === 'passing') {
        if (label === 'C/ATT') {
          const parts = String(value).split('/');
          if (parts.length === 2) {
            const cmp = Number(parts[0]), att = Number(parts[1]);
            if (Number.isFinite(cmp)) stats.pass_cmp = cmp;
            if (Number.isFinite(att)) stats.pass_att = att;
          }
        }
        if (label === 'YDS' && Number.isFinite(number)) stats.pass_yd = number;
        if (label === 'TD' && Number.isFinite(number)) stats.pass_td = number;
        if (label === 'INT' && Number.isFinite(number)) stats.pass_int = number;
      }
      if (group.name === 'kicking') {
        if (label === 'FG') {
          const parts = String(value).split('/');
          if (parts.length === 2) {
            const fgm = Number(parts[0]), fga = Number(parts[1]);
            if (Number.isFinite(fgm)) stats.fgm = fgm;
            if (Number.isFinite(fga)) stats.fga = fga;
          }
        }
        if (label === 'XP') {
          const parts = String(value).split('/');
          if (parts.length >= 1) {
            const xpm = Number(parts[0]);
            if (Number.isFinite(xpm)) stats.xpm = xpm;
          }
        }
      }
      if (group.name === 'defensive') {
        if (label === 'SACKS' && Number.isFinite(number)) stats.sack = number;
        if (label === 'TD' && Number.isFinite(number)) stats.def_td = number;
      }
      if (group.name === 'interceptions' && label === 'INT' && Number.isFinite(number)) {
        stats.def_int = (stats.def_int || 0) + number;
      }
      if (group.name === 'fumbles') {
        if (label === 'LOST' && Number.isFinite(number)) stats.fum_lost = (stats.fum_lost || 0) + number;
      }
    });
    target[key] = stats;
  });
}
async function loadEspnStats() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const board = await fetch(`${ESPN}?_t=${Date.now()}`, { cache: 'no-store', signal: controller.signal }).then(response => response.json()).finally(() => clearTimeout(timeout));
    const games = {};
    (board.events || []).forEach(event => {
      const competition = event.competitions?.[0];
      const teams = competition?.competitors || [];
      const home = teams.find(team => team.homeAway === 'home');
      const away = teams.find(team => team.homeAway === 'away');
      const status = competition?.status?.type?.shortDetail || competition?.status?.type?.detail || 'Scheduled';
      if (home?.team?.abbreviation && away?.team?.abbreviation) {
        games[normalizeTeam(home.team.abbreviation)] = { context: `vs ${normalizeTeam(away.team.abbreviation)}`, status };
        games[normalizeTeam(away.team.abbreviation)] = { context: `@ ${normalizeTeam(home.team.abbreviation)}`, status };
      }
    });
    const events = (board.events || []).filter(event => event.status?.type?.state !== 'pre');
    const summaries = await Promise.all(events.map(event => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 5000);
      return fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${event.id}&_t=${Date.now()}`, { cache: 'no-store', signal: c.signal })
        .then(response => response.ok ? response.json() : null)
        .catch(() => null)
        .finally(() => clearTimeout(t));
    }));
    const result = {};
    summaries.filter(Boolean).forEach(summary => {
      (summary.boxscore?.players || []).forEach(team => (team.statistics || []).forEach(group => {
        group.team = team.team;
        mergeEspnStatGroup(result, group);
      }));
      const competitors = summary.header?.competitions?.[0]?.competitors || [];
      (summary.boxscore?.teams || []).forEach(t => {
        const teamAbbr = normalizeTeam(t.team?.abbreviation);
        if (!teamAbbr) return;
        const opp = competitors.find(c => normalizeTeam(c.team?.abbreviation) !== teamAbbr);
        const ptsAllowed = opp ? Number(opp.score || 0) : undefined;
        const stats = result[`def|${teamAbbr}`] || {};
        if (ptsAllowed !== undefined) stats.pts_allowed = ptsAllowed;
        (t.statistics || []).forEach(s => {
          if (s.name === 'sacksYardsLost') {
            const sacks = Number(String(s.displayValue || '').split('-')[0]);
            if (Number.isFinite(sacks)) stats.sack = sacks;
          }
          if (s.name === 'defensiveTouchdowns') {
            const td = Number(s.displayValue);
            if (Number.isFinite(td)) stats.def_td = td;
          }
          if (s.name === 'interceptions') {
            const int = Number(s.displayValue);
            if (Number.isFinite(int)) stats.def_int = int;
          }
          if (s.name === 'fumblesRecovered') {
            const fr = Number(s.displayValue);
            if (Number.isFinite(fr)) stats.fum_rec = fr;
          }
          if (s.name === 'safeties') {
            const saf = Number(s.displayValue);
            if (Number.isFinite(saf)) stats.def_safety = saf;
          }
        });
        result[`def|${teamAbbr}`] = stats;
      });
    });
    state.playerGames = games;
    return result;
  } catch (error) {
    console.warn('ESPN stat fallback unavailable', error);
    state.playerGames = {};
    return {};
  }
}
function playerStats(id) {
  const sleeperStats = state.stats[id] || {};
  const player = (state.players && state.players[id]) || {};
  const name = normalizeName(player.full_name);
  const team = normalizeTeam(player.team || id);
  let espn = {};
  if (player.position === 'DEF' || !name) {
    espn = state.espnStats[`def|${team}`] || {};
  } else {
    espn = state.espnStats[`${name}|${team}`];
    if (!espn) {
      const match = Object.entries(state.espnStats).find(([key]) => {
        const [espnName, espnTeam] = key.split('|');
        return espnTeam === team && (espnName.startsWith(name) || name.startsWith(espnName));
      });
      espn = match?.[1] || {};
    }
  }
  if (!Object.keys(sleeperStats).length) return espn;
  if (!Object.keys(espn).length) return sleeperStats;
  return {
    ...espn,
    ...sleeperStats,
    rush_yd: Math.max(Number(sleeperStats.rush_yd || 0), Number(espn.rush_yd || 0)),
    rush_att: Math.max(Number(sleeperStats.rush_att || 0), Number(espn.rush_att || 0)),
    rush_td: Math.max(Number(sleeperStats.rush_td || 0), Number(espn.rush_td || 0)),
    rec: Math.max(Number(sleeperStats.rec || 0), Number(espn.rec || 0)),
    rec_yd: Math.max(Number(sleeperStats.rec_yd || 0), Number(espn.rec_yd || 0)),
    rec_td: Math.max(Number(sleeperStats.rec_td || 0), Number(espn.rec_td || 0)),
    pass_yd: Math.max(Number(sleeperStats.pass_yd || 0), Number(espn.pass_yd || 0)),
    pass_td: Math.max(Number(sleeperStats.pass_td || 0), Number(espn.pass_td || 0)),
    pass_int: Math.max(Number(sleeperStats.pass_int || 0), Number(espn.pass_int || 0)),
    fum_lost: Math.max(Number(sleeperStats.fum_lost || 0), Number(espn.fum_lost || 0)),
    sack: Math.max(Number(sleeperStats.sack || 0), Number(espn.sack || 0))
  };
}
function describeStatDelta(curr, prev, deltaPoints, isDef = false) {
  if (!curr || !Object.keys(curr).length) return null;
  if (!prev || !Object.keys(prev).length) return null;
  const d = {
    rush_yd: (curr.rush_yd || 0) - (prev.rush_yd || 0),
    rush_td: (curr.rush_td || 0) - (prev.rush_td || 0),
    rec: (curr.rec || 0) - (prev.rec || 0),
    rec_yd: (curr.rec_yd || 0) - (prev.rec_yd || 0),
    rec_td: (curr.rec_td || 0) - (prev.rec_td || 0),
    pass_yd: (curr.pass_yd || 0) - (prev.pass_yd || 0),
    pass_td: (curr.pass_td || 0) - (prev.pass_td || 0),
    pass_int: (curr.pass_int || 0) - (prev.pass_int || 0),
    fum_lost: (curr.fum_lost || 0) - (prev.fum_lost || 0),
    fgm: (curr.fgm || 0) - (prev.fgm || 0),
    xpm: (curr.xpm || 0) - (prev.xpm || 0),
    sack: (curr.sack || 0) - (prev.sack || 0),
    def_int: isDef ? ((curr.def_int || 0) - (prev.def_int || 0)) : 0,
    def_td: (curr.def_td || 0) - (prev.def_td || 0),
    def_safety: isDef ? ((curr.def_safety || 0) - (prev.def_safety || 0)) : 0,
    fum_rec: isDef ? ((curr.fum_rec || 0) - (prev.fum_rec || 0)) : 0
  };

  const phrases = [];
  if (d.pass_int > 0) phrases.push(d.pass_int === 1 ? 'INT thrown' : `${d.pass_int} INTs thrown`);
  if (d.fum_lost > 0) phrases.push(d.fum_lost === 1 ? 'fumble lost' : `${d.fum_lost} fumbles lost`);
  if (isDef && d.def_int > 0) phrases.push(d.def_int === 1 ? '+1 INT takeaway' : `+${d.def_int} INT takeaways`);
  if (isDef && d.fum_rec > 0) phrases.push(d.fum_rec === 1 ? '+1 fumble rec' : `+${d.fum_rec} fumble rec`);
  if (isDef && d.def_safety > 0) phrases.push(d.def_safety === 1 ? '+1 safety' : `+${d.def_safety} safeties`);

  if (d.rush_td > 0) {
    phrases.push(d.rush_yd > 0 ? `${d.rush_yd}-yd rush TD` : `${d.rush_td} rush TD`);
  } else if (d.rush_yd > 0) {
    phrases.push(`+${d.rush_yd} rush yds`);
  } else if (d.rush_yd < 0) {
    phrases.push(`${d.rush_yd} rush yds`);
  }

  if (d.rec_td > 0) {
    const catchPart = d.rec > 0 ? `${d.rec} rec, ` : '';
    phrases.push(d.rec_yd > 0 ? `${catchPart}${d.rec_yd}-yd rec TD` : `${catchPart}${d.rec_td} rec TD`);
  } else {
    if (d.rec > 0 && d.rec_yd !== 0) {
      phrases.push(`${d.rec} rec for ${d.rec_yd > 0 ? '+' : ''}${d.rec_yd} yds`);
    } else if (d.rec > 0) {
      phrases.push(`+${d.rec} rec`);
    } else if (d.rec_yd !== 0) {
      phrases.push(`${d.rec_yd > 0 ? '+' : ''}${d.rec_yd} rec yds`);
    }
  }

  if (d.pass_td > 0) {
    phrases.push(d.pass_yd > 0 ? `${d.pass_yd}-yd pass TD` : `${d.pass_td} pass TD`);
  } else if (d.pass_yd > 0) {
    phrases.push(`+${d.pass_yd} pass yds`);
  } else if (d.pass_yd < 0) {
    phrases.push(`${d.pass_yd} pass yds`);
  }

  if (d.fgm > 0) phrases.push(`+${d.fgm} FG`);
  if (d.xpm > 0) phrases.push(`+${d.xpm} XP`);
  if (d.sack > 0) phrases.push(`+${d.sack} sack`);
  if (d.def_td > 0) phrases.push(`+${d.def_td} def TD`);

  return phrases.length ? phrases.join(', ') : null;
}
function isLegitimatePointDrop(curr, prev, delta, isDef = false) {
  if (isDef) {
    if (!prev || !Object.keys(prev).length) return true;
    if ((curr?.pts_allowed || 0) > (prev.pts_allowed || 0)) return true;
    return delta < 0;
  }
  // For offensive players, verify if an actual turnover or stat reduction occurred:
  if (curr && prev && Object.keys(prev).length > 0) {
    if ((curr.pass_int || 0) > (prev.pass_int || 0)) return true;
    if ((curr.fum_lost || 0) > (prev.fum_lost || 0)) return true;
    if ((curr.fum || 0) > (prev.fum || 0)) return true;
    if ((curr.rush_yd || 0) < (prev.rush_yd || 0)) return true;
    if ((curr.rec_yd || 0) < (prev.rec_yd || 0)) return true;
    if ((curr.pass_yd || 0) < (prev.pass_yd || 0)) return true;
    if ((curr.rush_td || 0) < (prev.rush_td || 0)) return true;
    if ((curr.rec_td || 0) < (prev.rec_td || 0)) return true;
    if ((curr.pass_td || 0) < (prev.pass_td || 0)) return true;
    if ((curr.rec || 0) < (prev.rec || 0)) return true;
    return false;
  }
  return false;
}
function playerGame(id) { const player = (state.players && state.players[id]) || {}; const game = state.playerGames[normalizeTeam(player.team)]; return game ? `${game.status} · ${game.context}` : 'Game info pending'; }
function matchupTeamLabel(team) { if (!team) return 'Unknown team'; const row = (state.allMatchups || []).find(item => item.mine); if (!row) return team.name || 'Team'; if (String(row.rosterA) === String(team.rosterId)) return row.a; if (String(row.rosterB) === String(team.rosterId)) return row.b; return team.name || 'Team'; }
function projectionPoints(id) { const projection = state.projections[id] || {}; const value = projection.pts_ppr ?? projection.pts_half_ppr ?? projection.pts_std ?? projection.fantasy_points ?? projection.projected_points; return Number.isFinite(Number(value)) ? Number(value) : null; }
function playerStatus(id, points) { const isDef = ((state.players && state.players[id]) || {}).position === 'DEF'; const summary = statSummary(playerStats(id), points, isDef); const projection = projectionPoints(id); return summary !== 'No stats recorded' ? summary : projection === null ? summary : `Proj ${fmt(projection)}`; }
function projectedTotal(team) { if (!team || !team.starters) return null; let hasProjection = false; const total = team.starters.reduce((sum, id) => { const actual = Number(team.points?.[id] || 0); const projection = projectionPoints(id); const status = state.playerGames[normalizeTeam(((state.players && state.players[id]) || {}).team)]?.status || ''; if (projection === null) return sum + actual; hasProjection = true; return sum + (/final|post/i.test(status) ? actual : Math.max(actual, projection)); }, 0); return hasProjection ? total : null; }
function statSummary(stats, points = null, isDef = false) {
  const parts = [];
  if (Number(stats?.pass_td || 0)) parts.push(`${stats.pass_td} pass TD`);
  if (Number(stats?.rush_td || 0)) parts.push(`${stats.rush_td} rush TD`);
  if (Number(stats?.rec_td || 0)) parts.push(`${stats.rec_td} rec TD`);
  if (Number(stats?.ret_td || 0)) parts.push(`${stats.ret_td} return TD`);
  if (Number(stats?.def_td || 0)) parts.push(`${stats.def_td} defensive TD`);
  if (Number(stats?.rush_yd || 0)) parts.push(`${stats.rush_yd} rush yds`);
  if (Number(stats?.rec || 0)) parts.push(`${stats.rec} rec`);
  if (Number(stats?.rec_yd || 0)) parts.push(`${stats.rec_yd} rec yds`);
  if (Number(stats?.pass_yd || 0)) parts.push(`${stats.pass_yd} pass yds`);
  if (Number(stats?.pass_int || 0)) parts.push(`${stats.pass_int} INT`);
  if (Number(stats?.fum_lost || 0)) parts.push(`${stats.fum_lost} fum lost`);
  if (isDef && Number(stats?.def_int || 0)) parts.push(`${stats.def_int} INT`);
  if (isDef && Number(stats?.fum_rec || 0)) parts.push(`${stats.fum_rec} FR`);
  if (isDef && Number(stats?.sack || 0)) parts.push(`${stats.sack} sk`);
  if (isDef && Number(stats?.def_safety || 0)) parts.push(`${stats.def_safety} safety`);
  if (parts.length) return parts.join(' · ');
  if (points !== null && Number(points) !== 0) return `${Number(points) > 0 ? '+' : ''}${fmt(points)} pts`;
  return Number(points) === 0 && points !== null ? 'No stats recorded' : 'Live stats pending';
}
function renderTicker() {
  return state.ticker.length ? state.ticker.map(item => {
    const playHtml = item.play ? `<span class="ticker-play">${esc(item.play)}</span> · ` : '';
    const statsHtml = item.stats && item.stats !== 'No stats recorded' && !item.stats.startsWith('+') && !item.stats.startsWith('-') ? `${esc(item.stats)} · ` : '';
    const leagueHtml = item.leagueName ? `<span class="ticker-league">${esc(item.leagueName)}</span> · ` : '';
    const isLoss = item.delta < 0;
    const actionHtml = isLoss ? `lost <span class="delta-loss">${fmt(Math.abs(item.delta))}</span> points` : `gained ${fmt(item.delta)} points`;
    const itemClass = isLoss ? 'ticker-item negative' : 'ticker-item';
    return `<div class="${itemClass}"><i></i><div><strong>${esc(item.player)}</strong> ${actionHtml}${item.playerTotal !== undefined ? ` (${fmt(item.playerTotal)} pts total)` : ''}<small>${playHtml}${statsHtml}${leagueHtml}${esc(item.team)} · Score ${fmt(item.you)} - ${fmt(item.opponent)}</small></div><time>${time(item.at)}</time></div>`;
  }).join('') : '<div class="empty">Score swings will appear here as players add points.</div>';
}
function bindSettings() {
  $('poll-interval').value = settings.pollSeconds;
  $('poll-value').textContent = pollLabel(settings.pollSeconds);
  document.querySelectorAll('.preset-btn[data-poll]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.poll) === settings.pollSeconds);
    btn.onclick = () => {
      settings.pollSeconds = Number(btn.dataset.poll);
      saveSettings();
      bindSettings();
      schedulePoll();
    };
  });
  $('track-opponent').checked = settings.trackOpponent;
  $('voice-enabled').checked = settings.voice;
  $('voice-volume').value = settings.volume;
  $('volume-value').textContent = Math.round(settings.volume * 100) + '%';
  $('window-enabled').checked = settings.gameWindow;
  $('wake-enabled').checked = settings.wake;
  $('poll-interval').oninput = event => {
    settings.pollSeconds = Number(event.target.value);
    saveSettings();
    bindSettings();
    schedulePoll();
  };
  $('voice-volume').oninput = event => {
    settings.volume = Number(event.target.value);
    saveSettings();
    bindSettings();
  };
  [['track-opponent','trackOpponent'], ['voice-enabled','voice'], ['window-enabled','gameWindow'], ['wake-enabled','wake']].forEach(([id, key]) => $(id).onchange = event => {
    settings[key] = event.target.checked;
    saveSettings();
    if (key === 'wake') setWakeLock(settings.wake);
  });
  $('reset-user').onclick = () => {
    localStorage.removeItem('fantasy-score-user');
    localStorage.removeItem('fantasy-score-dashboard-cache');
    state.user = null;
    state.leagues = [];
    state.leagueData = {};
    document.body.classList.remove('settings-open');
    setupView();
  };
}

async function loadLeagueUsers() {
  if (!state.selectedLeague) return;
  state.leagueUsersCache = state.leagueUsersCache || {};
  const id = state.selectedLeague.league_id;
  if (!state.leagueUsersCache[id]) {
    try {
      state.leagueUsersCache[id] = await api(`/league/${id}/users`);
    } catch (e) {
      state.leagueUsersCache[id] = [];
    }
  }
  state.leagueUsers = state.leagueUsersCache[id];
}
function getRosterDisplayName(rosterId, rosters, isMine = false) {
  const roster = (rosters || []).find(r => r.roster_id === rosterId);
  const user = (state.leagueUsers || []).find(u => u.user_id === roster?.owner_id);
  const teamName = roster?.metadata?.team_name || roster?.metadata?.name || roster?.team_name || user?.metadata?.team_name;
  const ownerName = user?.display_name || user?.username;
  if (teamName && ownerName && teamName !== ownerName) return `${teamName} (${ownerName})`;
  if (teamName) return teamName;
  if (ownerName) return ownerName;
  return isMine ? 'Your team' : `Team ${rosterId || '-'}`;
}

async function poll(force = false) {
  if (!state.selectedLeague) return;
  const [matchups, rosters] = await Promise.all([
    api(`/league/${state.selectedLeague.league_id}/matchups/${state.nfl.week}`),
    api(`/league/${state.selectedLeague.league_id}/rosters`)
  ]);
  const roster = rosters.find(item => item.owner_id === state.user.user_id);
  const mine = (matchups || []).find(item => item.roster_id === roster?.roster_id);
  const rival = (matchups || []).find(item => item.matchup_id === mine?.matchup_id && item.roster_id !== roster?.roster_id);
  state.previousPoints = state.previousPoints || readStorage('fantasy-score-points', {});
  const previous = state.previousPoints;
  state.previousStats = state.previousStats || readStorage('fantasy-score-stats-history', {});
  const previousStats = state.previousStats;
  const makeTeam = (item, isMine) => {
    const rawPoints = item?.players_points || {};
    const starters = item?.starters || [];
    const points = { ...rawPoints };
    starters.forEach(id => {
      if (!id || id === '0') return;
      const key = `${state.selectedLeague.league_id}:${item?.roster_id || ''}:${id}`;
      const old = Number(previous[key]);
      const current = Number(points[id] || 0);
      const isDef = ((state.players && state.players[id]) || {}).position === 'DEF';
      if (Number.isFinite(old) && current < old) {
        const pStats = playerStats(id);
        const prevPStats = previousStats[key];
        const delta = current - old;
        if (!isLegitimatePointDrop(pStats, prevPStats, delta, isDef)) {
          points[id] = old;
        }
      }
    });
    const deltas = {};
    const total = starters.reduce((sum, id) => sum + Number(points[id] || 0), 0);
    const name = getRosterDisplayName(item?.roster_id, rosters, isMine);
    return { name, rosterId: item?.roster_id || '', starters, points, deltas, total, mine: isMine };
  };
  const you = makeTeam({ ...roster, players_points: mine?.players_points, starters: mine?.starters }, true);
  const opponent = makeTeam(rival, false);
  const changes = [];
  [you, opponent].forEach(team => {
    if (!team.mine && !settings.trackOpponent) return;
    const startersSet = new Set((team.starters || []).filter(id => id && id !== '0'));
    Object.entries(team.points).forEach(([id, points]) => {
      const key = `${state.selectedLeague.league_id}:${team.rosterId}:${id}`;
      const old = Number(previous[key] || 0);
      const delta = Number(points || 0) - old;
      if (!startersSet.has(id)) {
        previous[key] = points;
        return;
      }
      const isDef = ((state.players && state.players[id]) || {}).position === 'DEF';
      const pStats = playerStats(id);
      const prevPStats = previousStats[key];

      if (Object.prototype.hasOwnProperty.call(previous, key) && Math.abs(delta) > 0.001) {
        if (delta < 0 && !isLegitimatePointDrop(pStats, prevPStats, delta, isDef)) {
          // Stale CDN edge cache: ignore false score drop and do not downgrade previous[key]
          team.points[id] = old;
          return;
        }
        team.deltas[id] = delta;
        const play = describeStatDelta(pStats, prevPStats, delta, isDef) ||
          (delta < 0
            ? (isDef
                ? 'Points allowed'
                : ((pStats?.fum_lost || 0) > (prevPStats?.fum_lost || 0)
                    ? 'Fumble lost'
                    : ((pStats?.pass_int || 0) > (prevPStats?.pass_int || 0)
                        ? 'Interception thrown'
                        : 'Stat adjustment')))
            : null);
        const summary = statSummary(pStats, delta, isDef);
        changes.push({
          player: (state.players && state.players[id]?.full_name) || id,
          leagueId: state.selectedLeague?.league_id || '',
          leagueName: state.selectedLeague?.name || '',
          rosterId: team.rosterId,
          play,
          stats: summary,
          team: team.name,
          delta,
          playerTotal: Number(points || 0),
          at: Date.now(),
          you: you.total,
          opponent: opponent.total
        });
      }
      previous[key] = points;
      const currentStats = playerStats(id);
      if (currentStats && Object.keys(currentStats).length) {
        previousStats[key] = { ...currentStats };
      }
    });
  });
  localStorage.setItem('fantasy-score-points', JSON.stringify(previous));
  localStorage.setItem('fantasy-score-stats-history', JSON.stringify(previousStats));
  state.matchup = mine ? { you, opponent } : null;
  state.allMatchups = groupMatchups(matchups, rosters, mine);
  console.info(`[Fantasy Score] Matchup summary: You ${fmt(you.total)} - Opponent ${fmt(opponent.total)}`);
  if (changes.length) {
    const isDuplicate = (a, b) => (
      (!a.leagueId || !b.leagueId || a.leagueId === b.leagueId) &&
      a.player === b.player &&
      a.team === b.team &&
      fmt(a.playerTotal) === fmt(b.playerTotal) &&
      fmt(a.delta) === fmt(b.delta)
    );
    const uniqueChanges = changes.filter(c => !state.ticker.some(existing => isDuplicate(c, existing)));
    if (uniqueChanges.length) {
      state.ticker = dedupeTicker([...uniqueChanges.reverse(), ...state.ticker]).slice(0, 50);
      localStorage.setItem('fantasy-score-ticker', JSON.stringify(state.ticker));
      announce(uniqueChanges);
    }
  } else {
    state.ticker = dedupeTicker(state.ticker);
    localStorage.setItem('fantasy-score-ticker', JSON.stringify(state.ticker));
  }
}

function groupMatchups(matchups, rosters, mine) {
  const groups = {};
  (matchups || []).filter(item => item.matchup_id).forEach(item => (groups[item.matchup_id] ||= []).push(item));
  return Object.entries(groups).map(([id, items]) => {
    const first = items[0], second = items[1] || {};
    return {
      id,
      count: items.length,
      mine: id === String(mine?.matchup_id),
      rosterA: first.roster_id,
      rosterB: second.roster_id,
      a: getRosterDisplayName(first.roster_id, rosters, false),
      b: getRosterDisplayName(second.roster_id, rosters, false),
      scoreA: first.points || 0,
      scoreB: second.points || 0
    };
  });
}
let kokoroTtsPromise = null;
async function getKokoroTts() { if (!kokoroTtsPromise) { kokoroTtsPromise = import('https://cdn.jsdelivr.net/npm/kokoro-js@1.0.0/+esm').then(({ KokoroTTS }) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', { dtype: 'q8' })).catch(err => { kokoroTtsPromise = null; throw err; }); } return kokoroTtsPromise; }
function playRawAudio(raw) { if (!raw) return Promise.resolve(); try { const AudioCtx = window.AudioContext || window.webkitAudioContext; if (AudioCtx) { const ctx = new AudioCtx(); if (ctx.state === 'suspended') ctx.resume().catch(() => {}); const samples = raw.data || raw.audio; const sr = raw.sampling_rate || 24000; if (samples instanceof Float32Array) { const buffer = ctx.createBuffer(1, samples.length, sr); buffer.getChannelData(0).set(samples); const source = ctx.createBufferSource(); source.buffer = buffer; const gain = ctx.createGain(); gain.gain.value = Number(settings.volume ?? 0.8); source.connect(gain); gain.connect(ctx.destination); return new Promise(resolve => { source.onended = () => { ctx.close().catch(() => {}); resolve(); }; source.start(0); }); } } } catch (err) { console.warn('AudioContext playback failed, trying Blob URL:', err); } if (typeof raw.toBlob === 'function') { return new Promise((resolve, reject) => { const url = URL.createObjectURL(raw.toBlob()); const player = new Audio(url); player.volume = Number(settings.volume ?? 0.8); player.onended = () => { URL.revokeObjectURL(url); resolve(); }; player.onerror = err => { URL.revokeObjectURL(url); reject(err); }; player.play().catch(reject); }); } return Promise.resolve(); }
async function speakText(text) { try { const tts = await getKokoroTts(); const raw = await tts.generate(text, { voice: settings.kokoroVoice, speed: settings.voiceRate }); await playRawAudio(raw); } catch (error) { console.warn('Kokoro voice announcement skipped.', error); } }
function announce(changes) {
  if (!settings.voice) return;
  const audible = changes.filter(item => Math.abs(item.delta) >= Number(settings.voiceMinPoints || 0));
  if (!audible.length) return;
  const item = audible[0];
  const statText = item.play ? `, ${item.play},` : (item.stats && !/no stats/i.test(item.stats) && !item.stats.startsWith('+') && !item.stats.startsWith('-') ? `, ${item.stats},` : '');
  const teamContext = item.team ? ` for ${item.team}` : '';
  const totalText = item.playerTotal !== undefined ? `, now at ${fmt(item.playerTotal)} points` : '';
  const actionText = item.delta < 0 ? `lost ${fmt(Math.abs(item.delta))} points` : `gained ${fmt(item.delta)} points`;
  speakText(`${item.player}${statText} ${actionText}${teamContext}${totalText}. Current score: You ${fmt(item.you)}, Opponent ${fmt(item.opponent)}.`);
}
function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(() => pollAllLeagues(), settings.pollSeconds * 1000); }
async function setWakeLock(enabled) { if (!navigator.wakeLock) return; try { if (enabled && !state.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen'); if (!enabled && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; } } catch (error) { console.warn('Wake lock unavailable', error); } }
const includedLeagues = () => state.leagues.filter(league => !settings.excludedLeagues.includes(league.league_id));
function renderLeagueExclusions() { const target = $('league-exclusions'); if (!target) return; target.innerHTML = `<div class="section-kicker">Page leagues</div><div class="exclude-list">${state.leagues.length ? state.leagues.map(league => `<label class="setting-card switch"><span><strong>${esc(league.name)}</strong><small>${settings.excludedLeagues.includes(league.league_id) ? 'Excluded from the overview' : 'Included on the overview'}</small></span><input type="checkbox" data-league-toggle="${league.league_id}" ${!settings.excludedLeagues.includes(league.league_id) ? 'checked' : ''}><span class="switch-ui"></span></label>`).join('') : '<div class="empty">No leagues loaded yet.</div>'}</div>`; }
function bindLeagueExclusions() { document.querySelectorAll('[data-league-toggle]').forEach(input => input.addEventListener('change', event => { const id = event.target.dataset.leagueToggle; settings.excludedLeagues = event.target.checked ? settings.excludedLeagues.filter(item => item !== id) : [...new Set([...settings.excludedLeagues, id])]; saveSettings(); dashboardView(); })); }
function bindVoiceThreshold() { const input = $('voice-min-points'); const value = $('voice-min-value'); if (!input || !value) return; input.value = settings.voiceMinPoints; value.textContent = Number(settings.voiceMinPoints).toFixed(1) + ' pts'; input.oninput = event => { settings.voiceMinPoints = Number(event.target.value); value.textContent = settings.voiceMinPoints.toFixed(1) + ' pts'; saveSettings(); }; }
function bindVoiceSettings() { bindVoiceThreshold(); const kokoroVoice = $('kokoro-voice'); const rate = $('voice-rate'); const test = $('voice-test'); if (kokoroVoice) { kokoroVoice.value = settings.kokoroVoice; kokoroVoice.onchange = event => { settings.kokoroVoice = event.target.value; saveSettings(); }; } if (rate) { rate.value = settings.voiceRate; $('voice-rate-value').textContent = Number(settings.voiceRate).toFixed(1) + 'x'; rate.oninput = event => { settings.voiceRate = Number(event.target.value); $('voice-rate-value').textContent = settings.voiceRate.toFixed(1) + 'x'; saveSettings(); }; } if (test) test.onclick = announceTestVoice; }
async function announceTestVoice() { const btn = $('voice-test'); const original = btn?.textContent || 'Test selected voice'; if (btn) { btn.disabled = true; btn.textContent = 'Loading Kokoro...'; } try { const tts = await getKokoroTts(); if (btn) btn.textContent = 'Generating speech...'; const raw = await tts.generate('Voice test.', { voice: settings.kokoroVoice, speed: settings.voiceRate }); if (btn) btn.textContent = 'Playing...'; await playRawAudio(raw); } catch (error) { console.warn('Kokoro voice test failed:', error); if (btn) btn.textContent = 'Voice error'; await new Promise(r => setTimeout(r, 2000)); } finally { if (btn) { btn.disabled = false; btn.textContent = original; } } }
function renderLeagueCard(league, openLeagues = new Set(), expandedSlots = new Set()) {
  const snapshot = state.leagueData[league.league_id];
  if (!snapshot) return `<details class="league-card" data-league-id="${league.league_id}"><summary><div class="league-summary"><div class="league-summary-copy"><strong>${esc(league.name)}</strong><small>Waiting for first sync...</small></div></div></summary><div class="panel-content"><div class="empty">${state.loading ? 'Loading league details...' : 'No matchup data available.'}</div></div></details>`;
  const previous = { selectedLeague: state.selectedLeague, matchup: state.matchup, allMatchups: state.allMatchups, players: state.players, stats: state.stats, projections: state.projections, espnStats: state.espnStats, playerGames: state.playerGames, leagueUsers: state.leagueUsers };
  state.selectedLeague = league;
  state.matchup = snapshot.matchup;
  state.allMatchups = snapshot.allMatchups || [];
  state.players = snapshot.players || state.players || {};
  state.stats = snapshot.stats || {};
  state.projections = snapshot.projections || {};
  state.espnStats = snapshot.espnStats || {};
  state.playerGames = snapshot.playerGames || {};
  state.leagueUsers = snapshot.leagueUsers || [];
  const matchup = snapshot.matchup;
  const hasBothTeams = Boolean(matchup?.you && matchup?.opponent);
  const score = hasBothTeams ? `${fmt(matchup.you.total)} - ${fmt(matchup.opponent.total)}` : 'No matchup';
  const detail = hasBothTeams ? renderMatchup(expandedSlots) : '<div class="empty">No matchup found for this week.</div>';
  const pulse = renderAllMatchups();
  const teamSummary = hasBothTeams ? `${matchupTeamLabel(matchup.you)} vs ${matchupTeamLabel(matchup.opponent)}` : 'No matchup data';
  Object.assign(state, previous);
  const isOpen = openLeagues.has(league.league_id) || (openLeagues.size === 0 && league.league_id === state.selectedLeague?.league_id);
  return `<details class="league-card" data-league-id="${league.league_id}" ${isOpen ? 'open' : ''}><summary><div class="league-summary"><div class="league-summary-copy"><strong>${esc(league.name)}</strong><small>${esc(teamSummary)}</small></div><div class="league-summary-score"><strong>${score}</strong><small>Week ${esc(state.nfl?.week || '-')}</small></div></div></summary><div class="panel-content">${detail}<details><summary><span><span class="eyebrow">League pulse</span><br><strong>All matchups</strong></span></summary><div class="panel-content">${pulse}</div></details></div></details>`;
}
function dashboardView() {
  const visible = includedLeagues();
  const openLeagues = new Set([...document.querySelectorAll('details.league-card[open]')].map(d => d.dataset.leagueId).filter(Boolean));
  const expandedSlots = new Set([...document.querySelectorAll('[data-slot-row].is-expanded')].map(r => r.dataset.slotKey).filter(Boolean));
  const connectionDot = state.loading ? '' : state.error ? 'error' : 'live';
  const connectionText = state.loading ? 'Syncing' : state.error ? 'Reconnecting' : 'Live';
  $('app').innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark">FS</div><div><div class="eyebrow">Sleeper live desk</div><h1>Fantasy Score</h1></div></div><div class="top-actions"><div class="connection"><span class="dot ${connectionDot}"></span>${connectionText} · ${state.lastUpdated ? time(state.lastUpdated) : '-'}</div><button class="btn action-btn" id="refresh" aria-label="Refresh matchups"><span class="btn-text">Refresh</span><span class="btn-icon" aria-hidden="true">↻</span></button><button class="btn icon action-btn" id="open-settings" aria-label="Open settings"><span class="btn-text">Settings</span><span class="btn-icon" aria-hidden="true">⚙</span></button></div></header><section class="hero"><div><div class="eyebrow">${esc(state.nfl?.season || 'NFL')} season · Week ${esc(state.nfl?.week || '-')}</div><h1>Every league, one live desk.</h1><p class="hero-copy">${esc(state.user?.display_name || state.user?.username || '')} · ${visible.length} league${visible.length === 1 ? '' : 's'} included</p></div></section><div class="grid"><section class="stack"><div class="league-cards">${visible.length ? visible.map(l => renderLeagueCard(l, openLeagues, expandedSlots)).join('') : '<div class="matchup-card"><div class="empty">All leagues are excluded. Open settings to add one back.</div></div>'}</div></section><aside class="stack"><section><div class="eyebrow">Live ticker</div><h2 style="margin:4px 0 12px">Point swings</h2><div class="ticker">${renderTicker()}</div></section><section class="matchup-card"><div class="eyebrow">System status</div><h2 style="margin:5px 0 13px">Polling every ${pollLabel(settings.pollSeconds)}</h2><p class="matchup-meta">${settings.trackOpponent ? 'Tracking both lineups.' : 'Tracking your lineup.'}</p></section></aside></div></div>`;
  renderLeagueExclusions();
  bindDashboard();
  bindSettings();
  bindLeagueExclusions();
}
function bindDashboard() {
  $('refresh')?.addEventListener('click', () => pollAllLeagues(true));
  $('open-settings')?.addEventListener('click', () => document.body.classList.add('settings-open'));
  $('close-settings')?.addEventListener('click', () => document.body.classList.remove('settings-open'));
  $('backdrop')?.addEventListener('click', () => document.body.classList.remove('settings-open'));
  bindVoiceSettings();

  document.querySelectorAll('[data-slot-row]').forEach(row => {
    const toggle = () => {
      const isExpanded = row.classList.toggle('is-expanded');
      row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      const drawer = row.querySelector('.slot-detail-drawer');
      if (drawer) drawer.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  });
}
async function pollAllLeagues(force = false) {
  checkForAppUpdate();
  if (!force && !inGameWindow()) {
    schedulePoll();
    return;
  }
  if (state.isPolling) {
    return;
  }
  state.isPolling = true;
  const original = state.selectedLeague;
  state.loading = true;
  state.error = '';
  try {
    if (!state.nfl) state.nfl = await api('/state/nfl');
    const [latestNfl, stats] = await Promise.all([
      api('/state/nfl').catch(() => state.nfl),
      api(`/stats/nfl/${state.nfl.season}/${state.nfl.week}`).catch(() => state.stats || {})
    ]);
    if (latestNfl) {
      const weekChanged = latestNfl.season !== state.nfl?.season || latestNfl.week !== state.nfl?.week;
      state.nfl = latestNfl;
      if (weekChanged) {
        state.leagueData = {};
        state.previousPoints = {};
        state.previousStats = {};
        localStorage.removeItem('fantasy-score-points');
        localStorage.removeItem('fantasy-score-stats-history');
      }
    }
    state.stats = stats || state.stats || {};
    await ensurePlayersLoaded();
    const [espnStats, projections] = await Promise.all([
      loadEspnStats(),
      api(`/projections/nfl/${state.nfl.season}/${state.nfl.week}`).catch(() => ({}))
    ]);
    state.espnStats = espnStats || {};
    state.projections = projections || {};

    const leagues = includedLeagues();
    for (const league of leagues) {
      state.selectedLeague = league;
      await loadLeagueUsers();
      await poll(true);
      state.leagueData[league.league_id] = {
        matchup: state.matchup,
        allMatchups: state.allMatchups,
        players: state.players,
        stats: state.stats,
        projections: state.projections,
        espnStats: state.espnStats,
        playerGames: state.playerGames,
        leagueUsers: state.leagueUsers
      };
    }
    state.selectedLeague = original || leagues[0] || null;
    state.lastUpdated = Date.now();
    state.error = '';
    saveDashboardCache();
  } catch (error) {
    console.warn('[Fantasy Score] Polling error:', error);
    state.error = error.message;
  } finally {
    state.isPolling = false;
    state.loading = false;
    dashboardView();
    schedulePoll();
  }
}
function saveDashboardCache() {
  try {
    const rosterPlayers = {};
    Object.values(state.leagueData || {}).forEach(ld => {
      const starters = [
        ...(ld.matchup?.you?.starters || []),
        ...(ld.matchup?.opponent?.starters || [])
      ];
      starters.forEach(id => {
        if (id && state.players && state.players[id]) rosterPlayers[id] = state.players[id];
      });
    });

    const cleanLeagueData = {};
    Object.entries(state.leagueData || {}).forEach(([lid, data]) => {
      cleanLeagueData[lid] = {
        matchup: data.matchup,
        allMatchups: data.allMatchups,
        stats: data.stats,
        projections: data.projections,
        espnStats: data.espnStats,
        playerGames: data.playerGames,
        leagueUsers: data.leagueUsers,
        players: rosterPlayers
      };
    });

    const payload = {
      user: state.user,
      nfl: state.nfl,
      leagues: state.leagues,
      selectedLeague: state.selectedLeague,
      leagueData: cleanLeagueData,
      rosterPlayers,
      ticker: dedupeTicker(state.ticker),
      lastUpdated: state.lastUpdated
    };
    localStorage.setItem('fantasy-score-ticker', JSON.stringify(payload.ticker));
    localStorage.setItem('fantasy-score-dashboard-cache', JSON.stringify(payload));
  } catch (e) {
    console.warn('Could not cache dashboard data', e);
  }
}
async function connect(username) {
  state.loading = true;
  state.error = '';
  try {
    state.user = await api('/user/' + encodeURIComponent(username));
    if (!state.user?.user_id) throw new Error('Sleeper username not found.');
    localStorage.setItem('fantasy-score-user', username);
    state.nfl = await api('/state/nfl');
    const leagues = await api(`/user/${state.user.user_id}/leagues/nfl/${state.nfl.season}`);
    state.leagues = (leagues || []).filter(league => league.status !== 'complete').slice(0, 10);
    if (!state.leagues.length) throw new Error('No active NFL leagues found for this season.');
    state.selectedLeague = state.leagues[0];
    await ensurePlayersLoaded();
    await pollAllLeagues(true);
  } catch (error) {
    state.error = error.message + ' Check the spelling and try again.';
    state.loading = false;
    setupView();
  }
}
let updateBannerShown = false;
async function checkForAppUpdate() {
  if (updateBannerShown) return;
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const meta = await res.json();
    if (meta?.version && meta.version !== APP_VERSION) {
      updateBannerShown = true;
      const banner = document.createElement('div');
      banner.id = 'update-banner';
      banner.className = 'update-banner';
      banner.innerHTML = `<span>A new update (<strong>${esc(meta.version)}</strong>) is available.</span><button class="btn primary" onclick="window.location.reload(true)">Refresh</button>`;
      document.body.prepend(banner);
    }
  } catch (err) {}
}
const updateVersionUI = () => { const el = $('app-version'); if (el) el.textContent = APP_VERSION; };
updateVersionUI();
console.info(`[Fantasy Score] Version ${APP_VERSION}`);
checkForAppUpdate();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const elapsed = Date.now() - (state.lastUpdated || 0);
    if (elapsed >= (settings.pollSeconds || 60) * 1000) {
      pollAllLeagues(true);
    }
  }
});
window.addEventListener('focus', () => {
  const elapsed = Date.now() - (state.lastUpdated || 0);
  if (elapsed >= (settings.pollSeconds || 60) * 1000) {
    pollAllLeagues(true);
  }
});
const savedUser = localStorage.getItem('fantasy-score-user');
const cachedDashboard = readStorage('fantasy-score-dashboard-cache', null);
const cachedTicker = readStorage('fantasy-score-ticker', cachedDashboard?.ticker || []);
state.ticker = dedupeTicker(cachedTicker);
if (savedUser) {
  let restored = false;
  if (cachedDashboard && cachedDashboard.user?.username?.toLowerCase() === savedUser.toLowerCase()) {
    try {
      state.user = cachedDashboard.user;
      state.nfl = cachedDashboard.nfl;
      state.leagues = cachedDashboard.leagues || [];
      state.selectedLeague = cachedDashboard.selectedLeague || state.leagues[0];
      state.leagueData = cachedDashboard.leagueData || {};
      state.players = cachedDashboard.rosterPlayers || state.players || {};
      state.lastUpdated = cachedDashboard.lastUpdated;
      state.loading = true;
      dashboardView();
      restored = true;
    } catch (e) {
      console.warn('Cached dashboard restore failed, falling back to loading view:', e);
    }
  }
  if (!restored) {
    loadingView(savedUser);
  }
  connect(savedUser);
} else {
  setupView();
}

window.addEventListener('error', event => {
  console.error('[Fantasy Score] Global error captured:', event.error || event.message);
  const appEl = $('app');
  if (appEl && (!appEl.innerHTML || appEl.innerHTML.trim() === '')) {
    appEl.innerHTML = `<main class="setup"><div class="brand"><div class="brand-mark">FS</div><div><div class="eyebrow">Recovery desk</div><h1>Fantasy Score</h1></div></div><h2>Temporary sync error</h2><p>Something interrupted the live desk sync. Click below to reconnect cleanly.</p><div style="display:flex; gap:10px; margin-top:16px"><button class="btn primary" onclick="localStorage.removeItem('fantasy-score-dashboard-cache'); window.location.reload(true);">Reconnect</button></div></main>`;
  }
});
