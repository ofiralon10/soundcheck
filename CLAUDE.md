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
  to confirm a deploy landed. Current version: **0.260**.
  **This session ports to BOTH staging.html and index.html by default** (owner's standing
  request); still apply the two index.html fixes below on every port.
- **Edit staging.html first.** Don't touch `index.html` until the owner asks to port a tested change.
- **Porting to index.html:** `cp staging.html index.html`, then apply two fixes in index.html:
  1. Change `/staging/i.test(location.pathname)` → `/staging\.html/i.test(location.pathname)`
  2. Add `last!=='staging' &&` guard in the localStorage board restore line
  These prevent index.html from auto-selecting the staging board.
- **Single big file** (~2300+ lines). When editing, keep `str_replace` targets unique; re-read a
  region before editing it again.
- **State doc shape** (`boards/{bandId}`): `band`, `bandArt`, `shows[]` (replaces old `concert`),
  `members` (per instrument: keys/drums/guitar/bass/vocals), `songs[]`, `rehearsals[]`,
  `activity[]`, `album[]`, `access`, `memberEmails`, `_rev`, `_updatedAt`.
  Each show: `{id, name, date, venue, setlist[], readinessHistory[]}`.
  Each setlist entry: `{songId, parts:{}, guests:[], encore, excluded}`.
  Each song: `{id, title, artist, cover, files[], notes, duration, songKey, tempo, zoomPlans}`.
  Each file: `{id, name, kind:'upload'|'link', url, path, size, type, cat, stem?, by?, ver?,
  srcName?, sync?}`. `stem:true` marks true stem files (from Get Stems); `ver`/`srcName` track
  file versions from Setlist Files Update; `sync` (seconds) is the trim/offset on stem-rec files.
  `song.zoomPlans` = per-section, per-device zoom keyframes (see Practice slide section).
  `defaultState()` creates it; `migrate()` defaults/normalizes on every load —
  **add new fields' defaults to `migrate()`** so old docs don't break.
- **Saves** overwrite the whole doc (`boardRef.set(...)`), last-write-wins, real-time synced.
- **Songs are per band, never shared between bands.**
- Mobile-first: forms scroll above the keyboard; touch-friendly controls. Drag-and-drop for reorder
  on desktop, up/down arrows always available on mobile.
- **Hebrew/RTL text**: song titles, artist names, and reorder titles use `direction:ltr` CSS to force
  left-alignment. The Unicode bidi algorithm alone is not enough — `dir="auto"` still right-aligns
  Hebrew text in flex layouts. Use `direction:ltr` on the element's CSS class.
- **Changelog**: update the `CHANGELOG` object with entries for each version that ships to production.
  The "What's New" modal shows on first load when version changes.

## Tabs & components (staging.html, v0.260)

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
- **Band selection → Stage tab**: choosing a band navigates to the Stage tab automatically.

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
- **Song row badges**: file count centered on file icon, song order index in rounded square,
  rehearsal count badge on cover art corner.
- **Encore marking** with `★ Enc` pill.
- **Practice button**: per-song play icon colored by stem availability (red=none, yellow=partial,
  green=all 6 core stems). Opens the stem player.
- **Record button**: mic icon on song row, shows confirm/cancel dialog before starting recording.
- Guests: up to `MAX_GUESTS` per song with name and status.

### File management (Files modal)
- Opened via "Access Files" button on each song.
- **Filtered view**: shows only sections relevant to the user — **Slide**, **Recordings**,
  **My Stem Recordings**, and sections matching the user's chosen instruments (`MY_INSTRS`).
  "Other" section only appears if the user has "other" selected (or no instrument is set).
- **File categories** (`FILE_CATS`): Slide, Vocals, Drums, Bass, Guitar, Keys, Other.
  Files have `cat` field. Old files with `cat:'original'` map to `'other'`.
- **Per-section Add button** for uploading files to a specific category.
- **Recordings section**: appears right after Slide, shows files matching `/recording/i` in name.
  Has inline Record button.
