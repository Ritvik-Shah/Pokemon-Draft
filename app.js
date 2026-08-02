import {
  initFirebase,
  subscribeToPicks,
  addPick,
  removePickByKey,
  subscribeToFinalized,
  setFinalized,
  archiveAndClearDraft,
  subscribeToHistory,
  subscribeToMockPicks,
  subscribeToMockStatus,
  startMockSession,
  submitMockPick,
  resetMockDraft,
} from "./firebase-sync.js";

const TYPE_COLORS = {
  Normal: "#A8A878", Fire: "#EE8130", Water: "#6390F0", Electric: "#F7D02C",
  Grass: "#7AC74C", Ice: "#96D9D6", Fighting: "#C22E28", Poison: "#A33EA1",
  Ground: "#E2BF65", Flying: "#A98FF3", Psychic: "#F95587", Bug: "#A6B91A",
  Rock: "#B6A136", Ghost: "#735797", Dragon: "#6F35FC", Dark: "#705746",
  Steel: "#B7B7CE", Fairy: "#D685AD",
};

// Distinct identity colors assigned in draft order — used consistently
// across the board, standings, and suggestions so each team reads as the
// same "team" everywhere on the page, not just a gray card with a label.
const TEAM_COLORS = ["#4F8DFD", "#F2555B", "#38B673", "#E2A23B", "#A37BF2", "#3ECFC8", "#F0789E", "#8BA0B3"];
function teamColor(name) {
  const idx = TEAMS.findIndex((t) => t.name === name);
  return TEAM_COLORS[idx >= 0 ? idx % TEAM_COLORS.length : 0];
}

// Small inline icon set (stroke-based, sized via CSS) used in place of
// emoji so status/action affordances render consistently across devices.
const ICON = {
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 5H4a1 1 0 0 0-1 1 5 5 0 0 0 4 4.9M17 5h3a1 1 0 0 1 1 1 5 5 0 0 1-4 4.9"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>`,
  restart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 3 6.7"/><polyline points="3 16 3 21 8 21"/></svg>`,
};
function icon(name, cls = "") {
  return `<span class="icon ${cls}">${ICON[name]}</span>`;
}

let picks = []; // synced from Firebase, oldest -> newest
let myTeam = localStorage.getItem("draft_my_team") || "";
let searchTerm = "";
let finalized = false; // true once someone has confirmed the teams are official
let finalizedBy = null;
let history = []; // flat list of picks from past archived drafts in this room
let suggestionsEnabled = localStorage.getItem("draft_suggestions_enabled") === "1";

// ---------- Mock draft state ----------
// A stable id for this browser (not a real account — just enough to know
// "this tab locked in Team Alpha" across reloads and to arbitrate claims).
const CLIENT_ID_KEY = "draft_client_id";
let clientId = localStorage.getItem(CLIENT_ID_KEY);
if (!clientId) {
  clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(CLIENT_ID_KEY, clientId);
}
let mockMode = localStorage.getItem("draft_mock_mode") === "1";
let mockMyTeam = localStorage.getItem("draft_mock_team") || "";
let mockPicks = []; // synced from rooms/{room}/mockSessions/{clientId}/picksList — private to this client
let mockStatus = null; // { active, team, startedAt } | null — private to this client
let mockBotTimer = null;

const el = (id) => document.getElementById(id);

function typeBadge(t) {
  if (!t) return "";
  return `<span class="type-badge" style="background:${TYPE_COLORS[t] || "#888"}">${t}</span>`;
}

// ---------- PokeAPI meta loading (sprite + base stats, cached) ----------
// One fetch per mon gets us both the artwork (for sprites) and base stats
// (for the strength model) — cached to localStorage so repeat visits and
// prediction re-renders don't re-fetch up to 269 mons every time.
const META_CACHE_KEY = "draft_mon_meta_cache_v2";
const metaCache = JSON.parse(localStorage.getItem(META_CACHE_KEY) || "{}");

function persistMetaCache() {
  localStorage.setItem(META_CACHE_KEY, JSON.stringify(metaCache));
}

// Returns a Promise<{spriteUrl, bst}> — bst (base stat total) is null when
// PokeAPI doesn't recognize the slug (e.g. a Champions-exclusive Mega/form).
async function getPokemonMeta(slug) {
  if (slug in metaCache) return metaCache[slug];
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const spriteUrl =
      data?.sprites?.other?.["official-artwork"]?.front_default ||
      data?.sprites?.front_default ||
      null;
    const statsArr = data?.stats || [];
    const bst = statsArr.length ? statsArr.reduce((sum, s) => sum + (s.base_stat || 0), 0) : null;
    const meta = { spriteUrl, bst };
    metaCache[slug] = meta;
    persistMetaCache();
    return meta;
  } catch {
    const meta = { spriteUrl: null, bst: null };
    metaCache[slug] = meta;
    persistMetaCache();
    return meta;
  }
}

// After cards are in the DOM, fill in every [data-slug] image lazily, and
// nudge the predictions panel to redraw with sharper data as base stats
// stream in (a no-op if the draft isn't finalized yet).
function hydrateSprites(container) {
  const imgs = container.querySelectorAll("img[data-slug]");
  imgs.forEach(async (img) => {
    const slug = img.dataset.slug;
    const meta = await getPokemonMeta(slug);
    if (meta.spriteUrl) {
      img.src = meta.spriteUrl;
      img.classList.add("loaded");
    } else {
      img.closest(".sprite-box")?.classList.add("no-art");
    }
    if (finalized || (mockMode && currentTurnTeam(mockPicks) === null)) renderPredictions();
  });
}


