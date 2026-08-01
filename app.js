import {
  initFirebase,
  subscribeToPicks,
  addPick,
  removePickByKey,
  subscribeToFinalized,
  setFinalized,
  archiveAndClearDraft,
  subscribeToHistory,
} from "./firebase-sync.js";

const TYPE_COLORS = {
  Normal: "#A8A878", Fire: "#EE8130", Water: "#6390F0", Electric: "#F7D02C",
  Grass: "#7AC74C", Ice: "#96D9D6", Fighting: "#C22E28", Poison: "#A33EA1",
  Ground: "#E2BF65", Flying: "#A98FF3", Psychic: "#F95587", Bug: "#A6B91A",
  Rock: "#B6A136", Ghost: "#735797", Dragon: "#6F35FC", Dark: "#705746",
  Steel: "#B7B7CE", Fairy: "#D685AD",
};

let picks = []; // synced from Firebase, oldest -> newest
let myTeam = localStorage.getItem("draft_my_team") || "";
let searchTerm = "";
let finalized = false; // true once someone has confirmed the teams are official
let finalizedBy = null;
let history = []; // flat list of picks from past archived drafts in this room
let suggestionsEnabled = localStorage.getItem("draft_suggestions_enabled") === "1";

const el = (id) => document.getElementById(id);

function typeBadge(t) {
  if (!t) return "";
  return `<span class="type-badge" style="background:${TYPE_COLORS[t] || "#888"}">${t}</span>`;
}

// ---------- Sprite loading (PokeAPI, client-side, cached) ----------
// Results cache to localStorage so repeat visits don't re-fetch 269 mons.
const SPRITE_CACHE_KEY = "draft_sprite_cache_v1";
const spriteCache = JSON.parse(localStorage.getItem(SPRITE_CACHE_KEY) || "{}");

function persistSpriteCache() {
  localStorage.setItem(SPRITE_CACHE_KEY, JSON.stringify(spriteCache));
}

// Returns a Promise<string|null> — image URL, or null if unavailable
// (e.g. a Champions-exclusive Mega/form PokeAPI doesn't know about yet).
async function getSpriteUrl(slug) {
  if (slug in spriteCache) return spriteCache[slug];
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const url =
      data?.sprites?.other?.["official-artwork"]?.front_default ||
      data?.sprites?.front_default ||
      null;
    spriteCache[slug] = url;
    persistSpriteCache();
    return url;
  } catch {
    spriteCache[slug] = null;
    persistSpriteCache();
    return null;
  }
}

