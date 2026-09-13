const APP_VERSION = 'v1.2.5';
const API = 'https://api.sleeper.app/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const defaults = { pollSeconds: 120, trackOpponent: true, voice: false, volume: .8, kokoroVoice: 'bf_emma', voiceRate: 1, voiceMinPoints: 1, gameWindow: true, wake: false, excludedLeagues: [] };
const state = { user: null, nfl: null, leagues: [], selectedLeague: null, matchup: null, allMatchups: [], leagueData: {}, players: {}, stats: {}, projections: {}, espnStats: {}, playerGames: {}, leagueUsers: [], ticker: [], lastUpdated: null, error: '', loading: false, wakeLock: null };
const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const savedSettings = readStorage('fantasy-score-settings', {});
let settings = { ...defaults, ...savedSettings };
let pollTimer;
const $ = id => document.getElementById(id);
const saveSettings = () => localStorage.setItem('fantasy-score-settings', JSON.stringify(settings));
if (Number(savedSettings.settingsVersion || 0) < 2) { settings.gameWindow = true; settings.voice = false; settings.settingsVersion = 2; saveSettings(); }
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
const api = async path => { const response = await fetch(API + path); if (!response.ok) throw new Error('Sleeper API returned ' + response.status); return response.json(); };
const fmt = value => Number(value || 0).toFixed(2).replace(/\.00$/, '');
const time = value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const inGameWindow = () => { if (!settings.gameWindow) return true; const now = new Date(); const minutes = now.getHours() * 60 + now.getMinutes(); return now.getDay() === 0 && minutes >= 780 && minutes < 1410; };

function setupView() {
  $('app').innerHTML = `<main class="setup"><div class="brand"><div class="brand-mark">FS</div><div><div class="eyebrow">Sleeper live desk</div><h1>Fantasy Score</h1></div></div><h2>Your matchup, in motion.</h2><p>Connect a Sleeper username to follow active leagues, live player points, NFL games, and score swings from one focused view.</p><form class="setup-form" id="username-form"><input id="username" type="text" autocomplete="username" placeholder="Sleeper username" required><button class="btn primary">Connect</button></form>${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}</main>`;
  $('username-form').addEventListener('submit', event => { event.preventDefault(); connect($('username').value.trim()); });
}
function renderAllMatchups() { if (!state.allMatchups.length) return '<div class="empty">No league matchups available for this week.</div>'; return `<div class="league-list">${state.allMatchups.map(item => `<div class="matchup-row ${item.mine ? 'active' : ''}"><div class="row-top"><span>${item.mine ? 'YOUR MATCHUP' : 'MATCHUP ' + item.id}</span><span>${item.count} rosters</span></div><div class="row-score"><span>${esc(item.a)}</span><span>${fmt(item.scoreA)} · ${fmt(item.scoreB)}</span><span>${esc(item.b)}</span></div></div>`).join('')}</div>`; }
function formatPlayerName(player) {
  if (!player || !player.full_name) return { full: 'Empty slot', short: 'Empty' };
  const full = player.full_name;
  const first = player.first_name || '';
  const last = player.last_name || '';
  const short = (first && last) ? `${first[0]}. ${last}` : full;
  return { full, short };
}

function compactStatSummary(stats, points = null) {
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
  if (Number(stats.pass_int) || Number(stats.def_int)) parts.push(`${stats.pass_int || stats.def_int} INT`);
  if (parts.length) return parts.slice(0, 2).join(' · ');
  return Number(points) === 0 ? 'No stats' : '';
}