function spriteBox(mon, size = "sm") {
  const initial = mon.name.replace(/^Mega |Hisuian |Alolan |Galarian /, "").charAt(0);
  const color = TYPE_COLORS[mon.type1] || "#888";
  return `
    <div class="sprite-box ${size}" style="--type-color:${color}">
      <span class="sprite-fallback">${initial}</span>
      <img data-slug="${mon.slug}" alt="" loading="lazy">
    </div>`;
}

function pickedNames(list = picks) {
  return new Set(list.map((p) => p.pokemon));
}

function costsByTeam(list = picks) {
  const out = {};
  for (const t of TEAMS) out[t.name] = 0;
  for (const p of list) out[p.team] = (out[p.team] || 0) + p.cost;
  return out;
}

function picksByTeam(list = picks) {
  const out = {};
  for (const t of TEAMS) out[t.name] = [];
  for (const p of list) out[p.team]?.push(p);
  return out;
}

function currentTurnTeam(list = picks) {
  if (list.length >= DRAFT_ORDER.length) return null; // draft complete
  return DRAFT_ORDER[list.length];
}

function currentRound(list = picks) {
  const n = Math.min(list.length, DRAFT_ORDER.length - 1);
  return n < 0 ? 1 : Math.floor(n / TEAMS.length) + 1;
}

// The cheapest Pokémon anywhere in the pool — the minimum a team must be
// able to reserve for each slot it still has left to fill.
const MIN_MON_COST = Math.min(...POKEMON_LIST.map((p) => p.cost));

// The most `team` can spend on its NEXT pick and still be able to afford
// at least the cheapest mon for every slot after that one. Only the final
// pick (no slots left afterward) is allowed to spend the whole remaining
// budget — every earlier pick must leave >= MIN_MON_COST per slot left.
function maxSpendableCost(team, picksList) {
  const roster = picksByTeam(picksList)[team] || [];
  const spent = costsByTeam(picksList)[team] || 0;
  const budget = TEAM_BUDGETS[team] ?? 100;
  const remaining = budget - spent;
  const slotsLeftAfterThisPick = Math.max(0, NUM_ROUNDS - roster.length - 1);
  return remaining - slotsLeftAfterThisPick * MIN_MON_COST;
}

// Which dataset/team/turn is "in play" right now — the real draft, or (if
// mock mode is toggled on) the shared practice draft.
function activeList() {
  return mockMode ? mockPicks : picks;
}
function activeMyTeam() {
  return mockMode ? mockMyTeam : myTeam;
}
function activeTurnTeam() {
  return currentTurnTeam(activeList());
}
function iAmLockedIn() {
  return mockMode && !!mockMyTeam && !!mockStatus?.active;
}

// ---------- Rendering ----------

function renderIdentityBar() {
  el("teamSelect").innerHTML =
    `<option value="">Choose your team…</option>` +
    TEAMS.map((t) => `<option value="${t.name}" ${t.name === myTeam ? "selected" : ""}>${t.name}</option>`).join("");
}

function renderStatus() {
  const statusEl = el("turnStatus");

  if (mockMode && !mockStatus?.active) {
    statusEl.innerHTML = `<span class="finalize-status pending" style="border:none;background:none;padding:0;">Set up your mock draft below to begin.</span>`;
    return;
  }

  const list = activeList();
  const turn = activeTurnTeam();

  if (turn === null) {
    statusEl.innerHTML = mockMode
      ? `<span class="done">${icon("check")}Mock draft complete — restart below to practice again.</span>`
      : `<span class="done">${icon("check")}Draft complete</span>`;
    return;
  }

  const isMe = turn === activeMyTeam();
  statusEl.style.setProperty("--team-color", teamColor(turn));
  const botTag = mockMode && turn !== mockMyTeam ? ` <span class="bot-tag">BOT</span>` : "";
  statusEl.innerHTML = `<span class="live-dot"></span>Pick <b>${list.length + 1}</b> / ${DRAFT_ORDER.length} · Round <b>${currentRound(list)}</b> · On the clock: <span class="onclock ${isMe ? "me" : ""}">${turn}</span>${botTag}${isMe ? " — that's you!" : ""}`;
}

// Top-banner strip showing whatever was picked most recently, so anyone
// glancing at the page — not just the person on the clock — can see
// what just got taken without hunting through the board.
function renderLastPick() {
  const bar = el("lastPickBar");
  if (!bar) return;

  const list = activeList();
  if (!list.length) {
    bar.classList.remove("show");
    bar.innerHTML = "";
    return;
  }

  const last = list[list.length - 1];
  const mon = POKEMON_LIST.find((m) => m.name === last.pokemon);
  bar.classList.add("show");
  bar.style.setProperty("--team-color", teamColor(last.team));
  bar.innerHTML = `
    <span class="last-pick-label">Last pick</span>
    ${mon ? spriteBox(mon, "xs") : ""}
    <span class="last-pick-name">${last.pokemon}</span>
    <span class="last-pick-team">${last.team}</span>
    <span class="last-pick-cost">${last.cost} pts</span>`;
  hydrateSprites(bar);
}

