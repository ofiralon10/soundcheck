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
  to confirm a deploy landed. Current version: **0.129**.
- **Edit staging.html first.** Don't touch `index.html` until the owner asks to port a tested change.
- **Porting to index.html:** `cp staging.html index.html`, then apply two fixes in index.html:
  1. Change `/staging/i.test(location.pathname)` → `/staging\.html/i.test(location.pathname)`
  2. Add `last!=='staging' &&` guard in the localStorage board restore line
  These prevent index.html from auto-selecting the staging board.
- **Single big file** (~2050+ lines). When editing, keep `str_replace` targets unique; re-read a
  region before editing it again.
- **State doc shape** (`boards/{bandId}`): `band`, `bandArt`, `concert`, `members` (per instrument:
  keys/drums/guitar/bass/vocals), `songs[]`, `rehearsals[]`, `activity[]`, `album[]`, `readinessHistory[]`,
  `access`, `memberEmails`, `_rev`, `_updatedAt`. `defaultState()` creates it; `migrate()` defaults/
  normalizes on every load — **add new fields' defaults to `migrate()`** so old docs don't break.
- **Saves** overwrite the whole doc (`boardRef.set(...)`), last-write-wins, real-time synced.
- **Songs are per band, never shared between bands.**
- Mobile-first: forms scroll above the keyboard; touch-friendly controls. Drag-and-drop for reorder
  on desktop, up/down arrows always available on mobile.
- **Hebrew/RTL text**: song titles, artist names, and reorder titles use `direction:ltr` CSS to force
  left-alignment. The Unicode bidi algorithm alone is not enough — `dir="auto"` still right-aligns
  Hebrew text in flex layouts. Use `direction:ltr` on the element's CSS class.

## Tabs & components (staging.html, v0.129)

### Stage tab
- Show-readiness dashboard: overall %, tick visualization, song count, ready count, set length.
- **Player readiness**: per-instrument progress bars. **Tapping an instrument row opens a bulk-update
  modal** listing all active songs with inline `StatusPills` for that instrument — allows mass status
  updates without opening songs individually. Layout: song name + artist on one line (LTR forced),
  pills below.
- **Next rehearsal** card with time range (e.g. "9:00 PM–11:00 PM"), live indicator, focus song tags.
  Tapping a focus tag navigates to that song in the Setlist tab.
- **Readiness graph**: SVG line chart of overall readiness over 52 weeks. Data stored in
  `readinessHistory[]` as `{d:'YYYY-MM-DD', v:0-100}`, one point per day, capped at 365.
  Seeded on first `migrate()` when history is empty and songs exist.
- `RehearsalProposal` for proposing time changes with thumbs up/down voting.

### Setlist tab
- Song list with cover art thumbnails, readiness progress bars, per-instrument status cells.
- **Responsive master-detail layout** on wide screens (≥900px via `useWide()` hook): left panel shows
  compact song rows, right panel shows the selected song's full detail.
- On mobile, only one song is open at a time; selecting a song closes others and scrolls it into view.
- **Scroll position**: uses `window.scrollTo()` with measured `.topbar` height to position songs just
  below the sticky header (not `scrollIntoView` which gets hidden behind it).
- **Drag-and-drop reorder** (HTML5 DnD API) plus up/down arrow buttons. Drag states: `.dragging`,
  `.drop-above`, `.drop-below`.
- **Setlist toolbar** wrapped in `.setlist-ctrl` bordered container with reorder toggle and instrument
  filter chips.
- Songs and toolbar have `2px solid rgba(255,255,255,.18)` borders for visual separation.
- Cover art: small thumbnail always visible; click it when song is open to toggle a larger edit view
  with replace/remove options.
- **Encore marking** with `★ Enc` pill.
- **File management**: "Access Files" button opens a bottom-sheet modal with files organized in 4
  categories: **Original**, **Slide**, **Music Sheets**, **Minus**. Each section shows N/A if empty.
  Files have a `cat` field (`'original'|'slide'|'sheets'|'minus'`). Category is chosen before uploading.
  Files can be played (audio player modal) or opened, and deleted with confirmation.
- **Audio player modal**: play/pause, seekable progress bar, volume slider. Uses `Audio` API with
  `timeupdate` polling.