function fullStatBreakdown(id, points = null) {
  if (!id || id === '0') return '<div class="detail-empty">No player in slot</div>';
  const stats = playerStats(id);
  if (!stats || !Object.keys(stats).length) {
    return `<div class="detail-empty">${Number(points) === 0 ? 'No stats recorded yet' : 'Live stats pending'}</div>`;
  }
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
    const yds = `${stats.rush_yd || 0} yds`;
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
  if (stats.fgm !== undefined || stats.fga !== undefined || stats.xpm !== undefined) {
    const fg = stats.fgm !== undefined ? `${stats.fgm}/${stats.fga || stats.fgm} FG` : '';
    const xp = stats.xpm !== undefined ? `, ${stats.xpm} XP` : '';
    lines.push(`<strong>Kick:</strong> ${fg}${xp}`);
  }
  if (stats.sack || stats.def_int || stats.fum_rec || stats.def_td || stats.pts_allowed !== undefined) {
    const s = [];
    if (stats.sack) s.push(`${stats.sack} sk`);
    if (stats.def_int) s.push(`${stats.def_int} INT`);
    if (stats.fum_rec) s.push(`${stats.fum_rec} FR`);
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
  const player = state.players[id] || {};
  const game = state.playerGames[normalizeTeam(player.team)];
  const status = game?.status || '';
  const stats = compactStatSummary(playerStats(id), points);
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

function renderMatchup() {
  const team = state.matchup.you;
  const opponent = state.matchup.opponent;
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

    const myPlayer = isMyEmpty ? null : (state.players[myId] || {});
    const oppPlayer = isOppEmpty ? null : (state.players[oppId] || {});

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

    const hoverTitle = `${myName.full} (${isMyEmpty ? '-' : fmt(myPoints)} pts) vs ${oppName.full} (${isOppEmpty ? '-' : fmt(oppPoints)} pts) - Tap to expand details`;

    slots.push(`
      <div class="slot-row" data-slot-row tabindex="0" role="button" aria-expanded="false" title="${esc(hoverTitle)}">
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
              ${myDelta > 0 ? `<span class="score-delta">+${fmt(myDelta)}</span>` : ''}
            </div>
          </div>

          <div class="slot-pos">
            <span class="pos-badge ${posClass}">${esc(pos)}</span>
          </div>

          <div class="slot-col is-opponent ${isOppEmpty ? 'is-empty' : ''}">
            <div class="player-score-block">
              <span class="score-pts">${isOppEmpty ? '-' : fmt(oppPoints)}</span>
              ${oppDelta > 0 ? `<span class="score-delta">+${fmt(oppDelta)}</span>` : ''}
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

        <div class="slot-detail-drawer" aria-hidden="true">
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
function mergeEspnStatGroup(target, group) { const labels = (group.labels || []).map(label => String(label).toUpperCase()); (group.athletes || []).forEach(entry => { const key = `${normalizeName(entry.athlete?.fullName || entry.athlete?.displayName)}|${normalizeTeam(group.team?.abbreviation)}`; const stats = target[key] || {}; (entry.stats || []).forEach((value, index) => { const label = labels[index]; const number = Number(String(value).replace(/[^0-9.-]/g, '')); if (!Number.isFinite(number)) return; if (group.name === 'rushing' && label === 'YDS') stats.rush_yd = number; if (group.name === 'rushing' && label === 'TD') stats.rush_td = number; if (group.name === 'receiving' && label === 'REC') stats.rec = number; if (group.name === 'receiving' && label === 'YDS') stats.rec_yd = number; if (group.name === 'receiving' && label === 'TD') stats.rec_td = number; if (group.name === 'passing' && label === 'YDS') stats.pass_yd = number; if (group.name === 'passing' && label === 'TD') stats.pass_td = number; }); target[key] = stats; }); }
async function loadEspnStats() { try { const board = await fetch(ESPN).then(response => response.json()); const games = {}; (board.events || []).forEach(event => { const competition = event.competitions?.[0]; const teams = competition?.competitors || []; const home = teams.find(team => team.homeAway === 'home'); const away = teams.find(team => team.homeAway === 'away'); const status = competition?.status?.type?.shortDetail || competition?.status?.type?.detail || 'Scheduled'; if (home?.team?.abbreviation && away?.team?.abbreviation) { games[normalizeTeam(home.team.abbreviation)] = { context: `vs ${normalizeTeam(away.team.abbreviation)}`, status }; games[normalizeTeam(away.team.abbreviation)] = { context: `@ ${normalizeTeam(home.team.abbreviation)}`, status }; } }); const events = (board.events || []).filter(event => event.status?.type?.state !== 'pre'); const summaries = await Promise.all(events.map(event => fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${event.id}`).then(response => response.ok ? response.json() : null).catch(() => null))); const result = {}; summaries.filter(Boolean).forEach(summary => (summary.boxscore?.players || []).forEach(team => (team.statistics || []).forEach(group => { group.team = team.team; mergeEspnStatGroup(result, group); }))); state.playerGames = games; return result; } catch (error) { console.warn('ESPN stat fallback unavailable', error); state.playerGames = {}; return {}; } }
function playerStats(id) { const sleeperStats = state.stats[id]; if (sleeperStats && Object.keys(sleeperStats).length) return sleeperStats; const player = state.players[id] || {}; const name = normalizeName(player.full_name); const team = normalizeTeam(player.team); const exact = state.espnStats[`${name}|${team}`]; if (exact) return exact; const match = Object.entries(state.espnStats).find(([key]) => { const [espnName, espnTeam] = key.split('|'); return espnTeam === team && (espnName.startsWith(name) || name.startsWith(espnName)); }); return match?.[1] || {}; }
function playerGame(id) { const player = state.players[id] || {}; const game = state.playerGames[normalizeTeam(player.team)]; return game ? `${game.status} · ${game.context}` : 'Game info pending'; }
function matchupTeamLabel(team) { const row = state.allMatchups.find(item => item.mine); if (!row) return team.name; if (String(row.rosterA) === String(team.rosterId)) return row.a; if (String(row.rosterB) === String(team.rosterId)) return row.b; return team.name; }
function projectionPoints(id) { const projection = state.projections[id] || {}; const value = projection.pts_ppr ?? projection.pts_half_ppr ?? projection.pts_std ?? projection.fantasy_points ?? projection.projected_points; return Number.isFinite(Number(value)) ? Number(value) : null; }
function playerStatus(id, points) { const summary = statSummary(playerStats(id), points); const projection = projectionPoints(id); return summary !== 'No stats recorded' ? summary : projection === null ? summary : `Proj ${fmt(projection)}`; }
function projectedTotal(team) { let hasProjection = false; const total = team.starters.reduce((sum, id) => { const actual = Number(team.points[id] || 0); const projection = projectionPoints(id); const status = state.playerGames[normalizeTeam((state.players[id] || {}).team)]?.status || ''; if (projection === null) return sum + actual; hasProjection = true; return sum + (/final|post/i.test(status) ? actual : Math.max(actual, projection)); }, 0); return hasProjection ? total : null; }
function statSummary(stats, points = null) {
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
  if (parts.length) return parts.join(' · ');
  if (points !== null && Number(points) > 0) return `+${fmt(points)} pts`;
  return Number(points) === 0 && points !== null ? 'No stats recorded' : 'Live stats pending';
}
function renderTicker() { return state.ticker.length ? state.ticker.map(item => `<div class="ticker-item"><i></i><div><strong>${esc(item.player)}</strong> gained ${fmt(item.delta)} points<small>${esc(item.stats)} · ${esc(item.team)} · Score ${fmt(item.you)} - ${fmt(item.opponent)}</small></div><time>${time(item.at)}</time></div>`).join('') : '<div class="empty">Score swings will appear here as players add points.</div>'; }
function bindSettings() { $('poll-interval').value = settings.pollSeconds; $('poll-value').textContent = settings.pollSeconds + 's'; $('track-opponent').checked = settings.trackOpponent; $('voice-enabled').checked = settings.voice; $('voice-volume').value = settings.volume; $('volume-value').textContent = Math.round(settings.volume * 100) + '%'; $('window-enabled').checked = settings.gameWindow; $('wake-enabled').checked = settings.wake; $('poll-interval').oninput = event => { settings.pollSeconds = Number(event.target.value); saveSettings(); bindSettings(); schedulePoll(); }; $('voice-volume').oninput = event => { settings.volume = Number(event.target.value); saveSettings(); bindSettings(); }; [['track-opponent','trackOpponent'], ['voice-enabled','voice'], ['window-enabled','gameWindow'], ['wake-enabled','wake']].forEach(([id, key]) => $(id).onchange = event => { settings[key] = event.target.checked; saveSettings(); if (key === 'wake') setWakeLock(settings.wake); }); $('reset-user').onclick = () => { localStorage.removeItem('fantasy-score-user'); state.user = null; state.leagues = []; document.body.classList.remove('settings-open'); setupView(); }; }