- **Get Stems button**: accepts multiple audio files or a zip. Auto-categorizes by filename
  using `stemCatFromName()` (detects vocals/drums/bass/guitar/keys/metronome/click/tick).
  Files renamed to `[song title] [Instrument] stem.[ext]`.
  - Re-uploading stems **replaces** existing files for the same category (old storage deleted).
  - Progress bar shown during upload with count (e.g. "3 / 6 stems").
  - Success/failure message on completion.
  - Progress bar also visible on the song row when Files modal is closed (background upload).
  - Button color: green (all 6 core stems), yellow (partial), red (none).
- **Practice button** in Files modal header — jumps to stem player. Colored same as stem availability.
- **My Stem Recordings section**: shows files with `cat:'stem-rec'` and `by:MY_NAME`. Only
  visible to the recording author. Play button opens stem-rec playback mode. Appears above
  the Get Stems button.
- **File rows (v0.254)**: extracted into one `fileRow(f, onOpen)` helper used by all sections.
  Tapping the badges + name **opens/plays** the file; a single **⋯** button reveals a menu with
  **Rename / Download / Share / Delete** (inline delete confirm). `shareFile(f)` = native file
  share (fetch blob → `navigator.share({files})`) → URL share → clipboard.
- **Version badge (v0.241)**: each file shows `vNN` left of its type badge (`f.ver||0`, 2-digit).
  Setlist Files Update bumps `ver` when the same source filename replaces a category's file, and
  resets to 0 for a different source file.
- **Known bug fixed (v0.159)**: `e.target.files` is a FileList reference — must copy to array
  via `Array.from()` before clearing input with `e.target.value=''`, or the FileList empties.

### Setlist Files Update (v0.234+, removable feature)
- **"Setlist Files" button** on the setlist toolbar (right side). Prompts for a **folder**
  (`webkitdirectory`) with **one subfolder per song**, and bulk-updates each song's files.
- Self-contained + easy to remove: `SFU_*` helpers block near `loadScript`, plus the button /
  hidden input / `runSetlistFilesUpdate` / `sfuModal` in `Setlist()`. Toggle `SFU_ENABLED`.
- **Fuzzy folder→song matching** (`sfuScore`): the folder's tokens must contain the song's title
  tokens (extra words like the artist are ignored), tolerant of punctuation/spacing/small typos
  (`sfuLev`) and run-together titles. Greedy best-score assignment; each folder/song used once.
  A subfolder literally named "Ignore" is skipped.
- **Category by leading `[Tag]` prefix** (`sfuCatFromName`): `[Slide] [Bass] [Vocals] [Guitar]
  [Keys] [Drums]` (also `[Other]`). `[Ignore]` skips the file; no/unknown tag skips it.
- **Conversion** (`sfuFileToBlob`): JPEG as-is; PNG/WebP/GIF/BMP → JPEG; **PDF → one tall JPEG**
  (pages concatenated) via PDF.js loaded lazily from CDN; audio uploaded as-is. **PPT/PPTX are
  NOT converted in-browser** (rendering was poor — dropped v0.240); they're skipped with a message
  to convert to PDF first (see `tools/pptx2pdf.py`).
- **Dedup by size**: if an existing file in the same category has identical byte size, it's kept.
  Otherwise the category's file is replaced (old storage deleted). Per-file feedback modal.

### Stem player (Practice mode)
- **Multi-stem audio player** with 7 channels: Vocals, Drums, Bass, Keys, Guitar, Other, Metronome.
- Plays with plain `Audio` elements + `.volume` for mixing. **Only loads real stem files**
  (`f.stem===true`, from Get Stems) — NOT band/other recordings (v0.249 fix; a recording saved to
  `cat:'other'` used to leak into the Other channel). CORS is configured on the bucket
  (`gsutil cors set cors.json gs://soundcheck-1f16b.firebasestorage.app`) so `fetch()` works for
  the Share/mix feature and for the recording player's Web Audio decode.
- **Channel modes (v0.208)**: each channel box has three mutually-exclusive buttons — **Mute**,
  **Solo**, **Custom**. The volume slider only appears in Custom mode; otherwise the channel plays
  at its default level (80% practice; 100%/70% for My Stem/Backing). Boxes are a compact grid
  (icon + Mute/Solo/Custom on one row).
