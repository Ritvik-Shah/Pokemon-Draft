// Thin wrapper around Firebase Realtime Database so app.js doesn't need
// to know Firebase's API. Loaded as ES module via the CDN URLs below.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  get,
  onValue,
  remove,
  query,
  limitToLast,
  off,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

let db = null;
let picksRef = null;

export function initFirebase(firebaseConfig, roomKey) {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  picksRef = ref(db, `rooms/${roomKey}/picks`);
  return { db, picksRef };
}

// Subscribes to the picks list. Calls onChange(picksArray) every time it
// changes, where picksArray is ordered oldest -> newest.
export function subscribeToPicks(onChange) {
  onValue(picksRef, (snapshot) => {
    const val = snapshot.val() || {};
    const entries = Object.entries(val)
      .map(([key, pick]) => ({ key, ...pick }))
      .sort((a, b) => a.ts - b.ts);
    onChange(entries);
  });
}

export function addPick(pick) {
  return push(picksRef, { ...pick, ts: Date.now() });
}

// Removes a specific pick by its Firebase key (used for "undo").
export function removePickByKey(roomKey, key) {
  const target = ref(db, `rooms/${roomKey}/picks/${key}`);
  return remove(target);
}

// ---------- Finalize / lock-in ----------
// Everyone watches the same "finalized" flag so the "teams are official"
// state is shared, not just local to one browser.

// Calls onChange({ done: true, by, ts } | null) every time the finalized
// flag changes. null means the draft has not been (or is no longer) final.
export function subscribeToFinalized(roomKey, onChange) {
  const target = ref(db, `rooms/${roomKey}/finalized`);
  onValue(target, (snapshot) => onChange(snapshot.val() || null));
}

// Sets (value=true) or clears (value=false) the finalized flag.
export function setFinalized(roomKey, value, byTeam) {
  const target = ref(db, `rooms/${roomKey}/finalized`);
  return set(target, value ? { done: true, by: byTeam || null, ts: Date.now() } : null);
}

// ---------- Reset / history ----------
// "Reset" doesn't just delete the draft — it archives the current picks
// under rooms/{roomKey}/history/{draftId} first, so past drafts can still
// power the pick-suggestion feature, then clears picks + finalized so the
// room is a blank slate for a new draft.
export async function archiveAndClearDraft(roomKey) {
  const picksSnapshot = await get(ref(db, `rooms/${roomKey}/picks`));
  const picksVal = picksSnapshot.val() || {};

  if (Object.keys(picksVal).length > 0) {
    const draftId = String(Date.now());
    await set(ref(db, `rooms/${roomKey}/history/${draftId}`), {
      picks: picksVal,
      archivedAt: Date.now(),
    });
  }

  await set(ref(db, `rooms/${roomKey}/picks`), null);
  await set(ref(db, `rooms/${roomKey}/finalized`), null);
}

// Calls onChange(flatPicksArray) with every pick from every archived past
// draft in this room, each tagged with its draftId. Used to build
// "what has this team typically drafted" suggestions.
export function subscribeToHistory(roomKey, onChange) {
  const target = ref(db, `rooms/${roomKey}/history`);
  onValue(target, (snapshot) => {
    const val = snapshot.val() || {};
    const flat = [];
    for (const [draftId, draft] of Object.entries(val)) {
      const picksObj = draft.picks || {};
      for (const [key, pick] of Object.entries(picksObj)) {
        flat.push({ ...pick, key, draftId });
      }
    }
    onChange(flat);
  });
}

// ---------- Mock draft ----------
// Lives under rooms/{roomKey}/mockSessions/{clientId}/* — a private,
// per-browser practice space. Every visitor gets their own isolated mock
// draft keyed by their clientId, so anyone can run a practice draft
// against bots at the same time without seeing, or clobbering, anyone
// else's session. It's still in Firebase (not just localStorage) so a
// session survives reloads and follows the same client across tabs.
// submitMockPick stays transactional in case the same client has two
// tabs open racing to submit a bot's move.

function mockSessionPath(roomKey, clientId, leaf) {
  return `rooms/${roomKey}/mockSessions/${clientId}/${leaf}`;
}

export function subscribeToMockPicks(roomKey, clientId, onChange) {
  onValue(ref(db, mockSessionPath(roomKey, clientId, "picksList")), (snapshot) => onChange(snapshot.val() || []));
}

export function subscribeToMockStatus(roomKey, clientId, onChange) {
  onValue(ref(db, mockSessionPath(roomKey, clientId, "status")), (snapshot) => onChange(snapshot.val() || null));
}

// Starts (or resumes) this client's private mock session with `team` as
// the human-controlled side — every other team is bot-controlled.
export function startMockSession(roomKey, clientId, team) {
  return set(ref(db, mockSessionPath(roomKey, clientId, "status")), { active: true, team, startedAt: Date.now() });
}

// Atomically appends a pick only if it's genuinely still `team`'s turn and
// that Pokémon hasn't already been taken. Safe against duplicate bot
// writes: if two tabs of the same client race, Firebase retries the loser
// with fresh data and it aborts itself once the turn has moved on.
export async function submitMockPick(roomKey, clientId, draftOrder, team, pokemon, cost) {
  try {
    const target = ref(db, mockSessionPath(roomKey, clientId, "picksList"));
    const result = await runTransaction(target, (current) => {
      const list = current || [];
      const turnTeam = list.length < draftOrder.length ? draftOrder[list.length] : null;
      if (turnTeam !== team) return; // no longer this team's turn — abort
      if (list.some((p) => p.pokemon === pokemon)) return; // already taken — abort
      list.push({ team, pokemon, cost });
      return list;
    });
    return result.committed;
  } catch {
    return false;
  }
}

export function resetMockDraft(roomKey, clientId) {
  return set(ref(db, `rooms/${roomKey}/mockSessions/${clientId}`), null);
}