// After cards are in the DOM, fill in every [data-slug] image lazily.
function hydrateSprites(container) {
  const imgs = container.querySelectorAll("img[data-slug]");
  imgs.forEach(async (img) => {
    const slug = img.dataset.slug;
    const url = await getSpriteUrl(slug);
    if (url) {
      img.src = url;
      img.classList.add("loaded");
    } else {
      img.closest(".sprite-box")?.classList.add("no-art");
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

function pickedNames() {
  return new Set(picks.map((p) => p.pokemon));
}

function costsByTeam() {
  const out = {};
  for (const t of TEAMS) out[t.name] = 0;
  for (const p of picks) out[p.team] = (out[p.team] || 0) + p.cost;
  return out;
}

function picksByTeam() {
  const out = {};
  for (const t of TEAMS) out[t.name] = [];
  for (const p of picks) out[p.team]?.push(p);
  return out;
}

function currentTurnTeam() {
  if (picks.length >= DRAFT_ORDER.length) return null; // draft complete
  return DRAFT_ORDER[picks.length];
}

function currentRound() {
  return Math.min(picks.length, DRAFT_ORDER.length - 1) < 0
    ? 1
    : Math.floor(Math.min(picks.length, DRAFT_ORDER.length - 1) / TEAMS.length) + 1;
}

// ---------- Rendering ----------

function renderIdentityBar() {
  el("teamSelect").innerHTML =
    `<option value="">Choose your team…</option>` +
    TEAMS.map((t) => `<option value="${t.name}" ${t.name === myTeam ? "selected" : ""}>${t.name}</option>`).join("");
}

function renderStatus() {
  const turn = currentTurnTeam();
  const statusEl = el("turnStatus");
  if (turn === null) {
    statusEl.innerHTML = `<span class="done">Draft complete 🎉</span>`;
  } else {
    const isMe = turn === myTeam;
    statusEl.innerHTML = `Pick <b>${picks.length + 1}</b> / ${DRAFT_ORDER.length} · Round <b>${currentRound()}</b> · On the clock: <span class="onclock ${isMe ? "me" : ""}">${turn}</span>${isMe ? " — that's you!" : ""}`;
  }
}

function renderBoard() {
  const costs = costsByTeam();
  const byTeam = picksByTeam();
  el("board").innerHTML = TEAMS.map((t) => {
    const spent = costs[t.name] || 0;
    const budget = TEAM_BUDGETS[t.name];
    const remaining = budget - spent;
    const teamPicks = byTeam[t.name] || [];
    const isTurn = currentTurnTeam() === t.name;
    const pct = Math.min(100, (spent / budget) * 100);
    return `
      <div class="team-col ${isTurn ? "on-turn" : ""}">
        <div class="team-col-head">
          <span class="team-name">${t.name}</span>
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
              ${finalized ? "" : `<button class="undo-btn" title="Undo this pick" data-key="${p.key}">✕</button>`}
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
  const taken = pickedNames();
  const turn = currentTurnTeam();
  const spentByMe = costsByTeam()[myTeam] || 0;
  const myBudget = TEAM_BUDGETS[myTeam] ?? 100;
  const myRemaining = myBudget - spentByMe;

  const filtered = POKEMON_LIST.filter((p) => {
    if (taken.has(p.name)) return false;
    if (searchTerm && !p.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  el("poolCount").textContent = `${filtered.length} available`;

  el("pool").innerHTML = filtered
    .map((p) => {
      const canAfford = p.cost <= myRemaining;
      const isMyTurn = turn === myTeam && myTeam;
      const disabled = !isMyTurn || !canAfford;
      return `
      <div class="pool-card ${disabled ? "disabled" : ""}" data-name="${p.name}">
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
  const draftDone = picks.length >= DRAFT_ORDER.length;

  if (finalized) {
    bar.innerHTML = `
      <div class="finalize-status locked">
        <span>🔒 Teams are finalized${finalizedBy ? ` (confirmed by ${finalizedBy})` : ""} — picks are locked in.</span>
        <button id="unlockBtn" class="link-btn">Not final? Unlock</button>
      </div>`;
    el("unlockBtn").onclick = () => {
      if (!confirm("Unlock the draft? This re-enables picks/undos and hides the projections until it's confirmed again.")) return;
      setFinalized(DRAFT_ROOM, false, null);
    };
  } else if (draftDone) {
    bar.innerHTML = `<button id="finalizeBtn" class="finalize-btn">✅ Confirm teams are final &amp; lock in projections</button>`;
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
// Team "strength" is the total point value they spent drafting — in an
// auction draft, cost is already a proxy for competitive power, so no
// extra data source is needed. Records are simulated across a
// round-robin schedule sized to NUM_ROUNDS "weeks".

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
// point-value gaps translate into win odds.
function winProbability(strengthA, strengthB, k = 20) {
  return 1 / (1 + Math.exp(-(strengthA - strengthB) / k));
}

function computePredictions() {
  const teamNames = TEAMS.map((t) => t.name);
  const strengthByTeam = costsByTeam(); // total pts spent = strength score
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
    const strength = strengthByTeam[name];
    const xWins = expectedWins[name];
    const wins = Math.round(xWins);
    return {
      name,
      strength,
      strengthPct: Math.round((strength / maxStrength) * 100),
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

  if (!finalized) {
    container.classList.remove("show");
    container.innerHTML = "";
    return;
  }

  const results = computePredictions();
  const champ = results[0];
  container.classList.add("show");
  container.innerHTML = `
    <div class="predictions-head">
      <div class="eyebrow">Season Projection</div>
      <h2>Projected Standings &amp; Champion</h2>
      <p>Simulated across a ${NUM_ROUNDS}-week season using each team's total drafted point value as its strength score. For fun — not an official schedule.</p>
    </div>
    <div class="champion-card">
      <span class="crown">👑</span>
      <div>
        <div class="champion-label">Projected Champion</div>
        <div class="champion-name">${champ.name}</div>
      </div>
    </div>
    <div class="predictions-table">
      ${results
        .map(
          (r) => `
        <div class="pred-row ${r.rank === 1 ? "champ" : ""}">
          <span class="pred-rank">#${r.rank}</span>
          <span class="pred-team">${r.name}</span>
          <div class="pred-bar"><div class="pred-bar-fill" style="width:${r.strengthPct}%"></div></div>
          <span class="pred-strength">${r.strength} pts</span>
          <span class="pred-record">${r.record}</span>
        </div>`
        )
        .join("")}
    </div>
    <div class="predictions-actions">
      <button id="exportCsvBtn" class="secondary-btn">⬇️ Export CSV</button>
      <button id="resetDraftBtn" class="danger-btn">♻️ Reset &amp; start a new draft</button>
    </div>`;

  el("exportCsvBtn").onclick = exportDraftCSV;
  el("resetDraftBtn").onclick = () => {
    if (!confirm("Reset the draft? Results are archived (so future pick suggestions still work), then the board clears for everyone so it can be drafted again.")) return;
    if (!confirm("Really reset now? This clears every device viewing this room and can't be undone.")) return;
    archiveAndClearDraft(DRAFT_ROOM);
  };
}

// ---------- CSV export ----------

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportDraftCSV() {
  const byTeam = picksByTeam();
  const predictions = computePredictions();
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
  rows.push(["Rank", "Team", "Strength (pts)", "Projected Record", "Projected Champion"]);
  predictions.forEach((r) => {
    rows.push([r.rank, r.name, r.strength, r.record, r.rank === 1 ? "Yes" : ""]);
  });

  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${DRAFT_ROOM}-results-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Pick suggestions ----------
// Looks at every past archived draft in this room for `team` and scores
// remaining, affordable Pokémon by how often that team has picked each
// of their types before. Purely a nudge — never blocks a pick.

function typeFrequencyForTeam(team) {
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

function computeSuggestions(team, limit = 4) {
  const freq = typeFrequencyForTeam(team);
  const hasHistory = Object.keys(freq).length > 0;
  if (!hasHistory) return { hasHistory: false, items: [], topTypes: [] };

  const taken = pickedNames();
  const spent = costsByTeam()[team] || 0;
  const remaining = (TEAM_BUDGETS[team] ?? 100) - spent;

  const scored = POKEMON_LIST.filter((p) => !taken.has(p.name) && p.cost <= remaining)
    .map((p) => ({ ...p, score: (freq[p.type1] || 0) + (freq[p.type2] || 0) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || b.cost - a.cost);

  const topTypes = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t]) => t);

  return { hasHistory: true, items: scored.slice(0, limit), topTypes };
}

function renderSuggestions() {
  const box = el("suggestions");
  if (!box) return;

  const turn = currentTurnTeam();
  const shouldShow = suggestionsEnabled && myTeam && turn === myTeam && !finalized;
  if (!shouldShow) {
    box.classList.remove("show");
    box.innerHTML = "";
    return;
  }

  const { hasHistory, items, topTypes } = computeSuggestions(myTeam);
  box.classList.add("show");

  if (!hasHistory) {
    box.innerHTML = `<div class="suggestions-empty">💡 No draft history yet for ${myTeam} — suggestions appear once you've completed at least one past draft in this room.</div>`;
    return;
  }
  if (items.length === 0) {
    box.innerHTML = `<div class="suggestions-empty">💡 Nothing left in the pool fits ${myTeam}'s usual picks (mostly ${topTypes.join(" & ")}-type) within your remaining budget.</div>`;
    return;
  }

  box.innerHTML = `
    <div class="suggestions-head">💡 Suggested for ${myTeam} — based on past picks (favors ${topTypes.join(" & ")}-type)</div>
    <div class="suggestions-list">
      ${items
        .map(
          (p) => `
        <button class="suggestion-chip" data-name="${p.name}">
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

function renderAll() {
  renderStatus();
  renderFinalizeControl();
  renderBoard();
  renderSuggestions();
  renderPool();
  renderPredictions();
  hydrateSprites(el("board"));
}

// ---------- Actions ----------

function draftPokemon(name) {
  if (finalized) return;
  const turn = currentTurnTeam();
  if (turn !== myTeam) {
    alert(`It's not your turn — ${turn} is on the clock.`);
    return;
  }
  const mon = POKEMON_LIST.find((p) => p.name === name);
  if (!mon) return;
  const spent = costsByTeam()[myTeam] || 0;
  const remaining = (TEAM_BUDGETS[myTeam] ?? 100) - spent;
  if (mon.cost > remaining) {
    alert(`${name} costs ${mon.cost} pts — you only have ${remaining} left.`);
    return;
  }
  if (!confirm(`Draft ${name} for ${mon.cost} pts?`)) return;
  addPick({ team: myTeam, pokemon: mon.name, cost: mon.cost });
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
}

init();
