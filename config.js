// =====================================================================
// LEAGUE CONFIG — this is the only file most people need to edit.
// =====================================================================

// 1) YOUR TEAMS, IN BASE PICK ORDER (round 1 order — round order flips
//    automatically if ORDER_MODE is "snake").
//    Give a team a "budget" if they should NOT start at 100 pts.
//    Omit "budget" (or set it to 100) for everyone else.
const TEAMS = [
  { name: "Team Alpha",   budget: 100 },
  { name: "Team Bravo",   budget: 100 },
  { name: "Team Charlie", budget: 100 },
  { name: "Team Delta",   budget: 100 },
  { name: "Team Echo",    budget: 100 },
  { name: "Team Foxtrot", budget: 100 },
  { name: "Team Golf",    budget: 120 }, // example: this team starts with 120 pts
  { name: "Team Hotel",   budget: 100 },
];

// 2) HOW MANY ROUNDS = HOW MANY POKEMON PER TEAM
const NUM_ROUNDS = 10;

// 3) ORDER MODE:
//    "snake"  -> round 1 uses TEAMS order, round 2 reverses it, round 3
//                uses TEAMS order again, etc. (standard snake draft)
//    "fixed"  -> every round uses the exact same TEAMS order
//    "custom" -> you type out the ENTIRE pick order yourself in
//                CUSTOM_ORDER below (team name repeated once per pick).
//                Use this if your "pre-set order" isn't a simple snake.
const ORDER_MODE = "snake";

// Only used if ORDER_MODE === "custom". Must have TEAMS.length * NUM_ROUNDS
// entries, each one a team name from TEAMS above, in exact pick order.
const CUSTOM_ORDER = [
  // "Team Alpha", "Team Bravo", "Team Charlie", ...
];

// 4) FIREBASE — paste the config object from your Firebase project here.
//    Project Settings -> General -> Your apps -> SDK setup and config.
//    This is safe to make public; access is controlled by Database Rules
//    (see README.md), not by hiding this object.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDs8oKrobMzFpxn59u-9WCP-l4MQB6SERY",
  authDomain: "pokemon-draft-6a6c9.firebaseapp.com",
  databaseURL: "https://pokemon-draft-6a6c9-default-rtdb.firebaseio.com",
  projectId: "pokemon-draft-6a6c9",
  storageBucket: "pokemon-draft-6a6c9.firebasestorage.app",
  messagingSenderId: "988455752390",
  appId: "1:988455752390:web:81aa3e51f6f7cdfdbfbdc7"
};

// 5) A shared "room" key. Change this if you ever want to run a second,
//    completely separate draft in the same Firebase project.
const DRAFT_ROOM = "nsn-draft-2026";

// =====================================================================
// Nothing below this line needs to change.
// =====================================================================
function buildDraftOrder() {
  if (ORDER_MODE === "custom") {
    if (CUSTOM_ORDER.length !== TEAMS.length * NUM_ROUNDS) {
      console.error(
        `CUSTOM_ORDER has ${CUSTOM_ORDER.length} entries, expected ${TEAMS.length * NUM_ROUNDS}.`
      );
    }
    return CUSTOM_ORDER;
  }
  const order = [];
  const names = TEAMS.map((t) => t.name);
  for (let round = 0; round < NUM_ROUNDS; round++) {
    const roundNames =
      ORDER_MODE === "snake" && round % 2 === 1 ? [...names].reverse() : names;
    order.push(...roundNames);
  }
  return order;
}

const DRAFT_ORDER = buildDraftOrder();
const TEAM_BUDGETS = Object.fromEntries(
  TEAMS.map((t) => [t.name, t.budget ?? 100])
);