- **Metronome**: detected from filename (metronome/click/tick), muted by default, not counted toward
  stem availability. Greyed out when no file loaded.
- **Transport bar** (`.stem-btns`, all buttons same size; SVG/icon-based, v0.253/0.260):
  ▶/⏸ play-pause toggle (white SVG), ■ **Stop** (red, resets to 0), **Files** toggle (cyan, file
  icon — see below), **⛶ positions** (purple, shows `N/M`), **⚙ CONFIG** (yellow; opens the opaque
  channel panel with a Reset-channels button), **🎙 Rec** (shows white dot + your instrument icons).
  On phones (`@media max-width:640px`) buttons are content-sized and centered.
- **Config persistence**: saved per song in `localStorage` `sc_stem_[songId]` (practice) and
  `sc_stemrec_[songId]` (StemRec Player), including the `custom` flag.
- **Stale closure fix (v0.200)**: `stemApplyMix` reads `stemChansRef` (always-current ref) not the
  `stemChans` closure. The `useEffect` on `stemChans` updates the ref, reapplies the mix, and
  persists to the right localStorage key (skipped while recording / restoring).

### Practice slide + file toggle + zoom plans
- **Files toggle** (v0.245): cycles which file is shown above the bar — the **Slide** first, then
  any viewable (image/PDF) files in the user's own instrument sections (`viewFiles`). Button shows
  the current section + `N/M`. `curView` drives the practice-full content.
