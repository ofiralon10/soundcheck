# Always-on AI band manager — Cloud Functions

Server-side backend for the AI manager. It runs on Google's clock (even when
nobody has the app open) and reaches people over **Telegram** — web push (FCM)
was removed in v0.316.

The Anthropic key lives here as a **server-side secret** — it is never in any
browser, so allowlisted bandmates can chat with the manager without any key on
their device. Scheduler/state bookkeeping is stored in function-only
collections (`managerState`, `managerChat`, `managerTasks`), never on the board
doc (which the app overwrites wholesale).

## The functions

- **managerChat** (callable, 540s / 512MiB) — the interactive Admin-tab chat.
  Enforces the chat allowlist, runs the agent loop, applies board `ops` in a
  transaction. This is the one that powers the Admin → chat box.
- **rehearsalReminders** (hourly) — ~24h before each upcoming rehearsal, DMs the
  owner a short manager note on Telegram. Sent once per rehearsal.
- **weeklyReport** (Mondays 09:00 Asia/Jerusalem) — a readiness/progress summary
  DM'd to the owner on Telegram.
- **managerTasks** (every 5 min, 540s / 512MiB) — runs due **scheduled tasks**
  the manager created (`schedule_task`), so timed actions fire with the app
  closed. Recurring tasks re-arm themselves in code.
- **telegramWebhook** (HTTP) — receives Telegram updates: `/start <code>`
  account linking and poll button taps.

Runtime: **Node 24**, `firebase-functions@7`, `firebase-admin@13` (pinned — see
the project CLAUDE.md before bumping).

## One-time setup

You need the Firebase CLI and the **Blaze** (pay-as-you-go) plan on
`soundcheck-1f16b`. Cloud Functions require Blaze; at this volume it stays
within the free tier, but Google requires a billing card on file.

```bash
npm i -g firebase-tools           # if not installed
firebase login                    # the Google account that owns the project

# 1. Enable Blaze: Firebase console -> ⚙ -> Usage and billing -> modify plan.

# 2. Store the two secrets (you paste each value at the prompt; write-only).
#    The NAMES must be exactly these — the code maps TELEGRAM_BOT_TOKEN to its
#    TELEGRAM_TOKEN variable, so the *secret name* is TELEGRAM_BOT_TOKEN.
firebase functions:secrets:set ANTHROPIC_KEY        # a dedicated, spend-capped key is best
firebase functions:secrets:set TELEGRAM_BOT_TOKEN   # from @BotFather (see "Telegram bot" below)

# 3. Install deps and deploy the functions + the updated Firestore rules.
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```

> **Verify the deploy actually landed.** `firebase deploy` prints a green
> "Deploy complete!" even when it **skipped** functions whose source hash was
> unchanged, and a runtime-only change in `firebase.json` is silently skipped.
> Always confirm with `firebase functions:list` — you should see all five
> functions in `us-central1` on `nodejs24`. If a function you expected is
> missing, that's why the app shows "the manager isn't connected yet."

## Telegram bot

The manager DMs people and runs polls through a Telegram bot.

1. **Create the bot** with [@BotFather](https://t.me/BotFather) (`/newbot`).
   Copy the HTTP API token — that's the value for the `TELEGRAM_BOT_TOKEN`
   secret above.
2. **Set the bot username in the app:** Admin → Manager settings → Telegram bot
   username (e.g. `@your_band_bot`). Members then link themselves under
   **Setup → Your Telegram → Connect Telegram**.
3. **Register the webhook** so Telegram forwards updates to the
   `telegramWebhook` function. Get the function's URL from
   `firebase functions:list` (or the console), then:

   ```bash
   TOKEN='<the bot token>'
   URL='<telegramWebhook function URL from functions:list>'
   # The webhook secret is derived from the token (no extra stored secret):
   SECRET=$(node -e "console.log(require('crypto').createHash('sha256').update('soundcheck-webhook:'+process.argv[1]).digest('hex').slice(0,48))" "$TOKEN")
   curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
     --data-urlencode "url=$URL" \
     --data-urlencode "secret_token=$SECRET"
   ```

   `telegramWebhook` rejects any request whose `X-Telegram-Bot-Api-Secret-Token`
   doesn't match that derived value, so the `secret_token` above is required.

## Chat manager (`managerChat` callable)

Lets you (and allowlisted bandmates) **chat** with the manager from the Admin
tab — ask questions, give standing guidelines, and tell it to act (save a
guideline, set a player's status, set a rehearsal's focus, schedule a
rehearsal, DM a member, run a poll).

- Deployed by the same `firebase deploy --only functions,firestore:rules`
  above — no extra setup beyond the secrets + Blaze.
- **Who can chat:** you always (the `ADMIN_EMAIL` owner); add others in the app
  under **Admin → Manager settings → chat allowlist**. They must sign in with
  that exact email. The allowlist is enforced inside the function, not just the
  UI, and gates the whole Admin tab.
- **Guidelines:** edit them in **Admin → Manager settings → guidelines**. They
  shape the chat, the plan generator, and the reminders. The manager can also
  update them when you tell it to in chat.
- Chat history lives in a function-only `managerChat/{bandId}` doc (clients
  reach it only through the callable). Tool actions commit to the board in a
  transaction so they merge with the app's saves.

## Test without waiting

- Trigger a scheduled run now from the console: **Functions → the function →
  ⋯ → Test / Run now**, or with the CLI: `firebase functions:shell` then e.g.
  `rehearsalReminders()`.
- For a reminder to actually fire it needs an upcoming (not-done, dated)
  rehearsal within the next 24h on a board you own, and a linked Telegram owner.
- Logs: `firebase functions:log --only managerChat` (or the console). If the
  app shows "the manager isn't connected yet" **while** `functions:list` shows
  the function, it's deployed-but-crashing — the logs usually point at a missing
  secret.

## Tuning (edit `functions/index.js`, top of file)

- `TZ` — schedule timezone (default `Asia/Jerusalem`).
- `REMINDER_LEAD_HOURS` — how far ahead to remind (default 24).
- `MODEL` — Claude model (default `claude-sonnet-5`; flip to `claude-opus-4-8`
  for max reasoning, ~2× cost — Haiku was too weak).
- `APP_URL` — link included when a Telegram note is sent.
- Schedules are the `schedule:` strings on each `onSchedule(...)`.

After editing: `firebase deploy --only functions` (then re-verify with
`firebase functions:list`).

## Cost

Each chat turn, reminder, or scheduled task is one (or a few) Claude calls on
your key — a few cents at most. Function invocations are within Firebase's free
tier at this scale.