- **Audio recording**: MediaRecorder API with music-optimized settings (no echo cancellation, no noise
  suppression, no auto gain, 48kHz sample rate, 256kbps). Full-screen red overlay during recording
  with pause/resume/stop. Save/discard confirmation dialog.
- **Camera capture**: `<input type="file" accept="image/*" capture="environment">`. After capture,
  a dialog asks: save to this song, save to band album, or discard.
- Action buttons order: Upload file, Camera, Add link, Record.
- **File upload buttons**: Upload file, 📷 Camera, Add link, ● Record (red).
- Guests: up to `MAX_GUESTS` per song with name and status.

### Rehearsals tab
- Upcoming/done split. Scheduling with date-time, duration, location, notes.
- **Bulk repeats**: weekly or biweekly, 2–12 sessions.
- **Duration**: stored as decimal hours (e.g. `'2'` = 2h). Rendered with `fmtDuration()`.
- **Time range display**: shows start–end (e.g. "9:00 PM–11:00 PM") via `fmtTimeRange(iso, dur)`.
- **Edit button**: on upcoming rehearsals, opens inline form to update date/time, duration, location.
- **Live indicator**: `isRehLive(r)` checks if current time is within the rehearsal window. Shows
  pulsing dot and "Rehearsal in progress" text. Card gets `.live` class.
- **Mark done flow**: opens modal listing all non-excluded songs as checkboxes to mark which were
  actually covered. Stores `coveredSongs[]` array on the rehearsal.
- **Song rehearsal count**: `songRehCount(songId, rehearsals)` counts how many done rehearsals covered
  that song. Shown as `N×` badge on song rows.
- Focus songs: Practice/Learn split with `FocusPicker` and `FocusTags`.
- Attendance tracking per instrument + guests.
- `RehearsalProposal` for time-change proposals with voting.

### Gallery tab (formerly "Album")
- Band photo gallery with thumbnail grid, sorted newest-first.
- Tap thumbnail → full-size view with date, author info, and delete option.
- Photos stored in Firebase Storage under `album/{boardId}/`.
- "Take photo" and "Upload from gallery" buttons.
- Album data stored in `state.album[]` as `{id, url, path, ts, name, by}`.

### Setup tab
- Account info, display name, sign out.
- Band name + band artwork.
- Concert details (name, date, venue).
- Lineup: per-instrument player names.
- Members & access: add/remove members by email with role (owner/editor/viewer).
- **Delete band**: owners can delete non-main bands with confirmation.
- Reset everything: clears all songs/rehearsals/concert data.
- Testing & staging: clone live board to staging.

## Activity feed / notifications

`logAct(state, text)` appends `{id, ts, who, text}` capped at 40 entries. Header bell shows a quiet
dot when *others* have changed something. Identity = `MY_NAME` from `localStorage` key `sc_name`.

Currently logged events:
- Song added / removed / excluded / included / encore toggled
- File uploaded / link added / recording saved / file removed (per song)
- Rehearsal scheduled / removed / marked done (with covered song count)
- Member added / removed / role changed
- Rehearsal proposal / time change applied
- Album photo added

**NOT logged** (intentionally removed as too noisy): per-instrument readiness status changes.

## Multi-band + access control

- Each band = its own `boards/{bandId}` doc, fully independent.
- Band picker shown when user has 0 or 2+ bands. Single-band users go straight in.
- `localStorage` key `sc_board` remembers last-used band.
- Roles in `access` (email → role): **owner** (edit + manage members + delete), **editor** (edit content,
  not membership), **viewer** (read-only). `memberEmails` is the same emails as an array (for the
  `where('memberEmails','array-contains', email)` query — no manual index needed).
- **`ADMIN_EMAIL`** constant near the Firebase layer gates band *creation* to one account. It MUST match
  `adminEmail()` in `firestore.rules`.
- Security rules live in `firestore.rules` and `storage.rules` (repo root). **Firestore rules are
  project-wide** — they affect staging AND production at once.
- **Band creation for Hebrew names**: `createBandDoc` generates doc ID from band name via
  `name.toLowerCase().replace(/[^a-z0-9]+/g,'-')`. Pure Hebrew names produce empty string → falls back
  to `uid()`. This means creating the same Hebrew band name twice generates two different random IDs
  (duplicate bands). User must delete duplicates via Setup → Delete band.

