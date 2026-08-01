# NSN Pokémon Draft — Live Draft Board

A live, multi-device draft board for your Pokémon Champions draft league.
Everyone opens the same link, picks their team name, and the board updates
in real time for everyone as picks happen — no app install needed.

It's a static site (works on GitHub Pages) that syncs through a free
Firebase Realtime Database.

---

## 1. Set up Firebase (~5 minutes, free)

1. Go to https://console.firebase.google.com and click **Add project**.
   Name it anything (e.g. `nsn-draft`). You can skip Google Analytics.
2. In the left sidebar, go to **Build → Realtime Database → Create Database**.
   - Pick any region.
   - Start in **test mode** (we'll lock it down in step 4).
3. In the left sidebar, go to **Project settings** (gear icon) → scroll to
   **Your apps** → click the **</>** (web) icon to register a new web app.
   Give it any nickname, no need to set up Hosting.
4. Firebase will show you a config object like this:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "nsn-draft.firebaseapp.com",
     databaseURL: "https://nsn-draft-default-rtdb.firebaseio.com",
     projectId: "nsn-draft",
     storageBucket: "nsn-draft.appspot.com",
     messagingSenderId: "...",
     appId: "...",
   };
   ```

   Copy these values into `FIREBASE_CONFIG` in **`config.js`** in this
   project. This is safe to publish publicly — it's not a secret key,
   access is controlled by Database Rules (next step).

5. Back in **Realtime Database → Rules**, replace the rules with this
   (open read/write, scoped so it can only be used for this draft — good
   enough for a private league draft night):

   ```json
   {
     "rules": {
       "rooms": {
         "nsn-draft-2026": {
           ".read": true,
           ".write": true
         }
       }
     }
   }
   ```

   If you changed `DRAFT_ROOM` in `config.js`, use that value instead of
   `"nsn-draft-2026"` above. Click **Publish**.

---

## 2. Set up your league in `config.js`

Open **`config.js`** and edit:

- `TEAMS` — your team names. Add `budget: 120` (or whatever) on any team
  that should start with more than 100 points; everyone else defaults to
  100.
- `NUM_ROUNDS` — how many Pokémon each team drafts (10 by default).
- `ORDER_MODE` —
  - `"snake"` — round 1 uses your `TEAMS` order, round 2 reverses it,
    round 3 uses it again, etc. (standard snake draft — recommended).
  - `"fixed"` — same order every round.
  - `"custom"` — you type out the *entire* pick sequence yourself in
    `CUSTOM_ORDER` if your league's order isn't a plain snake.

The Pokémon pool (name/type/cost) is already loaded in
**`pokemon-data.js`**, generated from your exported draft board CSV.
If your league's board changes, re-export the CSV and ask to regenerate
this file, or edit it directly — it's a plain JS array.

---

## 3. Test it locally (optional but recommended)

You can't just double-click `index.html` because it uses ES modules,
which browsers block on `file://` URLs. Run a tiny local server instead:

```bash
cd draft-site
python3 -m http.server 8000
```

Then open http://localhost:8000 in a couple of browser tabs/devices on
the same network and confirm picks sync between them.

---

## 4. Deploy to GitHub Pages (free hosting)

1. Create a new GitHub repo and push this folder's contents to it
   (must be at the repo root, or in `/docs` — see step 3).
2. In the repo, go to **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**, pick `main` and
   `/ (root)`, then **Save**.
4. GitHub gives you a URL like `https://yourname.github.io/repo-name/`.
   That's your live draft link — share it with the league.

Changes you push to the repo go live in a minute or two.

---

## How it works on draft day

- Everyone opens the site link and picks their team name from the
  dropdown at the top right (it's remembered on that device).
- The status bar shows whose turn it is, live, for everyone.
- The pool panel on the right only lets the on-the-clock team click a
  Pokémon (greyed out otherwise, or if they can't afford it).
- Clicking a Pokémon asks for a confirm, then instantly appears in that
  team's column on the board for everyone.
- Made a mistake? Click the ✕ next to any pick to undo it (asks to
  confirm first) — this is intentionally unrestricted so any team can
  fix a misclick without waiting on a commissioner.

## Pokémon artwork

Every card and pick row shows official artwork, fetched live from the free
[PokeAPI](https://pokeapi.co) in each visitor's browser (no setup needed —
it just works once the site is live). Results are cached in that browser's
`localStorage` so it only fetches each Pokémon once.

A few Champions-exclusive Megas and new forms (things like `Mega Floette`
or `Mega Sinistcha`-style additions that don't exist in the mainline games
yet) aren't in PokeAPI's database. Those fall back to a colored badge with
the Pokémon's first letter, tinted to its primary type, instead of a broken
image — nothing looks broken, it just won't have art until PokeAPI adds it.

## Notes / things to know

- There's no login system — team identity is just a dropdown choice, on
  the honor system. That's normally fine for a friendly league; if you
  want to lock it down harder later, Firebase Auth can be added.
- The free Firebase Realtime Database tier easily handles a draft night
  of this size (well under the 1GB storage / 10GB-per-month transfer
  limits).
- Want to reset for a mock draft before the real thing? Just delete
  everything under `rooms/<your room key>/picks` in the Firebase console
  (Realtime Database → Data tab), or change `DRAFT_ROOM` in `config.js`
  to a fresh value for a clean slate.