async function loadLeagueUsers() { state.leagueUsers = await api(`/league/${state.selectedLeague.league_id}/users`); }
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
  if (!state.selectedLeague || (!force && !inGameWindow())) return;
  state.loading = true;
  try {
    const [matchups, rosters, players, stats] = await Promise.all([
      api(`/league/${state.selectedLeague.league_id}/matchups/${state.nfl.week}`),
      api(`/league/${state.selectedLeague.league_id}/rosters`),
      api('/players/nfl'),
      api(`/stats/nfl/${state.nfl.season}/${state.nfl.week}`)
    ]);
    state.players = players || {};
    state.stats = stats || {};
    const roster = rosters.find(item => item.owner_id === state.user.user_id);
    const mine = (matchups || []).find(item => item.roster_id === roster?.roster_id);
    const rival = (matchups || []).find(item => item.matchup_id === mine?.matchup_id && item.roster_id !== roster?.roster_id);
    const previous = readStorage('fantasy-score-points', {});
    const makeTeam = (item, isMine) => {
      const points = item?.players_points || {};
      const starters = item?.starters || [];
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
        if (Object.prototype.hasOwnProperty.call(previous, key) && delta > 0) {
          team.deltas[id] = delta;
          const pStats = playerStats(id);
          const summary = statSummary(pStats, delta);
          changes.push({
            player: state.players[id]?.full_name || id,
            stats: summary,
            team: team.name,
            delta,
            at: Date.now(),
            you: you.total,
            opponent: opponent.total
          });
        }
        previous[key] = points;
      });
    });
    localStorage.setItem('fantasy-score-points', JSON.stringify(previous));
    state.matchup = mine ? { you, opponent } : null;
    state.allMatchups = groupMatchups(matchups, rosters, mine);
    console.info(`[Fantasy Score] Matchup summary: You ${fmt(you.total)} - Opponent ${fmt(opponent.total)}`);
    state.ticker = [...changes.reverse(), ...state.ticker].slice(0, 30);
    if (changes.length) announce(changes);
    state.lastUpdated = Date.now();
    state.error = '';
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    dashboardView();
    schedulePoll();
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
  const audible = changes.filter(item => item.delta >= Number(settings.voiceMinPoints || 0));
  if (!audible.length) return;
  const item = audible[0];
  const statText = item.stats && !/no stats/i.test(item.stats) && !item.stats.startsWith('+') ? `, ${item.stats},` : '';
  const teamContext = item.team ? ` for ${item.team}` : '';
  speakText(`${item.player}${statText} gained ${fmt(item.delta)} points${teamContext}. Current score: You ${fmt(item.you)}, Opponent ${fmt(item.opponent)}.`);
}
function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(() => pollAllLeagues(), settings.pollSeconds * 1000); }
async function setWakeLock(enabled) { if (!navigator.wakeLock) return; try { if (enabled && !state.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen'); if (!enabled && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; } } catch (error) { console.warn('Wake lock unavailable', error); } }
const includedLeagues = () => state.leagues.filter(league => !settings.excludedLeagues.includes(league.league_id));
function renderLeagueExclusions() { const target = $('league-exclusions'); if (!target) return; target.innerHTML = `<div class="section-kicker">Page leagues</div><div class="exclude-list">${state.leagues.length ? state.leagues.map(league => `<label class="setting-card switch"><span><strong>${esc(league.name)}</strong><small>${settings.excludedLeagues.includes(league.league_id) ? 'Excluded from the overview' : 'Included on the overview'}</small></span><input type="checkbox" data-league-toggle="${league.league_id}" ${!settings.excludedLeagues.includes(league.league_id) ? 'checked' : ''}><span class="switch-ui"></span></label>`).join('') : '<div class="empty">No leagues loaded yet.</div>'}</div>`; }
function bindLeagueExclusions() { document.querySelectorAll('[data-league-toggle]').forEach(input => input.addEventListener('change', event => { const id = event.target.dataset.leagueToggle; settings.excludedLeagues = event.target.checked ? settings.excludedLeagues.filter(item => item !== id) : [...new Set([...settings.excludedLeagues, id])]; saveSettings(); dashboardView(); })); }
function bindVoiceThreshold() { const input = $('voice-min-points'); const value = $('voice-min-value'); if (!input || !value) return; input.value = settings.voiceMinPoints; value.textContent = Number(settings.voiceMinPoints).toFixed(1) + ' pts'; input.oninput = event => { settings.voiceMinPoints = Number(event.target.value); value.textContent = settings.voiceMinPoints.toFixed(1) + ' pts'; saveSettings(); }; }
function bindVoiceSettings() { bindVoiceThreshold(); const kokoroVoice = $('kokoro-voice'); const rate = $('voice-rate'); const test = $('voice-test'); if (kokoroVoice) { kokoroVoice.value = settings.kokoroVoice; kokoroVoice.onchange = event => { settings.kokoroVoice = event.target.value; saveSettings(); }; } if (rate) { rate.value = settings.voiceRate; $('voice-rate-value').textContent = Number(settings.voiceRate).toFixed(1) + 'x'; rate.oninput = event => { settings.voiceRate = Number(event.target.value); $('voice-rate-value').textContent = settings.voiceRate.toFixed(1) + 'x'; saveSettings(); }; } if (test) test.onclick = announceTestVoice; }
async function announceTestVoice() { const btn = $('voice-test'); const original = btn?.textContent || 'Test selected voice'; if (btn) { btn.disabled = true; btn.textContent = 'Loading Kokoro...'; } try { const tts = await getKokoroTts(); if (btn) btn.textContent = 'Generating speech...'; const raw = await tts.generate('Voice test.', { voice: settings.kokoroVoice, speed: settings.voiceRate }); if (btn) btn.textContent = 'Playing...'; await playRawAudio(raw); } catch (error) { console.warn('Kokoro voice test failed:', error); if (btn) btn.textContent = 'Voice error'; await new Promise(r => setTimeout(r, 2000)); } finally { if (btn) { btn.disabled = false; btn.textContent = original; } } }
function renderLeagueCard(league) { const snapshot = state.leagueData[league.league_id]; if (!snapshot) return `<details class="league-card"><summary><div class="league-summary"><div class="league-summary-copy"><strong>${esc(league.name)}</strong><small>Waiting for first sync...</small></div></div></summary><div class="panel-content"><div class="empty">${state.loading ? 'Loading league details...' : 'No matchup data available.'}</div></div></details>`; const previous = { selectedLeague: state.selectedLeague, matchup: state.matchup, allMatchups: state.allMatchups, players: state.players, stats: state.stats, projections: state.projections, espnStats: state.espnStats, playerGames: state.playerGames, leagueUsers: state.leagueUsers }; state.selectedLeague = league; state.matchup = snapshot.matchup; state.allMatchups = snapshot.allMatchups; state.players = snapshot.players; state.stats = snapshot.stats; state.projections = snapshot.projections || {}; state.espnStats = snapshot.espnStats || {}; state.playerGames = snapshot.playerGames || {}; state.leagueUsers = snapshot.leagueUsers; const matchup = snapshot.matchup; const score = matchup ? `${fmt(matchup.you.total)} - ${fmt(matchup.opponent.total)}` : 'No matchup'; const detail = matchup ? renderMatchup() : '<div class="empty">No matchup found for this week.</div>'; const pulse = renderAllMatchups(); const teamSummary = matchup ? `${matchupTeamLabel(matchup.you)} vs ${matchupTeamLabel(matchup.opponent)}` : 'No matchup data'; Object.assign(state, previous); return `<details class="league-card" ${league.league_id === state.selectedLeague?.league_id ? 'open' : ''}><summary><div class="league-summary"><div class="league-summary-copy"><strong>${esc(league.name)}</strong><small>${esc(teamSummary)}</small></div><div class="league-summary-score"><strong>${score}</strong><small>Week ${esc(state.nfl?.week || '-')}</small></div></div></summary><div class="panel-content">${detail}<details><summary><span><span class="eyebrow">League pulse</span><br><strong>All matchups</strong></span></summary><div class="panel-content">${pulse}</div></details></div></details>`; }
function dashboardView() { const visible = includedLeagues(); $('app').innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark">FS</div><div><div class="eyebrow">Sleeper live desk</div><h1>Fantasy Score</h1></div></div><div class="top-actions"><div class="connection"><span class="dot ${state.loading ? '' : 'live'}"></span>${state.loading ? 'Syncing' : 'Live'} · ${state.lastUpdated ? time(state.lastUpdated) : '-'}</div><button class="btn action-btn" id="refresh" aria-label="Refresh matchups"><span class="btn-text">Refresh</span><span class="btn-icon" aria-hidden="true">↻</span></button><button class="btn icon action-btn" id="open-settings" aria-label="Open settings"><span class="btn-text">Settings</span><span class="btn-icon" aria-hidden="true">⚙</span></button></div></header><section class="hero"><div><div class="eyebrow">${esc(state.nfl?.season || 'NFL')} season · Week ${esc(state.nfl?.week || '-')}</div><h1>Every league, one live desk.</h1><p class="hero-copy">${esc(state.user?.display_name || state.user?.username || '')} · ${visible.length} league${visible.length === 1 ? '' : 's'} included</p></div></section><div class="grid"><section class="stack"><div class="league-cards">${visible.length ? visible.map(renderLeagueCard).join('') : '<div class="matchup-card"><div class="empty">All leagues are excluded. Open settings to add one back.</div></div>'}</div></section><aside class="stack"><section><div class="eyebrow">Live ticker</div><h2 style="margin:4px 0 12px">Point swings</h2><div class="ticker">${renderTicker()}</div></section><section class="matchup-card"><div class="eyebrow">System status</div><h2 style="margin:5px 0 13px">Polling every ${settings.pollSeconds}s</h2><p class="matchup-meta">${settings.trackOpponent ? 'Tracking both lineups.' : 'Tracking your lineup.'}</p></section></aside></div></div>`; renderLeagueExclusions(); bindDashboard(); bindSettings(); bindLeagueExclusions(); }
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
async function pollAllLeagues(force = false) { checkForAppUpdate(); if (!force && !inGameWindow()) return; const original = state.selectedLeague; state.loading = true; try { const latestNfl = await api('/state/nfl'); const weekChanged = latestNfl.season !== state.nfl?.season || latestNfl.week !== state.nfl?.week; state.nfl = latestNfl; if (weekChanged) { state.leagueData = {}; localStorage.removeItem('fantasy-score-points'); } state.espnStats = await loadEspnStats(); state.projections = await api(`/projections/nfl/${state.nfl.season}/${state.nfl.week}`).catch(() => ({})); for (const league of includedLeagues()) { state.selectedLeague = league; await loadLeagueUsers(); await poll(true); state.leagueData[league.league_id] = { matchup: state.matchup, allMatchups: state.allMatchups, players: state.players, stats: state.stats, projections: state.projections, espnStats: state.espnStats, playerGames: state.playerGames, leagueUsers: state.leagueUsers }; } state.selectedLeague = original; state.lastUpdated = Date.now(); } catch (error) { state.error = error.message; } finally { state.loading = false; dashboardView(); schedulePoll(); } }
async function connect(username) { state.loading = true; state.error = ''; setupView(); try { state.user = await api('/user/' + encodeURIComponent(username)); if (!state.user?.user_id) throw new Error('Sleeper username not found.'); localStorage.setItem('fantasy-score-user', username); state.nfl = await api('/state/nfl'); const leagues = await api(`/user/${state.user.user_id}/leagues/nfl/${state.nfl.season}`); state.leagues = (leagues || []).filter(league => league.status !== 'complete').slice(0, 10); if (!state.leagues.length) throw new Error('No active NFL leagues found for this season.'); state.selectedLeague = state.leagues[0]; await pollAllLeagues(true); } catch (error) { state.error = error.message + ' Check the spelling and try again.'; state.loading = false; setupView(); } }
let updateBannerShown = false;
async function checkForAppUpdate() { if (updateBannerShown) return; try { const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const meta = await res.json(); if (meta?.version && meta.version !== APP_VERSION) { updateBannerShown = true; const banner = document.createElement('div'); banner.id = 'update-banner'; banner.className = 'update-banner'; banner.innerHTML = `<span>A new update (<strong>${esc(meta.version)}</strong>) is available.</span><button class="btn primary" onclick="window.location.reload(true)">Refresh</button>`; document.body.prepend(banner); } } catch (err) {} }
const updateVersionUI = () => { const el = $('app-version'); if (el) el.textContent = APP_VERSION; }; updateVersionUI(); console.info(`[Fantasy Score] Version ${APP_VERSION}`); checkForAppUpdate(); const savedUser = localStorage.getItem('fantasy-score-user'); if (savedUser) connect(savedUser); else setupView();
