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
} from "./firebase-sync.js?v=1"; // bump alongside CACHE_BUST in index.html

// ---------- Self-heal on a broken startup ----------
// If something throws during module-level setup below (a corrupted
// localStorage value, or any other unexpected startup error), the page
// would otherwise be stuck forever on its empty HTML shell with nothing
// visibly wrong to a non-technical user. As a last-resort safety net,
// wipe this app's local storage once and force a genuinely fresh load —
// the one-shot sessionStorage guard prevents a real code bug from
// looping reloads forever.
//
// A plain location.reload() isn't enough here: it respects the browser's
// normal HTTP cache, so if the *page itself* (index.html) is what's
// stale — not just app.js — reloading can just re-fetch the same cached
// HTML pointing at the same broken/old script and hit the identical
// error again. Navigating to a cache-busted URL (a query param the
// browser has never seen) forces every layer of caching to be bypassed,
// guaranteeing the next load is completely fresh.
window.addEventListener(
  "error",
  () => {
    if (sessionStorage.getItem("draft_recovered_once")) return;
    try {
      sessionStorage.setItem("draft_recovered_once", "1");
      Object.keys(localStorage)
        .filter((k) => k.startsWith("draft_"))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      // ignore — if storage itself is unusable there's nothing more to clear
    }
    const url = new URL(location.href);
    url.searchParams.set("_recover", Date.now().toString());
    location.replace(url.toString());
  },
  { once: true }
);

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
// A corrupted cache (e.g. a browser crash mid-write) would otherwise throw
// here and halt the entire script before init() ever runs, leaving the
// page stuck on its empty HTML shell forever. Fall back to a fresh cache
// and wipe the bad value instead of taking the whole app down with it.
let metaCache;
try {
  metaCache = JSON.parse(localStorage.getItem(META_CACHE_KEY) || "{}");
} catch {
  metaCache = {};
  localStorage.removeItem(META_CACHE_KEY);
}

function persistMetaCache() {
  localStorage.setItem(META_CACHE_KEY, JSON.stringify(metaCache));
}

// Every render re-scans its container for uncached sprites and fires a
// fetch for each — on a cold cache, the pool alone can have ~269 uncached
// cards, and renderAll() runs on every single pick. Without a cap, that's
// hundreds of simultaneous requests repeated every second during an
// active mock draft, which can bog a browser down badly enough to look
// frozen. Route every meta fetch through a small concurrency-limited
// queue instead of letting them all fire at once.
const MAX_CONCURRENT_META_FETCHES = 6;
let activeMetaFetches = 0;
const metaFetchQueue = [];
function pumpMetaFetchQueue() {
  while (activeMetaFetches < MAX_CONCURRENT_META_FETCHES && metaFetchQueue.length) {
    const job = metaFetchQueue.shift();
    activeMetaFetches++;
    job().finally(() => {
      activeMetaFetches--;
      pumpMetaFetchQueue();
    });
  }
}
function enqueueMetaFetch(job) {
  return new Promise((resolve) => {
    metaFetchQueue.push(() => job().then(resolve));
    pumpMetaFetchQueue();
  });
}

// Returns a Promise<{spriteUrl, bst}> — bst (base stat total) is null when
// PokeAPI doesn't recognize the slug (e.g. a Champions-exclusive Mega/form).
async function getPokemonMeta(slug) {
  if (slug in metaCache) return metaCache[slug];
  return enqueueMetaFetch(async () => {
    // Re-check — another queued call for the same slug may have already
    // resolved and cached it while this one was waiting its turn.
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
  });
}

// Coalesces bursts of "a stat just streamed in" signals into a single
// predictions re-render instead of one per resolved sprite.
let refreshPredictionsTimer = null;
function scheduleRefreshPredictions() {
  if (refreshPredictionsTimer) return;
  refreshPredictionsTimer = setTimeout(() => {
    refreshPredictionsTimer = null;
    renderPredictions();
  }, 150);
}

