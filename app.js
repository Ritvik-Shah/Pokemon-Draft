import { initFirebase, subscribeToPicks, addPick, removePickByKey } from "./firebase-sync.js";

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
              <button class="undo-btn" title="Undo this pick" data-key="${p.key}">✕</button>
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

function renderAll() {
  renderStatus();
  renderBoard();
  renderPool();
  hydrateSprites(el("board"));
}

// ---------- Actions ----------

function draftPokemon(name) {
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

  initFirebase(FIREBASE_CONFIG, DRAFT_ROOM);
  subscribeToPicks((newPicks) => {
    picks = newPicks;
    renderAll();
  });
}

init();
