// Thin wrapper around Firebase Realtime Database so app.js doesn't need
// to know Firebase's API. Loaded as ES module via the CDN URLs below.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onValue,
  remove,
  query,
  limitToLast,
  off,
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