// After cards are in the DOM, fill in every [data-slug] image lazily, and
// nudge the predictions panel to redraw with sharper data as base stats
// stream in (a no-op if the draft isn't finalized yet).
//
// Pass { silent: true } when hydrating content that predictions itself
// just rendered (its own MVP sprites) — without it, each of those images
// resolving would trigger another full renderPredictions() call, which
// creates a fresh batch of its own images, which each trigger yet
// another render... an unbounded, self-amplifying loop that pegs the
// main thread solid once a draft completes. Only genuinely new data (a
// cache miss) schedules a refresh at all; a cache hit changes nothing
// worth re-rendering for.
function hydrateSprites(container, { silent = false } = {}) {
  const imgs = container.querySelectorAll("img[data-slug]");
  imgs.forEach(async (img) => {
    const slug = img.dataset.slug;
    const wasCached = slug in metaCache;
    const meta = await getPokemonMeta(slug);
    if (meta.spriteUrl) {
      img.src = meta.spriteUrl;
      img.classList.add("loaded");
    } else {
      img.closest(".sprite-box")?.classList.add("no-art");
    }
    if (!silent && !wasCached && (finalized || (mockMode && currentTurnTeam(mockPicks) === null))) {
      scheduleRefreshPredictions();
    }
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

// Team objects in "on the clock first" order: whoever picks next leads,
// followed by the actual upcoming turn sequence pulled straight from
// DRAFT_ORDER — so this automatically follows snake (round order flips)
// or fixed/custom (it doesn't) without knowing which mode is active.
// Once real upcoming turns run out (the last few picks of the draft),
// any teams not yet seen are appended in their original TEAMS order.
function boardOrderTeams(list) {
  const order = [];
  const seen = new Set();
  for (let i = list.length; i < DRAFT_ORDER.length && order.length < TEAMS.length; i++) {
    const name = DRAFT_ORDER[i];
    if (seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  for (const t of TEAMS) {
    if (order.length >= TEAMS.length) break;
    if (!seen.has(t.name)) {
      seen.add(t.name);
      order.push(t.name);
    }
  }
  return order.map((name) => TEAMS.find((t) => t.name === name));
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
  el("board").innerHTML = boardOrderTeams(list).map((t) => {
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
// Records come from a true single round-robin: every team plays every
// other team exactly once, so a league of N teams gets a record out of
// N-1 games. If a mon's stats haven't loaded yet (or PokeAPI doesn't know
// a Champions-exclusive form), that team quietly falls back toward a
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

// A tiny seeded PRNG (mulberry32) plus a string hash, so the playoff
// bracket "simulates" real single-game outcomes (unlike the round-robin
// record, which uses expected-value win probabilities) while still being
// stable across re-renders of the same roster/stat data — it only
// reshuffles when something about the standings actually changes, not
// every time the page happens to re-render.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Simulates one game as an actual random draw (not an expected value) —
// that's what lets an underdog upset a higher seed in the bracket.
function simulateGame(rng, teamA, teamB, strengthByTeam) {
  const pA = winProbability(strengthByTeam[teamA.name], strengthByTeam[teamB.name]);
  return rng() < pA ? teamA : teamB;
}

// Top-4-seed single-elimination bracket: #1 vs #4 and #2 vs #3 in the
// semifinals, winners meet in the final. The champion is whoever wins
// out the bracket, not necessarily the #1 regular-season seed — a lower
// seed can absolutely upset its way to the title.
function computePlayoffBracket(standings, strengthByTeam) {
  if (standings.length < 4) return null;
  const seeds = standings.slice(0, 4);
  const rng = mulberry32(hashString(standings.map((r) => `${r.name}:${r.strength}`).join("|")));

  const semiA = { teamA: seeds[0], teamB: seeds[3] };
  const semiB = { teamA: seeds[1], teamB: seeds[2] };
  semiA.winner = simulateGame(rng, semiA.teamA, semiA.teamB, strengthByTeam);
  semiB.winner = simulateGame(rng, semiB.teamA, semiB.teamB, strengthByTeam);

  const final = { teamA: semiA.winner, teamB: semiB.winner };
  final.winner = simulateGame(rng, final.teamA, final.teamB, strengthByTeam);

  return { seeds, semiA, semiB, final, champion: final.winner };
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

// ---------- Matchup-aware doubles simulation ----------
// The real league plays doubles with each side choosing 4 of their 10
// drafted Pokémon per matchup. You know your opponent's full drafted
// roster going in — just not which 4 they'll actually bring — so the
// modeled strategy here is "pick the 4 that best answer their entire
// roster": strong on their own stats, good average offense into
// whatever the opponent could send out, and not broadly walled by them
// defensively. That selection is redone for every scheduled game, since
// the right 4 depends on who you're facing.

function rosterMonObjects(teamPicks) {
  return teamPicks
    .map((p) => {
      const mon = POKEMON_LIST.find((m) => m.name === p.pokemon);
      if (!mon) return null;
      const bst = metaCache[mon.slug]?.bst ?? null;
      return { ...mon, cost: p.cost, bst: bst ?? 400 };
    })
    .filter(Boolean);
}

// The strongest single-hit multiplier `attacker` can land on `defender`,
// using whichever of its (up to two) types is more effective.
function bestOffenseMultiplier(attacker, defender) {
  const m1 = effectiveness(attacker.type1, [defender.type1, defender.type2]);
  const m2 = attacker.type2 ? effectiveness(attacker.type2, [defender.type1, defender.type2]) : 0;
  return Math.max(m1, m2);
}

// Greedily picks the 4 mons from `myRoster` that best answer `oppRoster`
// as a whole, since the opponent's specific 4-mon pick is unknown.
function pickMatchupLineup(myRoster, oppRoster) {
  if (myRoster.length <= 4) return myRoster;
  const n = oppRoster.length || 1;
  const scored = myRoster.map((mon) => {
    let atkSum = 0, defSum = 0;
    for (const opp of oppRoster) {
      atkSum += bestOffenseMultiplier(mon, opp);
      defSum += bestOffenseMultiplier(opp, mon);
    }
    const avgAtk = atkSum / n;
    const avgDef = defSum / n; // lower is better — less exposure to the opponent's pool
    return { mon, score: mon.bst / 6 + avgAtk * 12 - avgDef * 8 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map((s) => s.mon);
}

// One simulated doubles game between two chosen 4-mon lineups. A "wipe"
// is an opposing mon that this lineup has a >=2x edge into from at least
// one of its own mons — a rough proxy for "we'd knock that thing out."
// Each wipe is credited to whichever specific mon earned it, for MVP
// tracking. Game power blends average lineup BST with wipes dealt vs.
// taken.
function evaluateMatchup(lineupA, lineupB) {
  const creditsA = new Map(), creditsB = new Map();

  const countWipes = (attackers, defenders, credits) => {
    let wipes = 0;
    for (const d of defenders) {
      let best = null, bestMult = -1;
      for (const a of attackers) {
        const mult = bestOffenseMultiplier(a, d);
        if (mult > bestMult) { bestMult = mult; best = a; }
      }
      if (bestMult >= 2) {
        wipes++;
        credits.set(best.name, (credits.get(best.name) || 0) + 1);
      }
    }
    return wipes;
  };

  const wipesA = countWipes(lineupA, lineupB, creditsA);
  const wipesB = countWipes(lineupB, lineupA, creditsB);

  const avgBstA = lineupA.reduce((s, m) => s + m.bst, 0) / lineupA.length;
  const avgBstB = lineupB.reduce((s, m) => s + m.bst, 0) / lineupB.length;

  const powerA = avgBstA / 6 + wipesA * 6 - wipesB * 3;
  const powerB = avgBstB / 6 + wipesB * 6 - wipesA * 3;

  return { powerA, powerB, creditsA, creditsB };
}

// A mon's net type-effectiveness edge against every other drafted mon in
// the league (excluding its own teammates, who it never fights) — a
// season-long "how good is this typing against the whole field" signal,
// independent of any one scheduled matchup.
function leagueEffectivenessScore(mon, allOtherMons) {
  if (!allOtherMons.length) return 0;
  let net = 0;
  for (const other of allOtherMons) {
    net += bestOffenseMultiplier(mon, other) - bestOffenseMultiplier(other, mon);
  }
  return net / allOtherMons.length;
}

function computePredictions(picksList = picks) {
  const teamNames = TEAMS.map((t) => t.name);
  const powerByTeam = Object.fromEntries(teamNames.map((n) => [n, computeTeamPower(n, picksList)]));
  const byTeam = picksByTeam(picksList);
  const rosterByTeam = Object.fromEntries(teamNames.map((n) => [n, rosterMonObjects(byTeam[n] || [])]));

  // A true single round-robin: every team plays every other team exactly
  // once, so N teams get a record out of N-1 games. With an odd team
  // count, generateRoundRobinSchedule needs N rounds (one bye round per
  // team) to still seat every matchup exactly once — either way, no
  // matchup repeats and every real game is counted exactly once.
  const gamesPerTeam = teamNames.length - 1;
  const hasByeWeek = teamNames.length % 2 !== 0;
  const totalRounds = hasByeWeek ? teamNames.length : gamesPerTeam;
  const schedule = generateRoundRobinSchedule(teamNames, totalRounds);

  const expectedWins = Object.fromEntries(teamNames.map((n) => [n, 0]));
  // Per-mon MVP tallies: how often each mon got picked into that team's
  // matchup lineup, and how many wipes it personally earned.
  const mvpTally = Object.fromEntries(
    teamNames.map((n) => [n, Object.fromEntries(rosterByTeam[n].map((m) => [m.name, { appearances: 0, wipes: 0 }]))])
  );

  for (const week of schedule) {
    for (const [a, b] of week) {
      const rosterA = rosterByTeam[a], rosterB = rosterByTeam[b];
      const lineupA = pickMatchupLineup(rosterA, rosterB);
      const lineupB = pickMatchupLineup(rosterB, rosterA);
      const { powerA, powerB, creditsA, creditsB } = evaluateMatchup(lineupA, lineupB);

      const pA = winProbability(powerA, powerB);
      expectedWins[a] += pA;
      expectedWins[b] += 1 - pA;

      for (const mon of lineupA) mvpTally[a][mon.name].appearances++;
      for (const mon of lineupB) mvpTally[b][mon.name].appearances++;
      for (const [name, count] of creditsA) mvpTally[a][name].wipes += count;
      for (const [name, count] of creditsB) mvpTally[b][name].wipes += count;
    }
  }

  // MVP per team: best blend of how often it played, how many wipes it
  // earned per game played, and its type-effectiveness edge against the
  // whole league's drafted pool.
  const mvpByTeam = {};
  for (const name of teamNames) {
    const others = teamNames.filter((n) => n !== name).flatMap((n) => rosterByTeam[n]);
    let best = null;
    for (const mon of rosterByTeam[name]) {
      const tally = mvpTally[name][mon.name];
      const apps = tally.appearances / gamesPerTeam;
      const wipeRate = tally.wipes / gamesPerTeam;
      const leagueEdge = leagueEffectivenessScore(mon, others);
      const score = apps * 0.25 + wipeRate * 0.5 + leagueEdge * 0.25;
      if (!best || score > best.score) best = { mon, appearances: tally.appearances, wipes: tally.wipes, leagueEdge, score };
    }
    mvpByTeam[name] = best;
  }

  const maxStrength = Math.max(...teamNames.map((n) => powerByTeam[n].power), 1);

  const standings = teamNames.map((name) => {
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
      record: `${wins}-${gamesPerTeam - wins}`,
      mvp: mvpByTeam[name],
    };
  });

  standings.sort((a, b) => b.expectedWins - a.expectedWins || b.strength - a.strength);
  standings.forEach((r, i) => (r.rank = i + 1));

  // The playoff bracket keeps using season-long team power (not the
  // matchup-specific lineups) — that's the randomness the user already
  // approved, and best-of-one playoff games aren't scheduled matchups
  // with a known opponent roster the same way round-robin games are.
  const strengthByTeam = Object.fromEntries(teamNames.map((n) => [n, powerByTeam[n].power]));
  const bracket = computePlayoffBracket(standings, strengthByTeam);
  return { standings, bracket, gamesPerTeam };
}

function bracketTeamRow(team, winner) {
  const isWinner = winner && winner.name === team.name;
  return `
    <div class="bracket-team ${isWinner ? "winner" : ""}">
      <span class="bracket-seed">#${team.rank}</span>
      <span class="bracket-name">${team.name}</span>
      ${isWinner ? icon("check", "bracket-check") : ""}
    </div>`;
}
function bracketMatchupHTML(m) {
  return `
    <div class="bracket-matchup">
      ${bracketTeamRow(m.teamA, m.winner)}
      ${bracketTeamRow(m.teamB, m.winner)}
    </div>`;
}
function renderBracketHTML(bracket, mockMode) {
  return `
    <div class="champion-card">
      <span class="crown">${ICON.trophy}</span>
      <div>
        <div class="champion-label">${mockMode ? "Mock Playoff Champion" : "Playoff Champion"}</div>
        <div class="champion-name">${bracket.champion.name}</div>
      </div>
    </div>
    <div class="bracket">
      <div class="bracket-round">
        <div class="bracket-round-label">Semifinals</div>
        ${bracketMatchupHTML(bracket.semiA)}
        ${bracketMatchupHTML(bracket.semiB)}
      </div>
      <div class="bracket-round">
        <div class="bracket-round-label">Final</div>
        ${bracketMatchupHTML(bracket.final)}
      </div>
    </div>`;
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

  const { standings, bracket, gamesPerTeam } = computePredictions(list);
  const stillLoading = standings.some((r) => r.statsCoveragePct < 100);
  container.classList.add("show");
  container.innerHTML = `
    <div class="predictions-head">
      <div class="eyebrow">${mockMode ? "Mock Draft Projection" : "Season Projection"}</div>
      <h2>${mockMode ? "Your Practice Draft — Standings &amp; Playoffs" : "Projected Standings &amp; Playoffs"}</h2>
      <p>Every round-robin game picks each side's best 4-of-10 doubles lineup against the OTHER team's entire drafted roster (you know what they drafted, not which 4 they'll bring), then compares average stats plus simulated "wipes" — favorable type matchups — to set the odds. Every team plays every other team once, for a record out of ${gamesPerTeam}. The top 4 then run a single-elimination bracket, simulated game by game, so the eventual champion isn't guaranteed to be the #1 seed. MVP blends how often a mon made the lineup, how many wipes it earned, and its type-effectiveness edge against the whole league. For fun — not an official schedule.${mockMode ? " This is your own private practice run, not the real draft." : ""}</p>
      ${stillLoading ? `<p class="stats-loading-note">Still pulling live base stats for some Pokémon — this refines automatically as they load.</p>` : ""}
    </div>
    ${bracket ? renderBracketHTML(bracket, mockMode) : ""}
    <div class="predictions-table">
      <div class="pred-row pred-row-head">
        <span class="pred-rank"></span>
        <span class="pred-team">Team</span>
        <span class="pred-sub">Avg BST</span>
        <span class="pred-mvp-head">MVP</span>
        <div class="pred-bar"></div>
        <span class="pred-strength">Power</span>
        <span class="pred-record">Record</span>
      </div>
      ${standings
        .map((r) => {
          const mvp = r.mvp;
          const mvpTitle = mvp
            ? `${mvp.mon.name}: ${mvp.appearances}/${gamesPerTeam} games, ${mvp.wipes} wipes, ${mvp.leagueEdge >= 0 ? "+" : ""}${mvp.leagueEdge.toFixed(2)} league type edge`
            : "";
          return `
        <div class="pred-row ${r.rank <= 4 ? "seeded" : ""}">
          <span class="pred-rank">#${r.rank}</span>
          <span class="pred-team">${r.name}${r.rank <= 4 ? `<span class="seed-tag">SEED ${r.rank}</span>` : ""}</span>
          <span class="pred-sub">${r.avgBST != null ? r.avgBST : "—"}</span>
          <span class="pred-mvp" title="${mvpTitle}">${mvp ? spriteBox(mvp.mon, "xs") : ""}<span class="pred-mvp-name">${mvp ? mvp.mon.name : "—"}</span></span>
          <div class="pred-bar"><div class="pred-bar-fill" style="width:${r.strengthPct}%"></div></div>
          <span class="pred-strength">${r.strength}</span>
          <span class="pred-record">${r.record}</span>
        </div>`;
        })
        .join("")}
    </div>
    <div class="predictions-actions">
      <button id="exportCsvBtn" class="secondary-btn">${icon("download")}Export CSV</button>
      ${mockMode
        ? `<button id="mockRestartBtn" class="danger-btn">${icon("restart")}Restart mock draft</button>`
        : `<button id="resetDraftBtn" class="danger-btn">${icon("restart")}Reset &amp; start a new draft</button>`}
    </div>`;
  hydrateSprites(container, { silent: true });

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
  const { standings, bracket, gamesPerTeam } = computePredictions(picksList);
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
  rows.push([`Round-Robin Standings (record out of ${gamesPerTeam})`]);
  rows.push(["Rank", "Team", "Power Score", "Draft Cost", "Avg Base Stat Total", "Type Coverage", "Record", "Playoff Seed", "MVP", "MVP Appearances", "MVP Wipes", "MVP League Type Edge"]);
  standings.forEach((r) => {
    const mvp = r.mvp;
    rows.push([
      r.rank, r.name, r.strength, r.cost, r.avgBST ?? "n/a", r.coverage, r.record, r.rank <= 4 ? r.rank : "",
      mvp ? mvp.mon.name : "", mvp ? `${mvp.appearances}/${gamesPerTeam}` : "", mvp ? mvp.wipes : "", mvp ? mvp.leagueEdge.toFixed(2) : "",
    ]);
  });

  if (bracket) {
    rows.push([]);
    rows.push(["Playoff Bracket"]);
    rows.push(["Round", "Matchup", "Winner"]);
    rows.push(["Semifinal", `#${bracket.semiA.teamA.rank} ${bracket.semiA.teamA.name} vs #${bracket.semiA.teamB.rank} ${bracket.semiA.teamB.name}`, bracket.semiA.winner.name]);
    rows.push(["Semifinal", `#${bracket.semiB.teamA.rank} ${bracket.semiB.teamA.name} vs #${bracket.semiB.teamB.rank} ${bracket.semiB.teamB.name}`, bracket.semiB.winner.name]);
    rows.push(["Final", `${bracket.final.teamA.name} vs ${bracket.final.teamB.name}`, bracket.final.winner.name]);
    rows.push(["Champion", "", bracket.champion.name]);
  }

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

  mockBotTimer = setTimeout(async () => {
    const pick = chooseBotPick(turn, mockPicks);
    if (!pick) return;
    const ok = await submitMockPick(DRAFT_ROOM, clientId, DRAFT_ORDER, turn, pick.name, pick.cost);
    // A failed submission (e.g. a dropped connection) otherwise leaves
    // the draft stuck forever — nothing else re-triggers this bot's turn
    // since no new Firebase update ever arrives if the write never
    // landed. Retry rather than silently giving up.
    if (!ok) maybeScheduleBotMove();
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
