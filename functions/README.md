# Always-on AI band manager — Cloud Functions

Two scheduled functions run on Google's clock (even when nobody has the app
open) and push notifications to the owner's phone:

- **rehearsalReminders** — hourly; ~24h before each upcoming rehearsal, asks
  Claude for a short manager note and pushes it. Sent once per rehearsal.
- **weeklyReport** — Mondays 09:00 (Asia/Jerusalem); a readiness/progress
  summary + this week's priority.

The Anthropic key lives here as a **server-side secret** — it is never in any
browser. Scheduler bookkeeping is stored in a separate `managerState`
collection (not on the board doc, which the app overwrites wholesale).

## One-time setup

You need the Firebase CLI and the **Blaze** (pay-as-you-go) plan on
`soundcheck-1f16b`. Scheduled functions require Blaze; at this volume it stays
within the free tier, but Google requires a billing card on file.

```bash
npm i -g firebase-tools           # if not installed
firebase login                    # the Google account that owns the project

# 1. Enable Blaze: Firebase console -> ⚙ -> Usage and billing -> modify plan.

# 2. Store your Anthropic API key as a secret (you paste it; it's write-only):
firebase functions:secrets:set ANTHROPIC_KEY
#   -> paste the key when prompted (a dedicated, spend-capped key is best)

# 3. Install deps and deploy functions + the updated Firestore rules:
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```

## Enable push on your phone

1. In the Firebase console: **Project settings → Cloud Messaging → Web
   configuration → Web Push certificates → Generate key pair.** Copy the key.
2. Paste it into the app: set `const VAPID_KEY='...'` near the top of
   `staging.html` **and** `index.html` (it's a public key, safe to embed), then
   redeploy the site (commit/push as usual).
3. Open the app on your phone → **Setup → AI manager notifications → Enable on
   this device**, and allow notifications. (iOS: the app must be added to the
   Home Screen first — iOS only allows web push from an installed PWA.)

That registers this device's token in `notifyTokens`. Repeat on any device you
want notified.

## Test without waiting

- Trigger a run now from the console: **Functions → rehearsalReminders /
  weeklyReport → ⋯ → Test / Run now**, or with the CLI:
  `firebase functions:shell` then `rehearsalReminders()`.
- For a reminder to actually fire it needs an upcoming (not-done, dated)
  rehearsal within the next 24h on a board you own.
- Logs: `firebase functions:log` (or the console).

## Tuning (edit `functions/index.js`, top of file)

- `TZ` — schedule timezone (default `Asia/Jerusalem`).
- `REMINDER_LEAD_HOURS` — how far ahead to remind (default 24).
- `MODEL` — Claude model (default `claude-opus-4-8`).
- `APP_URL` — link opened when a notification is tapped.
- Schedules are the `schedule:` strings on each `onSchedule(...)`.

After editing: `firebase deploy --only functions`.

## Cost

Each notification is one small Claude call on your key (a few cents at most).
Function invocations/FCM are within Firebase's free tier at this scale.
