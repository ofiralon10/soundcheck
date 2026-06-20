# Soundcheck — project guide for Claude Code

Soundcheck is a mobile-first web app a 5-piece band uses to prepare for concerts:
track per-instrument song readiness, plan rehearsals, and collaborate in real time.
The owner works almost entirely from a phone, which drives many UX and deploy choices.

## Architecture (read this first)

- **Single-file apps. No build step, no bundler.** The entire app is one HTML file
  containing a `<script type="text/babel">` block with React written in JSX, transpiled
  **in the browser** by Babel Standalone (loaded from a CDN). There is no `npm run build`.
- Two files in the repo root:
  - `staging.html` — the **development frontier**. All new work goes here first.
  - `index.html` — **production** (GitHub Pages serves it). Only port changes here after
    they've been tested on staging.
- **Backend: Firebase** (compat SDK via CDN script tags):
  - Auth: passwordless **email-link** sign-in.
  - Firestore: each band is ONE document at `boards/{bandId}` holding the whole app state.
  - Storage: cover art / band art / attachments, namespaced by board id.
- Deployed via **GitHub Pages**. Deploy = commit the updated file (the owner often does this
  by uploading the file through the GitHub web UI from a phone, or via `git push`).

## How to verify changes (there are no unit tests)

You cannot run Firebase locally. To check a change before handing it off:

1. **Syntax/JSX check** — extract the babel block and transpile it. This catches the
   vast majority of breakage:
   ```bash
   node -e "const b=require('@babel/core');const h=require('fs').readFileSync('staging.html','utf8');const s=h.match(/<script type=\"text\/babel\">([\s\S]*?)<\/script>/)[1];try{b.transformSync(s,{presets:['@babel/preset-react']});console.log('OK')}catch(e){console.log('ERR',e.message)}"
   ```
   (Install once: `npm i --no-save @babel/core @babel/preset-react`.)
2. **Logic check** — for pure functions (ordering, voting tallies, migrations), replicate
   them in a small `node -e` script and assert expected outputs.
3. **Real test** — only happens on the deployed **staging URL** in a browser, signed in.

## Conventions (always follow)

- **Versioning.** There's a `const VERSION='x.yyy'` near the top of the script, rendered next
  to the SOUNDCHECK wordmark. **Every change bumps the right-hand number by 1** (0.103 → 0.104).
  Never change the left-hand number unless explicitly told. The owner uses the on-screen version
  to confirm a deploy landed.
- **Edit staging.html first.** Don't touch `index.html` until the owner asks to port a tested change.
- **Single big file** (~1300+ lines). When editing, keep `str_replace` targets unique; re-read a
  region before editing it again.
- **State doc shape** (`boards/{bandId}`): `band`, `bandArt`, `concert`, `members` (per instrument:
  keys/drums/guitar/bass/vocals), `songs[]`, `rehearsals[]`, `activity[]`, `access`, `memberEmails`,
  `_rev`, `_updatedAt`. `defaultState()` creates it; `migrate()` defaults/normalizes on every load —
  **add new fields' defaults to `migrate()`** so old docs don't break.
- **Saves** overwrite the whole doc (`boardRef.set(...)`), last-write-wins, real-time synced.
- **Songs are per band, never shared between bands.**
- Mobile-first: forms scroll above the keyboard; touch-friendly controls (e.g. reorder uses
  up/down arrows, not drag).

## Key features already built (in staging.html, v0.103)

- Setlist: per-song readiness (Todo→Learning→Practicing→Ready) across 5 instruments, album art
  with crop, file attachments, guests. Reorder, playlist numbering, exclude/include (excluded songs
  drop to a section at the bottom), and encore marking. Order/exclude/encore live on the song objects.
- Stage: show-readiness dashboard + next rehearsal with its planned songs.
- Rehearsals: scheduling (incl. bulk repeats), focus songs split Practice/Learn.
- **Activity feed**: `logAct(state, text)` appends `{id,ts,who,text}` (capped 40) on adds/removes and
  rehearsal changes. Header bell shows a quiet dot when *others* changed something. Identity is the
  signed-in user's display name (`MY_NAME`, stored in `localStorage` key `sc_name`, set on sign-in).
- **Rehearsal time-change proposals**: `RehearsalProposal` lets anyone propose a new day/time without
  changing the official time; others 👍/👎; "Apply" commits it. Shows on Stage for the next rehearsal.

## In-progress / NOT yet deployed: multi-band + access control

This is the current focus and is the part to be most careful with.

- Each band = its own `boards/{bandId}` doc, fully independent. Users see a picker for 0/1/many bands;
  a "Switch" control in the header; owners manage members in Setup.
- Roles in `access` (email → role): **owner** (edit + manage members + delete), **editor** (edit content,
  not membership), **viewer** (read-only). `memberEmails` is the same emails as an array (for the
  `where('memberEmails','array-contains', email)` query — no manual index needed).
- **`ADMIN_EMAIL`** constant near the Firebase layer gates band *creation* to one account. It MUST match
  `adminEmail()` in `firestore.rules`.
- Security rules live in `firestore.rules` and `storage.rules` (repo root). **Firestore rules are
  project-wide** — they affect staging AND production at once. Storage rules are auth-only (can't read
  Firestore membership; documented limitation).

### Deploy order for the multi-band change (avoids locking bandmates out)
1. Set `ADMIN_EMAIL` (app) and `adminEmail()` (rules) to the same email.
2. Deploy the new app to staging, test (create a throwaway band, switch, add members).
3. Port the SAME version to `index.html` and deploy — both must run the new app before rules change,
   or an old app version will overwrite `boards/main` and strip `memberEmails`.
4. Initialize `boards/main` members: open with `?board=main`, Setup → Members, add owner + all current
   bandmates' emails, save.
5. Only then publish `firestore.rules` + `storage.rules`.

## Gotchas

- `?board=<id>` overrides band selection (used for testing and to reach `boards/main` before it has members).
  `?board=staging` is the isolated staging copy.
- Don't introduce `localStorage`/`sessionStorage` assumptions that break first-load; existing keys are
  `sc_name`, `sc_board`, `sc_seen_activity`.
- Adding a new persisted field: update `defaultState()` AND `migrate()`.