- **Slide area** (`.practice-full`, z-59; player bar z-60): bounded to exactly the area above the
  bar — the bar height is measured (`stemBarH` via ResizeObserver) and the slide fills the rest.
  Images preferred over PDF; PDF on mobile uses Google Docs Viewer (mobile can't inline PDFs).
- **`SlideViewer`** — pinch/drag + Ctrl-scroll zoom/pan. Also drives the zoom-position plan:
  - `applyRef` imperatively applies a stored view (normalized to container so it survives
    resize/file replacement); `captureRef` returns the current view; `onTap(dir)` fires on **click**
    (v0.260 — the canonical tap for mouse+touch; the old touchend handler was unreliable on mobile).
  - **Tap right half of the slide → next position, left half → previous** (cyclic).
- **Zoom/pan plan (positions)**: per shown FILE, keyed by **section** then **device**:
  `song.zoomPlans = { [section]: { wide:[{t,scale,nx,ny}], narrow:[...] } }` (v0.247/0.229).
  Sections: slide/vocals/keys/etc; device = `useWide()` wide/narrow. The ⛶ button opens a
  **Set / Clear / Cancel** popover: **Set** captures the current view at the playhead time; during
  playback the view snaps to the latest keyframe whose time has passed (only on an actual crossing,
  so manual taps persist). Opening a file that has positions starts on its **first** position
  (v0.250). Plans survive file replacement (keyed by section) and are separate per phone/tablet.

### Stem recording (v0.187+, heavily reworked through v0.260)
- **Record your part over backing stems.** Flow: `startStemRec` (prepare) → dialog → GO
  (`beginStemRec`, a direct gesture) → REC → save/discard. States: `preparing`/`ready`/`recording`.
- **Backing = one pre-rendered mix.** The backing stems are fetched (cached per song,
  `stemRecBufCacheRef`, prefetched when the dialog opens), the count-in beeps + stems are
  **offline-rendered** into a single WAV, and played via a blob-src `<audio>` element (`out`).
  The user's own instruments are simply **never scheduled**, so they can't be heard (v0.216).
- **Mic chain** (Web Audio): `getUserMedia` (EC per headphone toggle, NS off, AGC off) → highpass
  90 Hz → gain 2.5× → compressor (−24 dB, 4:1) → limiter (−2 dB, 20:1) → `MediaStreamDestination` →
  MediaRecorder (256 kbps). An AnalyserNode taps the chain for the **MIC level meter** shown in the
  REC bar (green/amber/red).
- **Headphones toggle** (`sc_rec_hp`): with headphones, echo-cancellation is OFF and the count-in
  beeps continue through the Ta beats (help keep the pulse; they play in the ears, not the mic).
  Without headphones, EC is ON (removes speaker bleed) and the Ta beats are silent.
- **Volume during recording (v0.260)**: while the mic is open the OS is in *communication* audio
  mode and the volume keys control that stream — a standalone media element ignores them. So `out`
  is routed **through the recording AudioContext** (`createMediaElementSource → gain →
  actx.destination`), which rides the same stream, restoring phone-button volume control.
- **Sync via "Ta" calibration** — THE key mechanism, since output latency (esp. Bluetooth,
  ~300–450 ms) cannot be measured from clocks:
  - Count-in: **4 beeps** (beats 1–4, `BEAT=0.75s`), the user answers **"Ta" on beats 5–8**, stems
    enter on beat 9 (`R_LEAD=B0+8*BEAT`). The voice reaches the mic directly regardless of output
    path, so the Ta lateness *is* the output delay the user hears.
  - Detection collects **all** voice onsets in the Ta region (live via a ScriptProcessor on the mic
    graph; offline from the decoded take as fallback) and finds the single **global time-shift**
    (`matchTaShift`, searched over `[-0.10,+0.65]s`) that best aligns them to the expected grid.
    **DO NOT go back to per-beat windows** — with a 0.5 s grid a ~one-beat delay aliased into the
    next beat and read as ~0 ms (the long-standing "add 300–400 ms manually" bug, fixed v0.257).
  - Priority: live Ta → offline Ta → remembered calibration (`sc_sync_out`) → clock estimate.
- **Save trims + re-encodes to MP3** (`uploadStemRec`): the measured `sync` count-in lead is trimmed
  off the take and it's re-encoded to 128 kbps MP3 via lamejs, so the saved stem **starts at song
  time 0** (`sync:0`) and is properly seekable. Falls back to the raw blob + a stored `sync` offset.
- **Mix state preservation** (`stemRecPreMixRef` + `stemRecRestoreMix`): the pre-recording mix is
  restored on every exit path (save/discard/blocked/error) — otherwise the force-mute persisted.
- **File storage**: `cat:'stem-rec'`, `by:MY_NAME`, `sync`. Path `files/{BOARD}/{fid}-stemrec.{ext}`.

### StemRec Player (`stemRecPlayback` state)
- Opened from "My Stem Recordings" Play. Separate config/persistence from the practice Stem Player.
- **Two channels only** (v0.206): **My Stem** (the recording, 100%) + **Backing** (all other stems
  grouped under one volume/mute/solo control, 70%). `stemChanAudioKeys` maps the Backing channel to
  every non-user audio element.
- Transport: play/pause, stop, CONFIG, **Share** (no Rec/Files/Zoom). A **SYNC ±50ms nudge** row
  (when CONFIG open) lets the user fine-tune alignment; the nudge is saved back onto the file's
  `sync` (debounced) so it sticks. Recorded stem is offset by `sync` so it aligns with the backing.
- **Share/mix**: two-phase — "Share" offline-mixes active channels to MP3 (128 kbps via lamejs; WAV
  fallback), then "Send" triggers the native share sheet / download. Two phases because
  `navigator.share()` needs a direct gesture, lost after async mixing.

### Recording audio player (Web Audio for webm)
- Band/stem recordings are **cue-less MediaRecorder webm** blobs: an `<audio>` element can't seek
  them (silence after a jump) and reports `duration=Infinity`. So `openPlayer` **decodes webm/ogg
  recordings into an AudioBuffer and plays via Web Audio** (BufferSource + gain) for accurate
  duration and reliable seeking (`waRef`). Other formats keep the `<audio>` element path (with a
  force-duration seek-to-end trick for any Infinity-duration file).

### Shows tab (v0.177+)
- **Multi-show support**: each band can have multiple shows (concerts). Shows replace the old
  single `state.concert` object.
- Show cards display: name, date, venue, song count, overall readiness %, cover art grid of
  song covers (non-excluded).
- **Tap-to-reveal art buttons**: Change Art / Remove Art only shown when art area is tapped.
- **Clone show** (v0.184): clone from an existing show with updated date/venue. Copies setlist
  with fresh `parts` (all `todo`), carries over art URL.
- **Delete show**: requires confirmation dialog.
- **Show selector**: compact dropdown in Stage and Setlist tabs for switching active show.
- Each show has its own setlist with per-song `parts`, `guests`, `encore`, `excluded`.
- `state.shows[]` array, each with `{id, name, date, venue, setlist[], readinessHistory[]}`.

### Back button handling (v0.186+)
- **Global `backHandlers` registry**: modals/overlays register close functions via
  `useBackHandler(active, closeFn)` hook.
- Phone back button closes the topmost modal instead of exiting the app.
- If no modal is open, single back does nothing; double-tap fast exits the app.
- `window.addEventListener('popstate', ...)` manages the handler stack and `history.pushState`.

### Instrument system
- 5 core instruments: keys (#8B7CF6), drums (#F2545B), guitar (#F4A93C), bass (#2DD4BF),
  vocals (#EC6FA9).
- **"Other" instrument**: treble clef icon, light blue (#5BC0EB). Available in instrument picker
  and prompt. When selected, Files modal shows the Other file section.
- **Metronome**: metronome icon (triangular body with pendulum), grey (#948FA6).
- **Multi-instrument selection** (v0.179+): users can pick multiple instruments (e.g. Vocals + Keys).
  `MY_INSTRS` is an array stored comma-separated in `localStorage` key `sc_instr`. Single values
  from old versions still work. `isMyInstr(id)` returns true if no instruments set OR if id is in
  the array. Files modal shows sections for all selected instruments.
- `ICON` object holds SVG paths for each instrument (including `other` and `metronome`).
- `InstrIcon({id, size})` — renders plain SVG icon.
- `InstrBadge({id, size})` — renders icon in colored circle with inner ring.
- `InstrPicker` — header dropdown that toggles instruments on/off (selected = transparent-white
  highlight). Header button grows to fit icons; on mobile with >2 selected it shows a layers icon +
  count. Has a × close button.
- Instrument prompt appears on first use (after changelog dismiss) if no instrument set.

### Tablet frame simulation (v0.224)
- On a **desktop** (fine pointer + screen ≥1024px) the whole app auto-renders inside a **4:3
  landscape tablet frame (1440×1080)**, scaled to fit, so PC testing matches the tablet. Real
  phones/tablets render natively. The scaling `transform` is on an **outer `.simframe` wrapper**,
  with `#root` a plain scroll container inside — putting the transform on `#root` itself made its
  `position:fixed` bars scroll with content. Override via URL: `?tablet=land|port|off`.

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
- Focus songs: Practice/Learn split with `FocusPicker` and `FocusTags`. The **Practice/Learn labels
  are filled** with their color (amber/blue) + dark text (v0.255).
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
  `sc_name`, `sc_board`, `sc_seen_activity`, `sc_instr` (comma-separated multi-instrument),
  `sc_seen_ver`, `sc_stem_[songId]`, `sc_stemrec_[songId]`, `sc_show`, `sc_rec_hp` (headphones
  toggle), `sc_sync_out` (remembered Ta output-delay calibration, ms).
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
- **File categories on old data**: files created before v0.121 have no `cat` field. Mapped via
  `(f.cat==='original'?'other':f.cat||'other')`.
- **CSS class `.song` has `scroll-margin-top:70px`** as a fallback for non-JS scroll scenarios.
  The actual scroll uses JS-measured offset.
- **Stem mixing uses plain `Audio` + `.volume`** (not Web Audio) — simplest and avoids the historic
  storage CORS pain. Web Audio IS used elsewhere now that the bucket has CORS: recording playback
  (`decodeAudioData` for seekable webm), the recording backing/graph, and offline mixing for Share.
- **FileList is a live reference**: setting `input.value=''` empties the FileList. Always copy to
  array with `Array.from(e.target.files)` before clearing the input.
- **Block-scoped `const` in migrate()**: Babel Standalone may handle block-scoped variables in
  `migrate()` differently at runtime. Use IIFE pattern instead of bare `{ const x = ... }` blocks.
- **Stem deduplication**: `migrate()` deduplicates stem files per category (keeps first, removes
  extras). `uploadStemFile` replaces existing stem for same category on re-upload.
- **Metronome migration**: `migrate()` moves files with metronome/click/tick in name from
  `cat:'other'` to `cat:'metronome'`.
- **Mobile autoplay policy**: `Audio.play()` is blocked after async operations (like
  `getUserMedia`) because the user gesture context is lost. Must "unlock" Audio elements by
  calling `play()+pause()` synchronously during the button tap, before any async work.
- **`navigator.share()` user gesture**: also requires a direct user gesture. Cannot call it
  after an async mixing operation. Use a two-phase flow: async work first, then show a button
  whose tap triggers the share.
- **`stemApplyMix` stale closure**: never call `stemApplyMix()` without args from inside
  callbacks or effects — it used to read stale `stemChans` closure. Fixed by using
  `stemChansRef` (a ref always holding current state). Always pass explicit `chans` arg or
  rely on the ref.
- **TIF/TIFF images**: browsers cannot display `.tif` files. Slide files must be in
  jpg/png/webp/gif (images) or pdf format.
- **PDF in mobile iframe**: mobile browsers download PDFs instead of rendering them inline.
  Use Google Docs Viewer (`docs.google.com/gview?embedded=true&url=...`) for mobile.
- **Firebase Storage CORS config**: bucket `soundcheck-1f16b.firebasestorage.app` has CORS
  configured (`cors.json` in repo root) to allow `GET` from any origin. This enables `fetch()`
  for the stem mix/share feature and the recording player's `decodeAudioData`.
  Set via `gsutil cors set cors.json gs://BUCKET`.
- **Ta calibration beat-aliasing (v0.257)**: a fixed beat grid can't distinguish a delay `d` from
  `d − beat`. Bluetooth output delay (~300–450 ms) ≈ one 0.5 s beat, so per-beat detection windows
  aliased and reported ~0 ms — the app under-corrected by ~one beat. Fix: slower 0.75 s grid + a
  **global shift search** aligning ALL collected onsets to the grid. Never revert to per-beat
  windows or a 0.5 s grid.
- **Volume keys during mic capture**: with `getUserMedia` active the OS is in *communication* audio
  mode; the volume keys control that stream, and a standalone `<audio>` element (media stream) is
  unaffected. Route playback **through the AudioContext** (`createMediaElementSource → destination`)
  so it rides the communication stream and the volume keys work.
- **Cue-less MediaRecorder webm**: no seek index → `<audio>` can't seek (silence after a jump) and
  `duration` is `Infinity` until seeked to the end. For recordings, decode to an AudioBuffer and
  play via Web Audio (seekable, accurate duration). For other Infinity-duration files, force
  duration by seeking to a huge time then back to 0.
- **Control glyphs render as emoji**: `▶`/`⏸`/`⏹`/`⚙` unicode glyphs render as colored emoji on
  mobile (e.g. a yellow box around play/pause). Use inline **SVG** icons (`fill="currentColor"`)
  for crisp, theme-colored controls.
- **Tap detection on mobile**: prefer the `click` event (canonical tap for mouse+touch, suppressed
  after a real drag) over a hand-rolled `touchend` handler, which was unreliable on phones.
- **`sc_stem` vs `sc_stemrec`**: the practice Stem Player and the StemRec Player persist to separate
  keys; don't let recording/stem-rec state contaminate the practice mix (guard the persist effect).
- **PPTX cannot be rendered client-side well**: dropped in-browser PPTXjs (poor quality). Convert to
  PDF first with `tools/pptx2pdf.py` (LibreOffice headless, or PowerPoint COM on Windows), then let
  the app turn the PDF into tall slide JPEGs.

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
- `stemCatFromName(name)` — detects instrument from filename (vocals/drums/bass/guitar/keys/metronome/other).
- `stemRename(origName, cat)` — renames stem file to `[song title] [Instrument] stem.[ext]`.
- `isMyInstr(id)` — true if no instruments set OR if id is in `MY_INSTRS`.
- `setMyInstrs(ids)` — sets `MY_INSTRS` array, persists comma-separated to localStorage.
- `useBackHandler(active, closeFn)` — registers a modal close function for the phone back button.
- `encodeWav(audioBuffer)` / `encodeMp3(buf, kbps)` — WAV / MP3 (lamejs, lazy CDN) encoders.
- `SlideViewer({children, autoOn, navMode, applyRef, captureRef, onTap})` — zoom/pan viewer for the
  practice slide; drives the zoom-position plan and tap-to-switch.
- `fileRow(f, onOpen)` — one Files-modal row (tap-to-open + ⋯ Rename/Download/Share/Delete menu).
- SFU helpers: `sfuScore`/`sfuLev`/`sfuCatFromName`/`sfuFileToBlob`/`sfuPdfToTallJpeg` (Setlist
  Files Update). `matchTaShift`/`detectTaOnsets` (recording sync). `loadScript` (lazy CDN loader).

## Cloud Functions deploy gotchas

- **Runtime lives in TWO places**: `firebase.json` → `functions.runtime` AND `functions/package.json`
  → `engines.node`. **`firebase.json` wins.** Changing only `engines` does nothing.
- **`firebase deploy` skips functions whose SOURCE hash is unchanged** ("Skipped (No changes
  detected)") — a runtime-only change in `firebase.json` is silently skipped and the OLD runtime
  stays live, while the CLI still prints a green "Deploy complete!". Touch `functions/index.js` to
  change the hash, and **always verify with `firebase functions:list`** (it prints the real runtime)
  rather than trusting the deploy output.
- Current: **Node 24** (GA; deprecation 2028-04-30, decommission 2028-10-31), `firebase-functions@7`,
  `firebase-admin@13`.
- **`firebase-admin` is pinned to 13.x on purpose**: `firebase-functions@7` peer-requires
  `^11 || ^12 || ^13`, so v14 fails `npm install` with ERESOLVE. Don't `--force` it. Admin is already
  imported via the **modular** entry points (`firebase-admin/app|firestore|messaging`) because v14
  removes the legacy `admin.*` namespace — so the v14 bump is a version change once functions@8
  allows it.
- Deploying needs the `ANTHROPIC_KEY` + `TELEGRAM_BOT_TOKEN` secrets to already exist
  (`firebase functions:secrets:set NAME` — the name is the arg, the value is typed at the prompt).

## tools/
- `tools/pptx2pdf.py` (+ `.bat`, `README.md`) — batch-converts every `.pptx`/`.ppt` under a folder
  to PDF (LibreOffice headless, else PowerPoint COM on Windows). Double-click runs it in its own
  folder. Not part of the web app; used before the Setlist Files Update.

## CSS architecture

- CSS variables defined in `:root` — colors, fonts. Instrument colors: keys=#8B7CF6, drums=#F2545B,
  guitar=#F4A93C, bass=#2DD4BF, vocals=#EC6FA9. Other=#5BC0EB. Metronome=#948FA6.
- Font stack: Space Grotesk (display), Space Mono (mono), Inter (body), Heebo (Hebrew).
- Modals/overlays use fixed positioning with backdrop blur/dim. Bottom-sheet pattern:
  `border-radius:18px 18px 0 0`, `max-height:82vh`, safe-area padding.
- `.topbar` is `position:sticky;top:0;z-index:20` with gradient fade-out at bottom.
- `.tabbar` is `position:fixed;bottom:0` with backdrop blur.
- Tab icons use inline SVGs with `ICONS` path map.
- `.stem-player` and `.tabbar` are `position:fixed;bottom:0`, now **full frame width**
  (`max-width:none`, v0.227/0.242). Practice slide (`.practice-full`) at z-59, player at z-60,
  bounded above the measured bar height (`stemBarH`).
- `.stem-btns` buttons are size-uniform (`flex:1`; content-sized + centered on phones ≤640px).
  The CONFIG channel panel (`.stem-channels`) is an opaque absolute overlay above the bar.
- Wide-screen stem channels use a 4-column grid via `@media(min-width:900px)`.