function renderBoard() {
  const list = activeList();
  const costs = costsByTeam(list);
  const byTeam = picksByTeam(list);
  const turn = activeTurnTeam();
  el("board").innerHTML = TEAMS.map((t) => {
    const spent = costs[t.name] || 0;
    const budget = TEAM_BUDGETS[t.name];
    const remaining = budget - spent;
    const teamPicks = byTeam[t.name] || [];
    const isTurn = turn === t.name;
    const pct = Math.min(100, (spent / budget) * 100);
    const tag = !mockMode
      ? ""
      : t.name === mockMyTeam
      ? `<span class="bot-tag you-tag">YOU</span>`
      : `<span class="bot-tag">BOT</span>`;
    return `
      <div class="team-col ${isTurn ? "on-turn" : ""}" style="--team-color:${teamColor(t.name)}">
        <div class="team-col-head">
          <span class="team-name">${t.name}${tag}</span>
          <span class="team-pts ${remaining < 0 ? "over" : ""}">${remaining} left</span>
        </div>
        <div class="gauge small"><div class="gauge-fill" style="width:${pct}%"></div></div>
        <div class="team-picks">
          ${teamPicks
            .map((p, i) => {
              const mon = POKEMON_LIST.find((m) => m.name === p.pokemon);
              return `
            <div class="pick-row">
              <span class="pick-idx">${i + 1}.</span>
              ${mon ? spriteBox(mon, "xs") : ""}
              <span class="pick-name">${p.pokemon}</span>
              <span class="pick-cost">${p.cost}</span>
              ${!mockMode && !finalized ? `<button class="undo-btn" title="Undo this pick" data-key="${p.key}">&times;</button>` : ""}
            </div>`;
            })
            .join("") || `<div class="empty-slot">No picks yet</div>`}
          ${Array.from({ length: Math.max(0, NUM_ROUNDS - teamPicks.length) })
            .map(() => `<div class="empty-slot dim">—</div>`)
            .join("")}
        </div>
      </div>`;
  }).join("");

  el("board").querySelectorAll(".undo-btn").forEach((btn) => {
    btn.onclick = () => {
      if (!confirm("Undo this pick? This affects everyone's view.")) return;
      removePickByKey(DRAFT_ROOM, btn.dataset.key);
    };
  });
}