### Deploy order for the multi-band change (avoids locking bandmates out)
1. Set `ADMIN_EMAIL` (app) and `adminEmail()` (rules) to the same email.
2. Deploy the new app to staging, test (create a throwaway band, switch, add members).
3. Port the SAME version to `index.html` and deploy — both must run the new app before rules change,
   or an old app version will overwrite `boards/main` and strip `memberEmails`.
4. Initialize `boards/main` members: open with `?board=main`, Setup → Members, add owner + all current
   bandmates' emails, save.
5. Only then publish `firestore.rules` + `storage.rules`.

## Gotchas & lessons learned

- `?board=<id>` overrides band selection (used for testing and to reach `boards/main` before it has members).
  `?board=staging` is the isolated staging copy.
- **index.html staging detection**: when copying staging.html → index.html, the pathname regex
  `/staging/i.test(location.pathname)` matches the filename "staging.html" even though index.html
  is production. Must change to `/staging\.html/i` in index.html. Additionally, `localStorage`
  `sc_board` can be set to `"staging"` from a previous staging.html visit and persist into index.html.
  Add `last!=='staging'` guard in the localStorage restore.
- Don't introduce `localStorage`/`sessionStorage` assumptions that break first-load; existing keys are
  `sc_name`, `sc_board`, `sc_seen_activity`.
- Adding a new persisted field: update `defaultState()` AND `migrate()`.
- **scrollIntoView with sticky header**: `scrollIntoView({block:'start'})` positions the element at
  the very top of the viewport, hidden behind the sticky `.topbar`. Use manual `window.scrollTo()`
  measuring the actual topbar height: `const off = tb.getBoundingClientRect().height + 6`.
- **Hebrew text alignment**: `dir="auto"` is not enough to left-align Hebrew text. The Unicode bidi
  algorithm still detects RTL. Add `direction:ltr` CSS property to force LTR layout on containers
  (`.song-title`, `.song-meta`, `.ro-title`, `.ex-title`).
- **Readiness graph visibility**: needs ≥1 data points in `readinessHistory`. Seed initial data in
  `migrate()` when history is empty and songs exist, otherwise new installs never see the graph.
- **Rehearsal duration on old data**: rehearsals created before the duration feature (v0.118) have no
  `duration` field, so `fmtTimeRange` shows only the start time. Users must edit the rehearsal to add
  a duration for the range to display.
- **File categories on old data**: files created before v0.121 have no `cat` field. The modal defaults
  to showing them under "Original" via `(f.cat||'original')`.
- **CSS class `.song` has `scroll-margin-top:70px`** as a fallback for non-JS scroll scenarios.
  The actual scroll uses JS-measured offset.

## Key helper functions

- `songReadiness(s)` — 0–1 average of all 5 instrument scores for a song.
- `score(status)` — maps todo→0, learning→0.33, practicing→0.66, ready→1.
- `meterColor(pct)` — red/amber/green gradient based on 0–1 readiness.
- `fmtDate(iso)` — "Thu, Mar 25" style.
- `fmtTime(iso)` — locale time string, hour + minute.
- `fmtTimeRange(iso, dur)` — "9:00 PM–11:00 PM" using start time + duration in hours.
- `fmtDuration(d)` — "2h 30m" from decimal hours.
- `fmtSecs(s)` — "3:45" from seconds (for recording/playback timers).
- `isRehLive(r)` — checks if current time is within rehearsal window.
- `songRehCount(songId, rehearsals)` — count of done rehearsals that covered this song.
- `logAct(state, text)` — appends to activity feed, capped at 40.
- `useWide(bp)` — responsive hook using `matchMedia`, default breakpoint 900px.
- `uid()` — short random ID generator.

## CSS architecture

- CSS variables defined in `:root` — colors, fonts. Instrument colors: keys=#8B7CF6, drums=#F2545B,
  guitar=#F4A93C, bass=#2DD4BF, vocals=#EC6FA9.
- Font stack: Space Grotesk (display), Space Mono (mono), Inter (body), Heebo (Hebrew).
- Modals/overlays use fixed positioning with backdrop blur/dim. Bottom-sheet pattern:
  `border-radius:18px 18px 0 0`, `max-height:82vh`, safe-area padding.
- `.topbar` is `position:sticky;top:0;z-index:20` with gradient fade-out at bottom.
- `.tabbar` is `position:fixed;bottom:0` with backdrop blur.
- Tab icons use inline SVGs with `ICONS` path map.