function renderPool() {
  const list = activeList();
  const team = activeMyTeam();
  const taken = pickedNames(list);
  const turn = activeTurnTeam();
  const myMaxSpendable = team ? maxSpendableCost(team, list) : 0;
  const canAct = mockMode ? !!(mockStatus?.active && iAmLockedIn()) : true;

  const filtered = POKEMON_LIST.filter((p) => {
    if (taken.has(p.name)) return false;
    if (searchTerm && !p.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  el("poolCount").textContent = `${filtered.length} available`;

  el("pool").innerHTML = filtered
    .map((p) => {
      const canAfford = p.cost <= myMaxSpendable;
      const isMyTurn = turn === team && team && canAct;
      const disabled = !isMyTurn || !canAfford;
      const blockedBySlots = isMyTurn && !canAfford && p.cost <= (TEAM_BUDGETS[team] ?? 100) - (costsByTeam(list)[team] || 0);
      return `
      <div class="pool-card ${disabled ? "disabled" : ""}" data-name="${p.name}" ${blockedBySlots ? `title="Picking this would leave too few points for your remaining roster slots."` : ""}>
        ${spriteBox(p, "sm")}
        <div class="pool-card-body">
          <div class="pool-card-top">
            <span class="pool-name">${p.name}</span>
            <span class="pool-cost">${p.cost}</span>
          </div>
          <div class="types">${typeBadge(p.type1)}${typeBadge(p.type2)}</div>
        </div>
      </div>`;
    })
    .join("");

  el("pool").querySelectorAll(".pool-card:not(.disabled)").forEach((card) => {
    card.onclick = () => draftPokemon(card.dataset.name);
  });

  hydrateSprites(el("pool"));
}

function renderFinalizeControl() {
  const bar = el("finalizeBar");
  if (!bar) return;
  if (mockMode) {
    bar.innerHTML = "";
    return;
  }
  const draftDone = picks.length >= DRAFT_ORDER.length;

  if (finalized) {
    bar.innerHTML = `
      <div class="finalize-status locked">
        <span>${icon("lock")}Teams are finalized${finalizedBy ? ` (confirmed by ${finalizedBy})` : ""} — picks are locked in.</span>
        <button id="unlockBtn" class="link-btn">Not final? Unlock</button>
      </div>`;
    el("unlockBtn").onclick = () => {
      if (!confirm("Unlock the draft? This re-enables picks/undos and hides the projections until it's confirmed again.")) return;
      setFinalized(DRAFT_ROOM, false, null);
    };
  } else if (draftDone) {
    bar.innerHTML = `<button id="finalizeBtn" class="finalize-btn">${icon("check")}Confirm teams are final &amp; lock in projections</button>`;
    el("finalizeBtn").onclick = () => {
      if (!confirm("Lock in the draft as final? Only do this once every team's roster is exactly right — this hides the undo buttons for everyone.")) return;
      setFinalized(DRAFT_ROOM, true, myTeam || null);
    };
  } else {
    const remaining = DRAFT_ORDER.length - picks.length;
    bar.innerHTML = `<div class="finalize-status pending">Confirm button unlocks once every team has drafted all ${NUM_ROUNDS} Pokémon (${remaining} pick${remaining === 1 ? "" : "s"} left).</div>`;
  }
}

// ---------- Predictions ----------
// Team "strength" blends three signals:
//  1) Draft cost spent (an auction price already encodes perceived power)
//  2) Average base stat total (BST) of the roster, pulled from PokeAPI —
//     the same call already used for sprites, so no extra requests
//  3) A small type-coverage bonus for rosters with more unique types,
//     since narrow teams are easier to wall or sweep
// Records are simulated across a round-robin schedule sized to NUM_ROUNDS
// "weeks". If a mon's stats haven't loaded yet (or PokeAPI doesn't know a
// Champions-exclusive form), that team quietly falls back toward a
// cost-only estimate until data arrives.

function generateRoundRobinSchedule(teamNames, numWeeks) {
  const hasBye = teamNames.length % 2 !== 0;
  const arr = hasBye ? [...teamNames, "__BYE__"] : [...teamNames];
  const n = arr.length;
  const rounds = [];
  const rotating = arr.slice();

  for (let r = 0; r < n - 1; r++) {
    const week = [];
    for (let i = 0; i < n / 2; i++) {
      const a = rotating[i];
      const b = rotating[n - 1 - i];
      if (a !== "__BYE__" && b !== "__BYE__") week.push([a, b]);
    }
    rounds.push(week);
    const fixed = rotating[0];
    const rest = rotating.slice(1);
    rest.unshift(rest.pop());
    rotating.splice(0, rotating.length, fixed, ...rest);
  }

  // Cycle through the unique rounds until we've filled every week.
  const schedule = [];
  for (let w = 0; w < numWeeks; w++) schedule.push(rounds[w % rounds.length]);
  return schedule;
}

// Logistic win probability from a strength gap. k controls how sharply
// power gaps translate into win odds.
function winProbability(strengthA, strengthB, k = 20) {
  return 1 / (1 + Math.exp(-(strengthA - strengthB) / k));
}

// Computes one team's power score plus the raw ingredients (for display).
function computeTeamPower(teamName, picksList = picks) {
  const teamPicks = picksByTeam(picksList)[teamName] || [];
  const cost = teamPicks.reduce((sum, p) => sum + p.cost, 0);

  const bstValues = [];
  const types = new Set();
  for (const p of teamPicks) {
    const mon = POKEMON_LIST.find((m) => m.name === p.pokemon);
    if (!mon) continue;
    if (mon.type1) types.add(mon.type1);
    if (mon.type2) types.add(mon.type2);
    const meta = metaCache[mon.slug];
    if (meta?.bst != null) bstValues.push(meta.bst);
  }

  const avgBST = bstValues.length ? bstValues.reduce((a, b) => a + b, 0) / bstValues.length : null;
  // Scale BST (typically ~300-700) down to roughly the same range as
  // draft cost (typically ~0-120 for a full roster) so neither signal
  // dominates just because of units.
  const bstScore = avgBST != null ? avgBST / 6 : cost;
  const coverageBonus = types.size * 0.5; // small nudge, not a dominant factor

  const statsCoveragePct = teamPicks.length
    ? Math.round((bstValues.length / teamPicks.length) * 100)
    : 0;

  const power = cost * 0.5 + bstScore * 0.5 + coverageBonus;
  return { power, cost, avgBST, coverage: types.size, statsCoveragePct };
}

function computePredictions(picksList = picks) {
  const teamNames = TEAMS.map((t) => t.name);
  const powerByTeam = Object.fromEntries(teamNames.map((n) => [n, computeTeamPower(n, picksList)]));
  const strengthByTeam = Object.fromEntries(teamNames.map((n) => [n, powerByTeam[n].power]));
  const schedule = generateRoundRobinSchedule(teamNames, NUM_ROUNDS);

  const expectedWins = Object.fromEntries(teamNames.map((n) => [n, 0]));
  for (const week of schedule) {
    for (const [a, b] of week) {
      const pA = winProbability(strengthByTeam[a], strengthByTeam[b]);
      expectedWins[a] += pA;
      expectedWins[b] += 1 - pA;
    }
  }

  const maxStrength = Math.max(...teamNames.map((n) => strengthByTeam[n]), 1);

  const results = teamNames.map((name) => {
    const p = powerByTeam[name];
    const xWins = expectedWins[name];
    const wins = Math.round(xWins);
    return {
      name,
      strength: Math.round(p.power),
      strengthPct: Math.round((p.power / maxStrength) * 100),
      cost: p.cost,
      avgBST: p.avgBST != null ? Math.round(p.avgBST) : null,
      coverage: p.coverage,
      statsCoveragePct: p.statsCoveragePct,
      expectedWins: xWins,
      record: `${wins}-${NUM_ROUNDS - wins}`,
    };
  });

  results.sort((a, b) => b.expectedWins - a.expectedWins || b.strength - a.strength);
  results.forEach((r, i) => (r.rank = i + 1));
  return results;
}

function renderPredictions() {
  const container = el("predictions");
  if (!container) return;

  const list = mockMode ? mockPicks : picks;
  const mockComplete = mockMode && !!mockStatus?.active && currentTurnTeam(list) === null;
  const shouldShow = mockMode ? mockComplete : finalized;
  if (!shouldShow) {
    container.classList.remove("show");
    container.innerHTML = "";
    return;
  }

  const results = computePredictions(list);
  const champ = results[0];
  const stillLoading = results.some((r) => r.statsCoveragePct < 100);
  container.classList.add("show");
  container.innerHTML = `
    <div class="predictions-head">
      <div class="eyebrow">${mockMode ? "Mock Draft Projection" : "Season Projection"}</div>
      <h2>${mockMode ? "Your Practice Draft — Standings &amp; Champion" : "Projected Standings &amp; Champion"}</h2>
      <p>Strength blends draft cost spent, each roster's average base stat total (live from PokeAPI), and a small bonus for type coverage. Simulated across a ${NUM_ROUNDS}-week round-robin. For fun — not an official schedule.${mockMode ? " This is your own private practice run, not the real draft." : ""}</p>
      ${stillLoading ? `<p class="stats-loading-note">Still pulling live base stats for some Pokémon — this refines automatically as they load.</p>` : ""}
    </div>
    <div class="champion-card">
      <span class="crown">${ICON.trophy}</span>
      <div>
        <div class="champion-label">${mockMode ? "Projected Mock Champion" : "Projected Champion"}</div>
        <div class="champion-name">${champ.name}</div>
      </div>
    </div>
    <div class="predictions-table">
      <div class="pred-row pred-row-head">
        <span class="pred-rank"></span>
        <span class="pred-team">Team</span>
        <span class="pred-sub">Avg BST</span>
        <span class="pred-sub">Types</span>
        <div class="pred-bar"></div>
        <span class="pred-strength">Power</span>
        <span class="pred-record">Record</span>
      </div>
      ${results
        .map(
          (r) => `
        <div class="pred-row ${r.rank === 1 ? "champ" : ""}">
          <span class="pred-rank">#${r.rank}</span>
          <span class="pred-team">${r.name}</span>
          <span class="pred-sub">${r.avgBST != null ? r.avgBST : "—"}</span>
          <span class="pred-sub">${r.coverage}</span>
          <div class="pred-bar"><div class="pred-bar-fill" style="width:${r.strengthPct}%"></div></div>
          <span class="pred-strength">${r.strength}</span>
          <span class="pred-record">${r.record}</span>
        </div>`
        )
        .join("")}
    </div>
    <div class="predictions-actions">
      <button id="exportCsvBtn" class="secondary-btn">${icon("download")}Export CSV</button>
      ${mockMode
        ? `<button id="mockRestartBtn" class="danger-btn">${icon("restart")}Restart mock draft</button>`
        : `<button id="resetDraftBtn" class="danger-btn">${icon("restart")}Reset &amp; start a new draft</button>`}
    </div>`;

  el("exportCsvBtn").onclick = () => exportDraftCSV(list, mockMode);
  if (mockMode) {
    el("mockRestartBtn").onclick = () => {
      if (!confirm("Restart your mock draft? This only clears your own practice session.")) return;
      resetMockDraft(DRAFT_ROOM, clientId);
    };
  } else {
    el("resetDraftBtn").onclick = () => {
      if (!confirm("Reset the draft? Results are archived (so future pick suggestions still work), then the board clears for everyone so it can be drafted again.")) return;
      if (!confirm("Really reset now? This clears every device viewing this room and can't be undone.")) return;
      archiveAndClearDraft(DRAFT_ROOM);
    };
  }
}

// ---------- CSV export ----------

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportDraftCSV(picksList = picks, isMock = false) {
  const byTeam = picksByTeam(picksList);
  const predictions = computePredictions(picksList);
  const rows = [];

  rows.push(["Team Rosters"]);
  rows.push(["Team", "Pick #", "Pokemon", "Type 1", "Type 2", "Cost"]);
  for (const t of TEAMS) {
    const teamPicks = byTeam[t.name] || [];
    teamPicks.forEach((p, i) => {
      const mon = POKEMON_LIST.find((m) => m.name === p.pokemon);
      rows.push([t.name, i + 1, p.pokemon, mon?.type1 || "", mon?.type2 || "", p.cost]);
    });
  }

  rows.push([]);
  rows.push(["Projections"]);
  rows.push(["Rank", "Team", "Power Score", "Draft Cost", "Avg Base Stat Total", "Type Coverage", "Projected Record", "Projected Champion"]);
  predictions.forEach((r) => {
    rows.push([r.rank, r.name, r.strength, r.cost, r.avgBST ?? "n/a", r.coverage, r.record, r.rank === 1 ? "Yes" : ""]);
  });

  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${DRAFT_ROOM}-${isMock ? "mock-" : ""}results-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Type effectiveness & classic comps ----------
// Standard attacker -> defender multiplier chart (only non-1x entries
// listed). Used to figure out what a team's roster is exposed to and
// which candidates patch that.
const TYPE_CHART = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};
const ALL_TYPES = Object.keys(TYPE_CHART);

function effectiveness(attackType, defTypes) {
  let mult = 1;
  for (const dt of defTypes) {
    if (!dt) continue;
    const m = TYPE_CHART[attackType]?.[dt];
    mult *= m === undefined ? 1 : m;
  }
  return mult;
}

// Hand-picked classic type pairings that show up again and again in real
// competitive Pokémon comps — a stand-in for "team composition" synergy
// since draft data only has types, not full movesets.
const CORE_SYNERGIES = [
  ["Water", "Fire"], ["Water", "Grass"], ["Fire", "Grass"],
  ["Steel", "Fairy"], ["Ground", "Electric"], ["Flying", "Fighting"],
  ["Water", "Ground"], ["Dragon", "Fairy"], ["Psychic", "Dark"],
  ["Steel", "Dragon"], ["Fairy", "Dark"], ["Ghost", "Psychic"],
  ["Rock", "Water"], ["Ice", "Ground"], ["Steel", "Ground"],
];
function synergyPartners(type) {
  const partners = new Set();
  for (const [a, b] of CORE_SYNERGIES) {
    if (a === type) partners.add(b);
    if (b === type) partners.add(a);
  }
  return partners;
}

// How often `team` has drafted each type across every archived past draft
// in this room. {} for a team with no history — callers treat that as "no
// signal" rather than special-casing it, so a team's very first pick just
// falls back to the other scoring signals below.
function historicTypeAffinity(team) {
  const freq = {};
  for (const h of history) {
    if (h.team !== team) continue;
    const mon = POKEMON_LIST.find((m) => m.name === h.pokemon);
    if (!mon) continue;
    for (const t of [mon.type1, mon.type2]) {
      if (!t) continue;
      freq[t] = (freq[t] || 0) + 1;
    }
  }
  return freq;
}

// Scores every affordable, undrafted Pokémon for `team` against the given
// picks list, blending:
//  - raw power (base stat total, live from PokeAPI)
//  - type-weakness patching (does it cover a hole the roster already has)
//  - classic type-core synergy (a stand-in for "real comps")
//  - historic fit (has this team leaned on this type in past drafts here)
// Cost is only ever a hard affordability cutoff (see the `candidates`
// filter below) — it doesn't push a pick up or down the ranking. A team
// with no draft history in this room scores 0 on the historic-fit signal
// for every candidate, so it has no effect and picks fall back to the
// other three signals — i.e. just the best options left on the list.
function scoreCandidates(team, picksList) {
  const roster = picksByTeam(picksList)[team] || [];
  const taken = pickedNames(picksList);

  const rosterMons = roster.map((p) => POKEMON_LIST.find((m) => m.name === p.pokemon)).filter(Boolean);
  const rosterTypes = new Set();
  rosterMons.forEach((m) => {
    if (m.type1) rosterTypes.add(m.type1);
    if (m.type2) rosterTypes.add(m.type2);
  });

  // How exposed the roster already is to each attacking type.
  const weakness = {};
  for (const atk of ALL_TYPES) {
    let w = 0;
    for (const m of rosterMons) {
      const mult = effectiveness(atk, [m.type1, m.type2]);
      if (mult >= 2) w += mult === 4 ? 2 : 1;
      else if (mult === 0) w -= 0.5;
    }
    weakness[atk] = w;
  }

  // Cost only ever filters out what the team can't afford, or what would
  // leave too little for its remaining roster slots — it never factors
  // into the ranking itself.
  const maxSpend = maxSpendableCost(team, picksList);
  const candidates = POKEMON_LIST.filter((p) => !taken.has(p.name) && p.cost <= maxSpend);
  if (candidates.length === 0) return [];

  const typeAffinity = historicTypeAffinity(team);

  const raw = candidates.map((p) => {
    const meta = metaCache[p.slug];
    const bst = meta?.bst ?? null;
    const power = bst ?? 400; // neutral placeholder before stats load — never cost-derived

    let patch = 0;
    for (const atk of ALL_TYPES) {
      if (weakness[atk] <= 0) continue;
      const mult = effectiveness(atk, [p.type1, p.type2]);
      if (mult === 0) patch += weakness[atk] * 1.5;
      else if (mult < 1) patch += weakness[atk] * 0.75;
      else if (mult >= 2) patch -= weakness[atk] * 0.5; // stacks an existing hole
    }

    let synergy = 0;
    const partners1 = p.type1 ? synergyPartners(p.type1) : new Set();
    const partners2 = p.type2 ? synergyPartners(p.type2) : new Set();
    for (const rt of rosterTypes) {
      if (partners1.has(rt) || partners2.has(rt)) synergy += 1;
    }
    if (p.type1 && !rosterTypes.has(p.type1)) synergy += 0.3;
    if (p.type2 && !rosterTypes.has(p.type2)) synergy += 0.3;

    const hist = (typeAffinity[p.type1] || 0) + (typeAffinity[p.type2] || 0);

    return { ...p, bst, power, patch, synergy, hist };
  });

  const norm = (key) => {
    const vals = raw.map((r) => r[key]);
    const min = Math.min(...vals);
    const span = Math.max(...vals) - min || 1;
    return (v) => (v - min) / span;
  };
  const nPower = norm("power"), nPatch = norm("patch"), nSynergy = norm("synergy"), nHist = norm("hist");

  const scored = raw.map((r) => {
    const score = 0.35 * nPower(r.power) + 0.35 * nPatch(r.patch) + 0.15 * nSynergy(r.synergy) + 0.15 * nHist(r.hist);
    let reason = r.bst ? `strong stats — ${r.bst} BST` : "solid all-around pick";
    if (nPatch(r.patch) > 0.7) reason = "covers a type hole in your roster";
    else if (r.hist > 0 && nHist(r.hist) > 0.7) {
      const favType = (typeAffinity[r.type1] || 0) >= (typeAffinity[r.type2] || 0) ? r.type1 : r.type2;
      reason = `${team} has favored ${favType}-type in past drafts`;
    } else if (nSynergy(r.synergy) > 0.7 && rosterTypes.size) reason = "classic type-core fit with your team";
    return { ...r, score, reason };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function computeSuggestions(team, picksList = picks, limit = 4) {
  return scoreCandidates(team, picksList).slice(0, limit);
}

// A bot's pick: weighted-random among its top few scored candidates so
// mock drafts aren't perfectly deterministic. Falls back to the cheapest
// available mon if nothing is affordable, so the draft never stalls.
function chooseBotPick(team, picksList) {
  const scored = scoreCandidates(team, picksList);
  if (scored.length === 0) {
    // Nothing satisfies the slot-reserve rule (should be rare — it means
    // an earlier pick already ate into the reserve). Fall back to the
    // cheapest mon the team can still actually afford, so the draft never
    // stalls or goes over budget.
    const taken = pickedNames(picksList);
    const spent = costsByTeam(picksList)[team] || 0;
    const remaining = (TEAM_BUDGETS[team] ?? 100) - spent;
    return POKEMON_LIST.filter((p) => !taken.has(p.name) && p.cost <= remaining).sort((a, b) => a.cost - b.cost)[0] || null;
  }
  const pool = scored.slice(0, Math.min(5, scored.length));
  const weights = pool.map((p) => Math.max(0.05, p.score));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[0];
}

function renderSuggestions() {
  const box = el("suggestions");
  if (!box) return;

  const team = activeMyTeam();
  const turn = activeTurnTeam();
  const relevantlyActive = mockMode ? !!(mockStatus?.active && iAmLockedIn()) : !finalized;
  const shouldShow = suggestionsEnabled && team && turn === team && relevantlyActive;
  if (!shouldShow) {
    box.classList.remove("show");
    box.innerHTML = "";
    return;
  }

  const items = computeSuggestions(team, activeList());
  box.classList.add("show");

  if (items.length === 0) {
    box.innerHTML = `<div class="suggestions-empty">Nothing left in the pool fits ${team}'s remaining budget.</div>`;
    return;
  }

  box.innerHTML = `
    <div class="suggestions-head">Suggested for ${team} — stats, typing, team fit &amp; history</div>
    <div class="suggestions-list">
      ${items
        .map(
          (p) => `
        <button class="suggestion-chip" data-name="${p.name}" title="${p.reason}">
          ${spriteBox(p, "xs")}
          <span class="sugg-name">${p.name}</span>
          <span class="sugg-cost">${p.cost}</span>
        </button>`
        )
        .join("")}
    </div>`;

  box.querySelectorAll(".suggestion-chip").forEach((btn) => {
    btn.onclick = () => draftPokemon(btn.dataset.name);
  });
  hydrateSprites(box);
}

// ---------- Mock draft panel ----------

function renderMockBar() {
  const bar = el("mockBar");
  if (!bar) return;
  document.body.classList.toggle("mock-active", mockMode);

  if (!mockMode) {
    bar.innerHTML = `<button id="mockToggleOn" class="secondary-btn mock-enter-btn">Try a mock draft — practice vs. bots</button>`;
    el("mockToggleOn").onclick = () => {
      mockMode = true;
      localStorage.setItem("draft_mock_mode", "1");
      renderAll();
      maybeScheduleBotMove();
    };
    return;
  }

  if (!iAmLockedIn()) {
    bar.innerHTML = `
      <div class="mock-setup">
        <div class="mock-setup-head">Mock Draft Mode — your own private practice run against bots. Pick your team to begin.</div>
        <div class="mock-setup-row">
          <select id="mockTeamSelect">
            <option value="">Choose your team…</option>
            ${TEAMS.map(
              (t) => `<option value="${t.name}" ${t.name === mockMyTeam ? "selected" : ""}>${t.name}</option>`
            ).join("")}
          </select>
          <button id="mockStartBtn" class="finalize-btn mock-start-btn">Start Mock Draft</button>
          <button id="mockExitBtn" class="link-btn">Exit mock mode</button>
        </div>
      </div>`;
    el("mockTeamSelect").onchange = (e) => {
      mockMyTeam = e.target.value;
    };
    el("mockStartBtn").onclick = async () => {
      if (!mockMyTeam) {
        alert("Choose a team first.");
        return;
      }
      localStorage.setItem("draft_mock_team", mockMyTeam);
      await startMockSession(DRAFT_ROOM, clientId, mockMyTeam);
      renderAll();
      maybeScheduleBotMove();
    };
    el("mockExitBtn").onclick = () => {
      mockMode = false;
      localStorage.setItem("draft_mock_mode", "0");
      renderAll();
    };
    return;
  }

  bar.innerHTML = `
    <div class="mock-setup locked">
      <span>Mock draft — locked in as <b>${mockMyTeam}</b>. Every other team is bot-controlled. This is your own private practice run — no one else can see or affect it.</span>
      <div class="mock-setup-row">
        <button id="mockResetBtn" class="danger-btn small">${icon("restart")}Restart mock draft</button>
        <button id="mockExitBtn" class="link-btn">Exit mock mode</button>
      </div>
    </div>`;
  el("mockResetBtn").onclick = () => {
    if (!confirm("Restart your mock draft? This only clears your own practice session.")) return;
    resetMockDraft(DRAFT_ROOM, clientId);
  };
  el("mockExitBtn").onclick = () => {
    mockMode = false;
    localStorage.setItem("draft_mock_mode", "0");
    renderAll();
  };
}

// If it's a bot's turn in an active mock session, schedule that bot to
// "think" for a moment and then submit a pick. Any connected client in
// mock mode can trigger this — submitMockPick's transaction guarantees
// only one write actually lands even if several clients race.
function maybeScheduleBotMove() {
  if (mockBotTimer) {
    clearTimeout(mockBotTimer);
    mockBotTimer = null;
  }
  if (!mockMode || !mockStatus?.active) return;
  const turn = currentTurnTeam(mockPicks);
  if (!turn) return; // mock draft complete
  if (turn === mockMyTeam) return; // your turn, not a bot's

  mockBotTimer = setTimeout(() => {
    const pick = chooseBotPick(turn, mockPicks);
    if (pick) submitMockPick(DRAFT_ROOM, clientId, DRAFT_ORDER, turn, pick.name, pick.cost);
  }, 700 + Math.random() * 900);
}

function renderAll() {
  renderMockBar();
  renderStatus();
  renderLastPick();
  renderFinalizeControl();
  renderBoard();
  renderSuggestions();
  renderPool();
  renderPredictions();
  hydrateSprites(el("board"));
}

// ---------- Actions ----------

function draftPokemon(name) {
  const mon = POKEMON_LIST.find((p) => p.name === name);
  if (!mon) return;

  if (mockMode) {
    if (!mockStatus?.active) {
      alert("Start the mock draft first.");
      return;
    }
    if (!iAmLockedIn()) {
      alert("Pick a team and hit Start Mock Draft to play.");
      return;
    }
    const turn = activeTurnTeam();
    if (turn !== mockMyTeam) {
      alert(`It's not your turn — ${turn} is on the clock.`);
      return;
    }
    const spent = costsByTeam(mockPicks)[mockMyTeam] || 0;
    const remaining = (TEAM_BUDGETS[mockMyTeam] ?? 100) - spent;
    if (mon.cost > remaining) {
      alert(`${name} costs ${mon.cost} pts — you only have ${remaining} left.`);
      return;
    }
    const maxSpend = maxSpendableCost(mockMyTeam, mockPicks);
    if (mon.cost > maxSpend) {
      alert(slotReserveMessage(name, mon, mockMyTeam, mockPicks, remaining));
      return;
    }
    submitMockPick(DRAFT_ROOM, clientId, DRAFT_ORDER, mockMyTeam, mon.name, mon.cost);
    return;
  }

  if (finalized) return;
  const turn = currentTurnTeam();
  if (turn !== myTeam) {
    alert(`It's not your turn — ${turn} is on the clock.`);
    return;
  }
  const spent = costsByTeam()[myTeam] || 0;
  const remaining = (TEAM_BUDGETS[myTeam] ?? 100) - spent;
  if (mon.cost > remaining) {
    alert(`${name} costs ${mon.cost} pts — you only have ${remaining} left.`);
    return;
  }
  const maxSpend = maxSpendableCost(myTeam, picks);
  if (mon.cost > maxSpend) {
    alert(slotReserveMessage(name, mon, myTeam, picks, remaining));
    return;
  }
  if (!confirm(`Draft ${name} for ${mon.cost} pts?`)) return;
  addPick({ team: myTeam, pokemon: mon.name, cost: mon.cost });
}

// Explains why a pick is blocked: it would leave fewer points than the
// team's remaining (post-pick) roster slots require at MIN_MON_COST each.
function slotReserveMessage(name, mon, team, picksList, remaining) {
  const rosterLen = (picksByTeam(picksList)[team] || []).length;
  const slotsLeftAfter = Math.max(0, NUM_ROUNDS - rosterLen - 1);
  const leftover = remaining - mon.cost;
  return `Drafting ${name} would leave ${team} with only ${leftover} pt${leftover === 1 ? "" : "s"} for ${slotsLeftAfter} remaining pick${slotsLeftAfter === 1 ? "" : "s"} — you need at least ${MIN_MON_COST} pt${MIN_MON_COST === 1 ? "" : "s"} per pick left. Choose something cheaper.`;
}

// ---------- Wire up ----------

function init() {
  renderIdentityBar();

  el("teamSelect").addEventListener("change", (e) => {
    myTeam = e.target.value;
    localStorage.setItem("draft_my_team", myTeam);
    renderAll();
  });

  el("search").addEventListener("input", (e) => {
    searchTerm = e.target.value;
    renderPool();
  });

  el("suggestToggle").checked = suggestionsEnabled;
  el("suggestToggle").addEventListener("change", (e) => {
    suggestionsEnabled = e.target.checked;
    localStorage.setItem("draft_suggestions_enabled", suggestionsEnabled ? "1" : "0");
    renderAll();
  });

  initFirebase(FIREBASE_CONFIG, DRAFT_ROOM);
  subscribeToPicks((newPicks) => {
    picks = newPicks;
    renderAll();
  });
  subscribeToFinalized(DRAFT_ROOM, (data) => {
    finalized = !!data?.done;
    finalizedBy = data?.by || null;
    renderAll();
  });
  subscribeToHistory(DRAFT_ROOM, (flatPicks) => {
    history = flatPicks;
    renderAll();
  });
  subscribeToMockPicks(DRAFT_ROOM, clientId, (list) => {
    mockPicks = list;
    renderAll();
    maybeScheduleBotMove();
  });
  subscribeToMockStatus(DRAFT_ROOM, clientId, (status) => {
    mockStatus = status;
    // Resume with the team this session was started as, e.g. after a
    // reload — keeps the private session consistent with itself.
    if (status?.team && status.team !== mockMyTeam) {
      mockMyTeam = status.team;
      localStorage.setItem("draft_mock_team", mockMyTeam);
    }
    renderAll();
    maybeScheduleBotMove();
  });
}

init();
