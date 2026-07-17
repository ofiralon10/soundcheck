/**
 * Soundcheck — always-on AI band manager (Firebase Cloud Functions, 2nd gen).
 *
 * Runtime: Node 24 (set in firebase.json "runtime" AND package.json "engines" —
 * both must agree). NOTE: `firebase deploy` decides what to redeploy from a hash
 * of THIS source, so a runtime-only change in firebase.json is silently
 * "Skipped (No changes detected)" and the old runtime stays live. Touch this file
 * when changing the runtime, and verify with `firebase functions:list`.
 *
 * Deps: firebase-admin is pinned to 13.x — firebase-functions@7 peer-requires
 * ^11 || ^12 || ^13, so admin 14 does not resolve yet. Admin is imported via the
 * modular entry points (firebase-admin/app|firestore|messaging) because v14
 * removes the legacy `admin.*` namespace; that keeps the 14 bump a one-liner.
 *
 * Two scheduled jobs run on Anthropic's/Google's clock even when nobody has the
 * app open:
 *   rehearsalReminders — hourly; ~24h before each upcoming rehearsal it asks
 *                        Claude for a short manager note and pushes it to the
 *                        owner's phone(s). Sent once per rehearsal.
 *   weeklyReport       — weekly; a readiness/progress summary + priorities.
 *
 * Owner-only for now: both read the owner's boards and push only to the
 * owner's registered devices (collection `notifyTokens`, email == ADMIN_EMAIL).
 *
 * The Anthropic API key lives server-side as a secret (ANTHROPIC_KEY) — it is
 * never in any browser. State (which reminders were sent, last weekly time) is
 * kept in a SEPARATE `managerState` collection, NOT on the board doc — the app
 * overwrites the whole board doc on every save (last-write-wins), so anything
 * we wrote there would be clobbered.
 *
 * ---- CONFIG you may want to change ----
 */
const ADMIN_EMAIL = 'ofiralon10@gmail.com';        // must match ADMIN_EMAIL in the app
const TZ = 'Asia/Jerusalem';                       // schedule timezone
const REMINDER_LEAD_HOURS = 24;                    // how far ahead to remind
const MODEL = 'claude-opus-4-8';
const APP_URL = 'https://ofiralon10.github.io/soundcheck/'; // opened when a push is tapped
/* -------------------------------------- */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
// firebase-admin v14 removed the legacy `admin.*` namespace — modular imports only.
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const crypto = require('crypto');

initializeApp();
const db = getFirestore();
const ANTHROPIC_KEY = defineSecret('ANTHROPIC_KEY');
const TELEGRAM_TOKEN = defineSecret('TELEGRAM_BOT_TOKEN');

/* ---------- Telegram helpers ---------- */
async function tgApi(token, method, payload) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const j = await res.json();
  if (!j.ok) throw new Error('telegram ' + method + ': ' + (j.description || res.status));
  return j.result;
}
// Deterministic webhook secret (no extra stored secret) — sent as secret_token on
// setWebhook and verified on every incoming request.
function tgWebhookSecret(token) { return crypto.createHash('sha256').update('soundcheck-webhook:' + token).digest('hex').slice(0, 48); }
// Find a linked member's chat for this band by "me"/owner, email, name, or @username.
async function tgFindChat(bandId, recipient, callerEmail) {
  const snap = await db.collection('telegramChats').doc(bandId).get();
  const users = (snap.exists && Array.isArray(snap.data().users)) ? snap.data().users : [];
  if (!users.length) return null;
  const r = (recipient || '').trim().toLowerCase().replace(/^@/, '');
  if (r === 'me' || r === 'owner' || r === '') return users.find(u => u.email === callerEmail) || users.find(u => u.email === ADMIN_EMAIL) || null;
  return users.find(u => (u.email || '').toLowerCase() === r)
    || users.find(u => (u.firstName || '').toLowerCase() === r)
    || users.find(u => (u.username || '').toLowerCase() === r) || null;
}
async function sendTelegramToMember(bandId, recipient, message, callerEmail) {
  const target = await tgFindChat(bandId, recipient, callerEmail);
  if (!target) return 'No linked Telegram found for "' + recipient + '". They need to connect Telegram in the app first.';
  await tgApi(TELEGRAM_TOKEN.value(), 'sendMessage', { chat_id: target.chatId, text: message });
  return 'Sent a Telegram message to ' + (target.firstName || target.email) + '.';
}
// Ask linked members a multiple-choice question with tappable buttons; store the
// poll so callback answers can be collected against each member.
async function tgAskMembers(bandId, input, callerEmail) {
  const token = TELEGRAM_TOKEN.value();
  const question = (input.question || '').trim();
  const options = (input.options || []).map(o => String(o).trim()).filter(Boolean).slice(0, 8);
  if (!question || options.length < 2) return 'Need a question and at least 2 options.';
  const snap = await db.collection('telegramChats').doc(bandId).get();
  let users = (snap.exists && Array.isArray(snap.data().users)) ? snap.data().users : [];
  if (!users.length) return 'No one has linked Telegram yet.';
  const rec = (input.recipients || 'all').trim().toLowerCase();
  if (rec && rec !== 'all') {
    const wanted = rec.split(',').map(x => x.trim().replace(/^@/, '')).filter(Boolean);
    users = users.filter(u => wanted.includes((u.email || '').toLowerCase()) || wanted.includes((u.firstName || '').toLowerCase()) || wanted.includes((u.username || '').toLowerCase()) || (wanted.includes('me') && u.email === callerEmail));
  }
  if (!users.length) return 'None of those members have linked Telegram.';
  const pollId = genId();
  const keyboard = { inline_keyboard: options.map((o, i) => [{ text: o, callback_data: 'poll:' + pollId + ':' + i }]) };
  const recipients = [];
  for (const u of users) {
    try {
      const sent = await tgApi(token, 'sendMessage', { chat_id: u.chatId, text: '❓ ' + question, reply_markup: keyboard });
      recipients.push({ email: u.email, chatId: u.chatId, firstName: u.firstName || '', messageId: sent.message_id });
    } catch (e) { logger.error('ask_members send failed for ' + u.email + ': ' + e.message); }
  }
  if (!recipients.length) return 'Could not deliver the question to anyone.';
  await db.collection('telegramPolls').doc(pollId).set({ bandId, question, options, recipients, responses: [], createdBy: callerEmail, createdAt: Date.now() });
  return 'Asked ' + recipients.length + ' member' + (recipients.length === 1 ? '' : 's') + ': "' + question + '" — I\'ll collect their answers.';
}
async function tgPollResults(bandId) {
  const snap = await db.collection('telegramPolls').where('bandId', '==', bandId).get();
  if (snap.empty) return 'No questions have been asked yet.';
  const polls = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const p = polls[0];
  const responses = p.responses || [];
  const tally = {}; (p.options || []).forEach(o => { tally[o] = 0; });
  const answered = new Set();
  responses.forEach(r => { const o = r.optionLabel || (p.options || [])[r.option]; if (o != null) tally[o] = (tally[o] || 0) + 1; answered.add(r.email); });
  const pending = (p.recipients || []).filter(r => !answered.has(r.email)).map(r => r.firstName || r.email);
  const lines = ['Question: ' + p.question];
  Object.keys(tally).forEach(o => lines.push('- ' + o + ': ' + tally[o]));
  responses.forEach(r => lines.push('  · ' + (r.firstName || r.email) + ' → ' + (r.optionLabel || (p.options || [])[r.option])));
  if (pending.length) lines.push('Not answered yet: ' + pending.join(', '));
  return lines.join('\n');
}

/* ---------- readiness helpers (mirror the app) ---------- */
const CORE = ['keys', 'drums', 'guitar', 'bass', 'vocals'];
const LABEL = { keys: 'Keys', drums: 'Drums', guitar: 'Guitar', bass: 'Bass', vocals: 'Vocals' };
const SCORE = { ready: 1, practicing: 0.66, learning: 0.33, todo: 0 };
function entryReadiness(e) {
  const parts = CORE.map(id => SCORE[(e.parts || {})[id] || 'todo'] ?? 0);
  const guests = (e.guests || []).map(g => SCORE[g.status] ?? 0);
  const all = [...parts, ...guests];
  return all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
}
function pct(x) { return Math.round(x * 100); }
function titleOf(board, id) { const s = (board.songs || []).find(x => x.id === id); return s ? (s.title || 'Untitled') : null; }
function fmtWhen(iso) {
  try { return new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return iso; }
}

/* ---------- Claude (server-side; key never leaves the function) ---------- */
const NOTIF_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { title: { type: 'string' }, body: { type: 'string' } },
  required: ['title', 'body']
};
async function askClaude(key, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1000, system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: NOTIF_SCHEMA } }
    })
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('request declined');
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return JSON.parse(txt);
}

/* ---------- push ---------- */
async function pushToOwner(title, body) {
  const snap = await db.collection('notifyTokens').where('email', '==', ADMIN_EMAIL).get();
  const tokens = snap.docs.map(d => d.id);
  if (!tokens.length) { logger.warn('no notify tokens registered — nothing to push'); return 0; }
  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { fcmOptions: { link: APP_URL } }
  });
  // prune dead tokens
  const dead = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
    }
  });
  await Promise.all(dead.map(t => db.collection('notifyTokens').doc(t).delete().catch(() => {})));
  logger.info('pushed "' + title + '" — ok ' + resp.successCount + ', fail ' + resp.failureCount);
  return resp.successCount;
}

/* ---------- owner's boards ---------- */
async function ownerBoards() {
  const snap = await db.collection('boards').where('memberEmails', 'array-contains', ADMIN_EMAIL).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadState(bandId) {
  const d = await db.collection('managerState').doc(bandId).get();
  return d.exists ? d.data() : { sentReminders: [], lastWeekly: null };
}
function saveState(bandId, st) { return db.collection('managerState').doc(bandId).set(st, { merge: true }); }

/* ---------- Scheduled manager tasks ----------
   The manager can schedule an action for a future time; the `managerTasks`
   scheduled function (below) runs due ones by re-invoking the agent loop, so it
   acts even when nobody has the app open. Stored in their own collection (not on
   the board doc, which the app overwrites wholesale). Client access is denied —
   only these Admin-SDK functions read/write them. */
function tasksCol() { return db.collection('managerTasks'); }
// Offset (ms) that `tz` is ahead of UTC at the given instant.
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}
// Resolve a when-string to epoch ms. Full ISO with Z/offset is used as-is; a bare
// wall-clock 'YYYY-MM-DDTHH:mm[:ss]' is interpreted in TZ (Asia/Jerusalem).
function resolveWhen(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { const t = Date.parse(s); return isNaN(t) ? null : t; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) { const t = Date.parse(s); return isNaN(t) ? null : t; }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6] || 0);
  return guess - tzOffsetMs(new Date(guess), TZ);
}
function fmtWhenMs(ms) { return fmtWhen(new Date(ms).toISOString()); }
function pad2(n) { return String(n).padStart(2, '0'); }
// Wall-clock components of an instant, as seen in `tz`.
function wallPartsInTz(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = dtf.formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
  let h = +o.hour; if (h === 24) h = 0;
  return { y: +o.year, mo: +o.month, d: +o.day, h, mi: +o.minute };
}
// A normalized repeat rule, or null. { unit:'hour'|'day'|'week'|'month', interval:>=1 }.
function normalizeRepeat(rep) {
  if (!rep || ['hour', 'day', 'week', 'month'].indexOf(rep.unit) < 0) return null;
  return { unit: rep.unit, interval: Math.max(1, parseInt(rep.interval, 10) || 1) };
}
function repeatText(rep) {
  const r = normalizeRepeat(rep); if (!r) return '';
  return 'repeats every ' + (r.interval === 1 ? r.unit : (r.interval + ' ' + r.unit + 's'));
}
// Next occurrence after prevMs. Hourly is real elapsed time; day/week/month keep
// the wall-clock time fixed in TZ (so "daily at 09:00" stays 09:00 across DST).
function nextRunMs(prevMs, rep) {
  const r = normalizeRepeat(rep); if (!r) return null;
  if (r.unit === 'hour') return prevMs + r.interval * 3600000;
  const p = wallPartsInTz(prevMs, TZ);
  let base = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
  if (r.unit === 'day') base += r.interval * 86400000;
  else if (r.unit === 'week') base += r.interval * 7 * 86400000;
  else { // month — clamp the day to the target month's last valid day (Jan 31 -> Feb 28/29)
    let mo = (p.mo - 1) + r.interval;
    const y = p.y + Math.floor(mo / 12);
    mo = ((mo % 12) + 12) % 12;
    const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    base = Date.UTC(y, mo, Math.min(p.d, daysInMonth), p.h, p.mi, 0);
  }
  const q = new Date(base);
  const iso = q.getUTCFullYear() + '-' + pad2(q.getUTCMonth() + 1) + '-' + pad2(q.getUTCDate()) + 'T' + pad2(q.getUTCHours()) + ':' + pad2(q.getUTCMinutes());
  return resolveWhen(iso);
}
// Next occurrence strictly in the future — skips any missed ones (no catch-up storm).
function nextFutureRunMs(prevMs, rep) {
  let next = nextRunMs(prevMs, rep);
  let guard = 0;
  while (next != null && next <= Date.now() && guard++ < 5000) {
    const n2 = nextRunMs(next, rep);
    if (n2 == null || n2 <= next) return null;
    next = n2;
  }
  return next;
}
async function loadPendingTasks(bandId) {
  // Single-field filter (auto-indexed) + status filter in code — no composite index.
  const snap = await tasksCol().where('bandId', '==', bandId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.status === 'pending')
    .sort((a, b) => (a.runAtMs || 0) - (b.runAtMs || 0));
}
async function createScheduledTask(bandId, showId, inp, email) {
  const ms = resolveWhen(inp.when);
  if (!ms) return 'I need a valid time like "2026-07-20T09:00" (Asia/Jerusalem). Nothing scheduled.';
  if (ms < Date.now() - 60000) return 'That time is in the past — give me a future time.';
  const instruction = (inp.instruction || '').trim();
  if (!instruction) return 'I need to know what to do at that time. Nothing scheduled.';
  const repeat = normalizeRepeat(inp.repeat);
  await tasksCol().doc().set({ bandId, showId: showId || null, runAtMs: ms, whenText: String(inp.when || ''), instruction, title: (inp.title || '').trim(), repeat: repeat || null, status: 'pending', createdBy: email || ADMIN_EMAIL, createdAt: Date.now() });
  return 'Scheduled ✓ — ' + (repeat ? ('starting ' + fmtWhenMs(ms) + ', ' + repeatText(repeat) + ', I will: ') : ('at ' + fmtWhenMs(ms) + ' I will: ')) + instruction + ' (runs even with the app closed; ' + (repeat ? 'repeats automatically' : 'one-time') + ').';
}
async function listScheduledTasksText(bandId) {
  const t = await loadPendingTasks(bandId);
  if (!t.length) return 'No pending scheduled tasks.';
  return 'Pending scheduled tasks:\n' + t.map((x, i) => 'T' + (i + 1) + ' — ' + fmtWhenMs(x.runAtMs) + (x.repeat ? (' (' + repeatText(x.repeat) + ')') : '') + ': ' + (x.title ? (x.title + ' — ') : '') + x.instruction).join('\n');
}
async function cancelScheduledTask(ctx, inp) {
  const id = (ctx.taskIds || [])[(parseInt(inp.task, 10) || 0) - 1];
  if (!id) return 'No scheduled task T' + inp.task + '.';
  await tasksCol().doc(id).set({ status: 'cancelled', cancelledAt: Date.now() }, { merge: true });
  return 'Cancelled scheduled task T' + inp.task + '.';
}

/* ---------- brief builders ---------- */
function weakestSongs(board, show, n) {
  const entries = (show.setlist || []).filter(e => !e.excluded);
  return entries
    .map(e => ({ title: titleOf(board, e.songId) || 'Untitled', r: entryReadiness(e) }))
    .sort((a, b) => a.r - b.r).slice(0, n)
    .map(s => s.title + ' ' + pct(s.r) + '%');
}
function instrAverages(show) {
  const entries = (show.setlist || []).filter(e => !e.excluded);
  return CORE.map(id => {
    const vals = entries.map(e => SCORE[(e.parts || {})[id] || 'todo'] ?? 0);
    return { id, label: LABEL[id], avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 };
  });
}
function showOverall(show) {
  const entries = (show.setlist || []).filter(e => !e.excluded);
  return entries.length ? entries.reduce((a, e) => a + entryReadiness(e), 0) / entries.length : 0;
}
function daysUntil(iso) { if (!iso) return null; return Math.ceil((new Date(iso).setHours(23, 59, 59, 0) - Date.now()) / 86400000); }

/* ============================ REMINDERS ============================ */
const REMINDER_SYSTEM =
  'You are the band\'s manager sending a short, motivating heads-up before a rehearsal. ' +
  'Given the rehearsal details and the current readiness, write a push notification: a punchy title (<=6 words) ' +
  'and a body under 55 words that names the focus and the 1-2 things to nail. Warm, direct, specific. No filler, no emoji spam.';

exports.rehearsalReminders = onSchedule(
  { schedule: 'every 60 minutes', timeZone: TZ, secrets: [ANTHROPIC_KEY] },
  async () => {
    const key = ANTHROPIC_KEY.value();
    const boards = await ownerBoards();
    for (const board of boards) {
      const st = await loadState(board.id);
      const sent = new Set(st.sentReminders || []);
      const now = Date.now();
      const leadMs = REMINDER_LEAD_HOURS * 3600 * 1000;
      const reh = (board.rehearsals || []).filter(r => !r.done && r.date);
      for (const r of reh) {
        const when = new Date(r.date).getTime();
        if (isNaN(when)) continue;
        const due = now >= when - leadMs && now < when;   // inside the lead window, not yet passed
        if (!due || sent.has(r.id)) continue;
        const show = (board.shows || []).find(s => s.id === r.showId);
        const focus = [...(r.focusLearn || []), ...(r.focusPractice || [])]
          .map(id => titleOf(board, id)).filter(Boolean);
        const gl = (board.managerGuidelines || '').trim();
        const brief = [
          gl ? ('OWNER GUIDELINES (honor these): ' + gl) : '',
          'BAND: ' + (board.band || board.id),
          'SHOW: ' + (show ? (show.name || 'Untitled') : '—') + (show && show.date ? (' (' + (daysUntil(show.date)) + ' days out)') : ''),
          'REHEARSAL: ' + fmtWhen(r.date) + (r.duration ? (' (' + r.duration + 'h)') : '') + (r.location ? (' @ ' + r.location) : ''),
          'PLANNED FOCUS: ' + (focus.length ? focus.join(', ') : '(none set)'),
          show ? ('SHOW READINESS: ' + pct(showOverall(show)) + '%; weakest: ' + weakestSongs(board, show, 3).join(', ')) : ''
        ].filter(Boolean).join('\n');
        try {
          const msg = await askClaude(key, REMINDER_SYSTEM, 'Write the reminder.\n\n' + brief);
          await pushToOwner(msg.title || 'Rehearsal soon', msg.body || '');
          sent.add(r.id);
        } catch (e) { logger.error('reminder failed for ' + board.id + '/' + r.id + ': ' + e.message); }
      }
      // keep only ids that are still upcoming, so the set doesn't grow forever
      const keep = (board.rehearsals || []).filter(r => !r.done && r.date && new Date(r.date).getTime() > now - leadMs).map(r => r.id);
      st.sentReminders = [...sent].filter(id => keep.includes(id));
      await saveState(board.id, st);
    }
  }
);

/* ============================ WEEKLY REPORT ============================ */
const WEEKLY_SYSTEM =
  'You are the band\'s manager writing the weekly progress check-in as a push notification. ' +
  'Given the show status, per-player averages and the weakest material with time remaining, write a title (<=7 words) ' +
  'and a body under 65 words: where the band stands, the single biggest risk, and this week\'s priority. ' +
  'Motivating and concrete. If the timeline is tight, say so.';

exports.weeklyReport = onSchedule(
  { schedule: 'every monday 09:00', timeZone: TZ, secrets: [ANTHROPIC_KEY] },
  async () => {
    const key = ANTHROPIC_KEY.value();
    const boards = await ownerBoards();
    for (const board of boards) {
      // report on the soonest upcoming show that still has songs
      const shows = (board.shows || []).filter(s => (s.setlist || []).some(e => !e.excluded));
      if (!shows.length) continue;
      shows.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
      const show = shows[0];
      const inst = instrAverages(show).sort((a, b) => a.avg - b.avg);
      const gl = (board.managerGuidelines || '').trim();
      const brief = [
        gl ? ('OWNER GUIDELINES (honor these): ' + gl) : '',
        'BAND: ' + (board.band || board.id),
        'SHOW: ' + (show.name || 'Untitled') + (show.date ? (' on ' + fmtWhen(show.date) + ' (' + daysUntil(show.date) + ' days out)') : ' (no date)'),
        'OVERALL READINESS: ' + pct(showOverall(show)) + '%',
        'PER-PLAYER (weakest first): ' + inst.map(x => x.label + ' ' + pct(x.avg) + '%').join(', '),
        'WEAKEST SONGS: ' + weakestSongs(board, show, 4).join(', '),
        'PROGRESS TREND: ' + ((show.readinessHistory || []).slice(-6).map(p => p.v + '%').join(' → ') || '(no history)')
      ].join('\n');
      try {
        const msg = await askClaude(key, WEEKLY_SYSTEM, 'Write the weekly check-in.\n\n' + brief);
        await pushToOwner(msg.title || 'Weekly band check-in', msg.body || '');
        await saveState(board.id, { lastWeekly: new Date().toISOString() });
      } catch (e) { logger.error('weekly failed for ' + board.id + ': ' + e.message); }
    }
  }
);

/* ============================ CHAT MANAGER (callable) ============================
   Owner + allowlisted members chat with the manager. Runs server-side with the
   shared key; the manager can act via tools (guidelines, statuses, focus,
   scheduling). Chat history lives in a function-only `managerChat/{bandId}` doc
   so the app's whole-doc board saves never clobber it. Tool actions commit to
   the board in a transaction (merge onto the latest doc). */
const MANAGER_SYSTEM =
  'You are the band\'s manager, in an ongoing chat with a band member. You have the current band data and the owner\'s standing guidelines below. ' +
  'Answer questions and give concrete, motivating advice. When asked to change something — save a guideline, set a player\'s status, set a rehearsal\'s focus, or schedule a rehearsal — use the tools, then confirm in plain language what you did. ' +
  'When the member explicitly asks you to notify, alert, ping, or remind someone right now, use send_notification to push a phone notification (keep the title <=6 words and the body short). Do not send notifications unprompted. ' +
  'You CAN run things later, on a schedule, even when nobody has the app open — use schedule_task with a future time (see CURRENT TIME in the context) and a clear instruction to your future self; use list_scheduled_tasks / cancel_scheduled_task to manage them. For a repeating task, set schedule_task\'s `repeat` field — it re-arms itself automatically, so never manually re-schedule a recurring task. Never tell anyone you cannot run background or timed tasks — you can, via schedule_task. ' +
  'Reference songs by their #number and rehearsals by their R-number. Always honor the owner guidelines. Be concise and direct — this is a chat, not a report.\n' +
  'FORMATTING — the chat renders these, so use them to make messages scannable:\n' +
  '  **bold**, *italic*, `code`, "- " bullet lines, and "## " for a small heading.\n' +
  '  {color:text} colors text. Colors: red, green, amber, orange, yellow, blue, purple, pink, teal, grey.\n' +
  '  An instrument name is also a color, matching that instrument in the app: {keys:...} {drums:...} {guitar:...} {bass:...} {vocals:...}.\n' +
  '  Use them with meaning, not decoration: {red:...} for problems/behind, {green:...} for ready/good, {amber:...} for needs work,\n' +
  '  and an instrument color when naming that player or their part (e.g. {drums:Dana} is behind on #4).\n' +
  '  Emoji are welcome where they aid scanning (🎸 🥁 🎹 ✅ ⚠️ 🔥) — a few, not a wall of them.\n' +
  '  Anything you write is literal text otherwise; unknown color names render as-is, so stick to the list.';

const MANAGER_TOOLS = [
  { name: 'save_guideline', description: 'Save/append to the owner\'s standing guidelines. They persist and shape all future chat, plans and reminders.', input_schema: { type: 'object', properties: { text: { type: 'string' }, replace: { type: 'boolean', description: 'true replaces all guidelines; false appends.' } }, required: ['text'] } },
  { name: 'set_song_status', description: 'Set one player\'s readiness on a setlist song.', input_schema: { type: 'object', properties: { song: { type: 'integer', description: '#number from the setlist' }, instrument: { type: 'string', enum: ['keys', 'drums', 'guitar', 'bass', 'vocals'] }, status: { type: 'string', enum: ['todo', 'learning', 'practicing', 'ready'] } }, required: ['song', 'instrument', 'status'] } },
  { name: 'apply_focus', description: 'Set learn/practice focus on an existing upcoming rehearsal (by R-number).', input_schema: { type: 'object', properties: { rehearsal: { type: 'integer' }, learn: { type: 'array', items: { type: 'integer' } }, practice: { type: 'array', items: { type: 'integer' } }, note: { type: 'string' } }, required: ['rehearsal'] } },
  { name: 'create_rehearsal', description: 'Schedule a new rehearsal for this show.', input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM 24h (default 20:00)' }, durationHours: { type: 'number' }, location: { type: 'string' }, learn: { type: 'array', items: { type: 'integer' } }, practice: { type: 'array', items: { type: 'integer' } } }, required: ['date'] } },
  { name: 'send_notification', description: 'Push a phone notification to the registered device(s). Use only when the member explicitly asks to notify/alert/remind/ping now.', input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Short title (<=6 words)' }, body: { type: 'string', description: 'Short message body' } }, required: ['title', 'body'] } },
  { name: 'send_telegram', description: 'Send a Telegram direct message to a band member who has linked Telegram. Use when asked to message/DM/telegram someone.', input_schema: { type: 'object', properties: { recipient: { type: 'string', description: 'Member name or email, or "me" for the owner' }, message: { type: 'string' } }, required: ['recipient', 'message'] } },
  { name: 'ask_members', description: 'Ask linked band members a multiple-choice question over Telegram (tappable option buttons) and collect their answers. Use when asked to poll/ask/survey the band with options.', input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: '2-8 answer options' }, recipients: { type: 'string', description: '"all" for everyone linked, or a comma-separated list of names/emails' } }, required: ['question', 'options'] } },
  { name: 'get_poll_results', description: 'Read back the answers to the most recent question asked via ask_members (tally + who answered what + who hasn\'t).', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'show_plan', description: 'Display a rehearsal plan in the app (the "Rehearsal plan" panel under the chat) for the band to see. Use when asked to lay out / show / post a plan. Write song names and docs as plain text.', input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'One or two lines of overview' }, sessions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', description: 'e.g. "Rehearsal 1 — Sun Mar 8"' }, learn: { type: 'array', items: { type: 'string' } }, practice: { type: 'array', items: { type: 'string' } }, docs: { type: 'array', items: { type: 'string' }, description: 'Docs to prepare, e.g. "slide for Black Bird"' }, note: { type: 'string' } }, required: ['title'] } } }, required: ['sessions'] } },
  { name: 'set_approval', description: "Record a player's attendance answer for a rehearsal. Use status 'yes' when they confirm they can make it, 'no' when they say they can't, 'maybe' when they're unsure, and 'clear' to reset them to un-answered.", input_schema: { type: 'object', properties: { rehearsal: { type: 'integer', description: 'R-number of the rehearsal' }, instrument: { type: 'string', enum: ['keys', 'drums', 'guitar', 'bass', 'vocals'] }, status: { type: 'string', enum: ['yes', 'no', 'maybe', 'clear'], description: "yes = can attend, no = can't attend, maybe = unsure, clear = un-answered" } }, required: ['rehearsal', 'instrument', 'status'] } },
  { name: 'schedule_task', description: 'Schedule an action to run automatically at a future time — even when nobody has the app open. At that moment you are re-invoked with the instruction and can use your other tools (send_notification, send_telegram, ask_members, board tools). Use for reminders, follow-ups and time-based nudges. For a REPEATING task, set the `repeat` field and the system re-arms it automatically after each run — do NOT re-schedule it yourself. Times are ' + TZ + '.', input_schema: { type: 'object', properties: { when: { type: 'string', description: 'When to run (first time, if repeating), as YYYY-MM-DDTHH:MM in ' + TZ + ' local time (or full ISO 8601 with offset). Must be in the future — see CURRENT TIME in the context.' }, instruction: { type: 'string', description: 'Exactly what to do when it runs, written as an instruction to your future self. Be specific: who to message, what to ask or say.' }, title: { type: 'string', description: 'Optional short label.' }, repeat: { type: 'object', description: 'Optional — makes the task recurring; it re-arms itself after each run (cancel with cancel_scheduled_task). E.g. {unit:"day",interval:1} = daily, {unit:"week",interval:2} = every 2 weeks.', properties: { unit: { type: 'string', enum: ['hour', 'day', 'week', 'month'] }, interval: { type: 'integer', description: 'Every N units (default 1).' } }, required: ['unit'] } }, required: ['when', 'instruction'] } },
  { name: 'list_scheduled_tasks', description: 'List the pending scheduled tasks you have set for this band (also shown as T-numbers in the context).', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'cancel_scheduled_task', description: 'Cancel a pending scheduled task by its T-number.', input_schema: { type: 'object', properties: { task: { type: 'integer' } }, required: ['task'] } }
];

function genId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function fileCatOf(f) { return f.cat === 'original' ? 'other' : (f.cat || 'other'); }
function songFileSummary(song) {
  const files = song.files || [];
  const hasSlide = files.some(f => fileCatOf(f) === 'slide' && f.url);
  const stemCats = [...new Set(files.filter(f => f.stem).map(fileCatOf).filter(c => ['vocals', 'drums', 'bass', 'guitar', 'keys', 'other'].includes(c)))];
  const recordings = files.filter(f => /recording/i.test(f.name || '')).length;
  const otherDocs = files.filter(f => !f.stem && fileCatOf(f) !== 'slide' && f.url).length;
  const parts = ['slide ' + (hasSlide ? '✓' : '✗'), 'stems ' + stemCats.length + '/6' + (stemCats.length ? (' (' + stemCats.join(',') + ')') : '')];
  if (recordings) parts.push(recordings + ' rec');
  if (otherDocs) parts.push(otherDocs + ' other doc' + (otherDocs === 1 ? '' : 's'));
  if (!files.length) return 'no files';
  return parts.join(', ');
}
// Sections every song is expected to have material for. Empty ones are called out
// as MISSING so the manager can spot gaps; 'other'/'metronome'/'stem-rec' are
// optional and only listed when they actually have files.
const DOC_SECS = ['slide', 'vocals', 'drums', 'bass', 'guitar', 'keys'];
const OPT_SECS = ['other', 'metronome'];
function fmtFileName(f) {
  return '"' + (f.name || 'unnamed') + '"'
    + (f.stem ? ' [stem]' : '')
    + (f.kind === 'link' ? ' [link]' : '')
    + (f.ver ? ' [v' + f.ver + ']' : '');
}
// Full per-section file listing for one song, with names — lets the manager say
// exactly which section of which song is missing a document.
function songFilesDetail(song) {
  const files = (song.files || []).filter(f => f.url);
  if (!files.length) return '    (NO FILES AT ALL)';
  const out = [];
  DOC_SECS.forEach(sec => {
    const fs = files.filter(f => fileCatOf(f) === sec);
    out.push('    ' + sec + ': ' + (fs.length ? fs.map(fmtFileName).join(', ') : '*** MISSING ***'));
  });
  OPT_SECS.forEach(sec => {
    const fs = files.filter(f => fileCatOf(f) === sec);
    if (fs.length) out.push('    ' + sec + ': ' + fs.map(fmtFileName).join(', '));
  });
  const recs = files.filter(f => fileCatOf(f) === 'stem-rec');
  if (recs.length) out.push('    personal stem recordings: ' + recs.map(f => (f.by || '?') + ' — "' + (f.name || '') + '"').join(', '));
  return out.join('\n');
}
function buildManagerContextNode(board, show, opts) {
  opts = opts || {};
  const songsAll = board.songs || [];
  const entries = (show.setlist || []).filter(e => !e.excluded);
  const idxToSong = []; const songLines = [];
  entries.forEach(e => {
    const s = songsAll.find(x => x.id === e.songId); if (!s) return;
    idxToSong.push(e.songId);
    const parts = CORE.map(id => LABEL[id] + ':' + ((e.parts || {})[id] || 'todo')).join(', ');
    const kt = [s.songKey, s.tempo ? ('~' + s.tempo + 'bpm') : ''].filter(Boolean).join(' ');
    songLines.push('#' + idxToSong.length + ' "' + (s.title || 'Untitled') + '"' + (s.artist ? (' — ' + s.artist) : '') + (kt ? (' [' + kt + ']') : '') + ' | overall ' + pct(entryReadiness(e)) + '% | ' + parts + ' | files: ' + songFileSummary(s));
  });
  const inSet = new Set(entries.map(e => e.songId));
  const otherLines = songsAll.filter(s => !inSet.has(s.id)).map(s => '- "' + (s.title || 'Untitled') + '"' + (s.artist ? (' — ' + s.artist) : '') + ' | files: ' + songFileSummary(s));
  // Full file inventory, per song, per section — for spotting gaps.
  const fileDetailLines = [];
  idxToSong.forEach((sid, i) => {
    const s = songsAll.find(x => x.id === sid); if (!s) return;
    fileDetailLines.push('#' + (i + 1) + ' "' + (s.title || 'Untitled') + '"');
    fileDetailLines.push(songFilesDetail(s));
  });
  songsAll.filter(s => !inSet.has(s.id)).forEach(s => {
    fileDetailLines.push('(not in show) "' + (s.title || 'Untitled') + '"');
    fileDetailLines.push(songFilesDetail(s));
  });
  const showLines = (board.shows || []).map(sh => {
    const active = (sh.setlist || []).filter(e => !e.excluded);
    return '- "' + (sh.name || 'Untitled') + '" — ' + (sh.date ? (fmtWhen(sh.date) + ' (' + daysUntil(sh.date) + ' days out)') : 'no date') + ', ' + active.length + ' songs, ' + pct(showOverall(sh)) + '% ready' + (sh.id === show.id ? ' [current]' : '');
  });
  const reh = (board.rehearsals || []).filter(r => r.showId === show.id && !r.done && r.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const rehIds = reh.map(r => r.id);
  const rehLines = reh.map((r, i) => {
    const a = r.attendance || {};
    // States: 'yes'/true = can attend, 'no' = can't, 'maybe' = unsure, else un-answered.
    const st = id => (a[id] === true || a[id] === 'yes') ? 'yes' : (a[id] === 'no' ? 'no' : (a[id] === 'maybe' ? 'maybe' : 'none'));
    const yes = CORE.filter(id => st(id) === 'yes');
    const no = CORE.filter(id => st(id) === 'no');
    const maybe = CORE.filter(id => st(id) === 'maybe');
    const pend = CORE.filter(id => st(id) === 'none');
    const appr = (!no.length && !maybe.length && !pend.length) ? 'ALL can attend'
      : (yes.length + '/' + CORE.length + ' confirmed'
        + (no.length ? "; CAN'T attend: " + no.map(id => LABEL[id]).join(',') : '')
        + (maybe.length ? '; MAYBE: ' + maybe.map(id => LABEL[id]).join(',') : '')
        + (pend.length ? '; no answer yet: ' + pend.map(id => LABEL[id]).join(',') : ''));
    return 'R' + (i + 1) + ' ' + fmtWhen(r.date) + (r.duration ? (' (' + r.duration + 'h)') : '') + (r.location ? (' @ ' + r.location) : '') + (((r.focusLearn || []).length || (r.focusPractice || []).length) ? ' [focus set]' : '') + ' | attendance: ' + appr;
  });
  const g = (board.managerGuidelines || '').trim();
  const lineup = CORE.map(id => LABEL[id] + ' = ' + ((board.members && board.members[id] && board.members[id].name) || '(unnamed)')).join(', ');
  const taskIds = [];
  const taskLines = (opts.tasks || []).map((t, i) => { taskIds.push(t.id); return 'T' + (i + 1) + ' — ' + fmtWhenMs(t.runAtMs) + (t.repeat ? (' (' + repeatText(t.repeat) + ')') : '') + ': ' + (t.title ? (t.title + ' — ') : '') + t.instruction; });
  const nowLine = 'CURRENT TIME: ' + (opts.nowMs ? new Date(opts.nowMs).toLocaleString('en-GB', { timeZone: TZ }) : '(unknown)') + ' (' + TZ + '). Schedule future tasks relative to this.';
  const context = [
    g ? ('OWNER GUIDELINES (always honor these):\n' + g) : 'OWNER GUIDELINES: (none set)',
    '',
    nowLine,
    '',
    'BAND: ' + (board.band || ''),
    'LINEUP: ' + lineup,
    '',
    'SHOWS (all shows for this band):',
    ...(showLines.length ? showLines : ['(none)']),
    '',
    'CURRENT SHOW: "' + (show.name || 'Untitled') + '"' + (show.date ? (' on ' + fmtWhen(show.date) + ' (' + daysUntil(show.date) + ' days out)') : ' (no date)') + ' — overall ' + pct(showOverall(show)) + '% ready.',
    'SETLIST (reference songs by #number; readiness scale todo/learning/practicing/ready; "files" shows what documents each song has):',
    ...(songLines.length ? songLines : ['(empty)']),
    ...(otherLines.length ? ['', 'OTHER SONGS in the library (not in this show), with their files:', ...otherLines] : []),
    '',
    'SONG FILES — full inventory of every file, by song and section. A section marked',
    '*** MISSING *** has no document at all; use this to spot gaps (e.g. a song with no',
    'slide, or no chart for a specific instrument). [stem] = a real stem audio file.',
    ...(fileDetailLines.length ? fileDetailLines : ['(no songs)']),
    '',
    'UPCOMING REHEARSALS (reference by R-number):',
    ...(rehLines.length ? rehLines : ['(none scheduled)']),
    '',
    'SCHEDULED TASKS you have set (reference by T-number; times are ' + TZ + '):',
    ...(taskLines.length ? taskLines : ['(none)'])
  ].join('\n');
  return { context, idxToSong, rehIds, taskIds };
}

function applyOpToBoard(op, board) {
  if (op.type === 'guideline') {
    const t = (op.text || '').trim();
    board.managerGuidelines = op.replace ? t : ((board.managerGuidelines || '').trim() ? (board.managerGuidelines.trim() + '\n' + t) : t);
  } else if (op.type === 'status') {
    const sh = (board.shows || []).find(s => s.id === op.showId);
    if (sh) { const e = (sh.setlist || []).find(x => x.songId === op.songId); if (e) { e.parts = e.parts || {}; e.parts[op.instrument] = op.status; } }
  } else if (op.type === 'focus') {
    const r = (board.rehearsals || []).find(x => x.id === op.rehId);
    if (r) { if (op.learn) r.focusLearn = op.learn; if (op.practice) r.focusPractice = op.practice; if (op.note) r.notes = (r.notes ? r.notes + '\n' : '') + op.note; }
  } else if (op.type === 'rehearsal') {
    board.rehearsals = board.rehearsals || []; board.rehearsals.push(op.reh);
  } else if (op.type === 'plan') {
    board.managerPlan = op.plan;
  } else if (op.type === 'approval') {
    const r = (board.rehearsals || []).find(x => x.id === op.rehId);
    if (r) {
      r.attendance = r.attendance || {};
      if (op.status === 'clear') delete r.attendance[op.instrument];
      else r.attendance[op.instrument] = op.status; // 'yes' | 'no'
    }
  }
}

function applyManagerTool(name, input, ctx, showId, work, ops) {
  const songId = n => ctx.idxToSong[(parseInt(n, 10) || 0) - 1] || null;
  const title = id => { const s = (work.songs || []).find(x => x.id === id); return s ? (s.title || 'Untitled') : id; };
  let op = null, msg = '';
  if (name === 'save_guideline') {
    op = { type: 'guideline', text: input.text || '', replace: !!input.replace };
    msg = 'Guidelines ' + (input.replace ? 'replaced' : 'updated') + '.';
  } else if (name === 'set_song_status') {
    const id = songId(input.song); if (!id) return 'No song #' + input.song + '.';
    op = { type: 'status', showId, songId: id, instrument: input.instrument, status: input.status };
    msg = 'Set ' + input.instrument + ' = ' + input.status + ' on #' + input.song + ' (' + title(id) + ').';
  } else if (name === 'apply_focus') {
    const rehId = ctx.rehIds[(parseInt(input.rehearsal, 10) || 0) - 1]; if (!rehId) return 'No rehearsal R' + input.rehearsal + '.';
    const L = (input.learn || []).map(songId).filter(Boolean), P = (input.practice || []).map(songId).filter(Boolean);
    op = { type: 'focus', rehId, learn: input.learn ? L : null, practice: input.practice ? P : null, note: input.note || '' };
    msg = 'Updated rehearsal R' + input.rehearsal + ' focus.';
  } else if (name === 'create_rehearsal') {
    const t = (input.time && /^\d{1,2}:\d{2}$/.test(input.time)) ? input.time : '20:00';
    const iso = input.date + 'T' + (t.length === 4 ? ('0' + t) : t);
    const L = (input.learn || []).map(songId).filter(Boolean), P = (input.practice || []).map(songId).filter(Boolean);
    const reh = { id: genId(), showId, date: iso, duration: String(input.durationHours || 2), location: input.location || '', notes: '', focusLearn: L, focusPractice: P, attendance: {}, apprReset: true, proposal: null, done: false };
    op = { type: 'rehearsal', reh };
    msg = 'Scheduled a rehearsal on ' + input.date + ' ' + t + '.';
  } else if (name === 'show_plan') {
    const sessions = (input.sessions || []).map(s => ({ title: s.title || '', learn: s.learn || [], practice: s.practice || [], docs: s.docs || [], note: s.note || '' }));
    op = { type: 'plan', plan: { summary: input.summary || '', sessions, updatedAt: Date.now() } };
    msg = 'Posted the rehearsal plan to the app (' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ').';
  } else if (name === 'set_approval') {
    const rehId = ctx.rehIds[(parseInt(input.rehearsal, 10) || 0) - 1]; if (!rehId) return 'No rehearsal R' + input.rehearsal + '.';
    // `status` is the current shape; tolerate the older boolean `approved`.
    let stt = input.status;
    if (!stt && input.approved !== undefined) stt = input.approved ? 'yes' : 'clear';
    if (['yes', 'no', 'maybe', 'clear'].indexOf(stt) < 0) return "status must be 'yes', 'no', 'maybe' or 'clear'.";
    op = { type: 'approval', rehId, instrument: input.instrument, status: stt };
    msg = 'Marked ' + input.instrument + ' as ' + (stt === 'yes' ? 'able to attend' : stt === 'no' ? "unable to attend" : stt === 'maybe' ? 'a maybe' : 'not answered') + ' for rehearsal R' + input.rehearsal + '.';
  } else { return 'Unknown tool.'; }
  ops.push(op); applyOpToBoard(op, work); return msg;
}

async function anthropicRaw(key, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

// The shared manager agent loop. Runs the tool-use conversation and returns the
// reply plus the board `ops` (for the caller to persist) and the tool names used.
// Used by both managerChat (interactive) and the managerTasks scheduler (autonomous).
async function runManagerLoop({ bandId, board, show, ctx, apiMsgs, email, key }) {
  const sys = MANAGER_SYSTEM + '\n\n' + ctx.context;
  const work = JSON.parse(JSON.stringify(board));   // in-loop tool effects land here
  const ops = []; const actions = []; let reply = '';
  for (let step = 0; step < 6; step++) {
    const data = await anthropicRaw(key, { model: MODEL, max_tokens: 2000, system: sys, messages: apiMsgs, tools: MANAGER_TOOLS });
    if (data.stop_reason === 'refusal') { reply = 'Sorry — I can\'t help with that one.'; break; }
    apiMsgs.push({ role: 'assistant', content: data.content });
    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    if (data.stop_reason === 'tool_use' && toolUses.length) {
      const results = [];
      for (const tu of toolUses) {
        let out; const inp = tu.input || {};
        if (tu.name === 'send_notification') {
          try {
            const n = await pushToOwner(inp.title || 'Band manager', inp.body || '');
            out = n > 0 ? ('Notification pushed to ' + n + ' device' + (n === 1 ? '' : 's') + '.')
                        : 'No devices are registered for notifications yet — enable notifications in Setup first.';
          } catch (e) { out = 'Could not send the notification: ' + e.message; }
        } else if (tu.name === 'send_telegram') {
          try { out = await sendTelegramToMember(bandId, inp.recipient || 'me', inp.message || '', email); }
          catch (e) { out = 'Could not send the Telegram message: ' + e.message; }
        } else if (tu.name === 'ask_members') {
          try { out = await tgAskMembers(bandId, inp, email); }
          catch (e) { out = 'Could not send the question: ' + e.message; }
        } else if (tu.name === 'get_poll_results') {
          try { out = await tgPollResults(bandId); }
          catch (e) { out = 'Could not read the results: ' + e.message; }
        } else if (tu.name === 'schedule_task') {
          try { out = await createScheduledTask(bandId, show.id, inp, email); }
          catch (e) { out = 'Could not schedule that: ' + e.message; }
        } else if (tu.name === 'list_scheduled_tasks') {
          try { out = await listScheduledTasksText(bandId); }
          catch (e) { out = 'Could not list tasks: ' + e.message; }
        } else if (tu.name === 'cancel_scheduled_task') {
          try { out = await cancelScheduledTask(ctx, inp); }
          catch (e) { out = 'Could not cancel: ' + e.message; }
        } else {
          out = applyManagerTool(tu.name, inp, ctx, show.id, work, ops);
        }
        actions.push(tu.name);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
      }
      apiMsgs.push({ role: 'user', content: results });
      continue;
    }
    reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    break;
  }
  return { reply, ops, actions };
}

exports.managerChat = onCall({ secrets: [ANTHROPIC_KEY, TELEGRAM_TOKEN] }, async (req) => {
  const email = req.auth && req.auth.token && req.auth.token.email;
  if (!email) throw new HttpsError('unauthenticated', 'Please sign in first.');
  const { bandId, showId, message } = req.data || {};
  if (!bandId) throw new HttpsError('invalid-argument', 'Missing band.');
  const boardRef = db.collection('boards').doc(bandId);
  const boardSnap = await boardRef.get();
  if (!boardSnap.exists) throw new HttpsError('not-found', 'No such band.');
  const board = boardSnap.data();
  const allow = [ADMIN_EMAIL, ...((board.managerChatAllow) || [])].map(x => (x || '').toLowerCase());
  if (!allow.includes(email.toLowerCase())) throw new HttpsError('permission-denied', 'You are not allowed to chat with the manager.');

  const chatRef = db.collection('managerChat').doc(bandId);
  if (req.data && req.data.clear) { await chatRef.set({ messages: [] }, { merge: true }); return { messages: [] }; }
  const chatSnap = await chatRef.get();
  let messages = (chatSnap.exists && Array.isArray(chatSnap.data().messages)) ? chatSnap.data().messages : [];
  if (!message || !String(message).trim()) return { messages };   // history load

  const show = (board.shows || []).find(s => s.id === showId) || (board.shows || [])[0];
  if (!show) throw new HttpsError('failed-precondition', 'No show to discuss.');

  const nowMs = Date.now();
  const tasks = await loadPendingTasks(bandId);
  const ctx = buildManagerContextNode(board, show, { nowMs, tasks });
  const apiMsgs = messages.slice(-20).map(m => ({ role: m.role, content: m.text }));
  apiMsgs.push({ role: 'user', content: String(message) });

  const key = ANTHROPIC_KEY.value();
  let reply = '', actions = [], ops = [];
  try {
    const r = await runManagerLoop({ bandId, board, show, ctx, apiMsgs, email, key });
    reply = r.reply; actions = r.actions; ops = r.ops;
  } catch (e) {
    logger.error('managerChat LLM error: ' + e.message);
    if (/anthropic 401/.test(e.message || '')) throw new HttpsError('failed-precondition', 'The manager\'s Anthropic API key is invalid — reset the ANTHROPIC_KEY secret and redeploy.');
    if (/anthropic 429/.test(e.message || '')) throw new HttpsError('resource-exhausted', 'The manager is rate-limited right now — try again in a moment.');
    throw new HttpsError('internal', 'The manager could not respond right now.');
  }

  const now = Date.now();
  messages = [...messages, { role: 'user', text: String(message), ts: now }, { role: 'assistant', text: reply || '(no reply)', ts: now }].slice(-40);
  await chatRef.set({ messages }, { merge: true });

  if (ops.length) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(boardRef);
      if (!snap.exists) return;
      const b = snap.data();
      ops.forEach(op => applyOpToBoard(op, b));
      b._updatedAt = new Date().toISOString();
      tx.set(boardRef, b);
    });
  }
  return { reply, messages, actions };
});

/* ==================== SCHEDULED MANAGER TASKS ====================
   Runs every 5 minutes. Any pending task whose time has arrived is executed by
   re-invoking the manager loop with the stored instruction, so the manager acts
   autonomously (sends notifications/Telegram, runs polls, updates the board) even
   when nobody has the app open. Each run posts a note into the chat so the owner
   sees what happened, and the task is marked done. */
const SCHED_PREFIX =
  '[AUTONOMOUS SCHEDULED RUN — this fired at its scheduled time; nobody is watching the chat. ' +
  'Carry out the instruction NOW using your tools (send_notification / send_telegram / ask_members / board tools as appropriate) — actually do it, do not just describe it. ' +
  'End with a one-line summary of what you did.]\n\nInstruction: ';
// Appended when the task is recurring, so the model doesn't ALSO schedule the next
// run (the scheduler re-arms it automatically after this run).
const SCHED_RECUR_NOTE = '\n\n[This is a recurring task; its next run is re-armed automatically. Do NOT call schedule_task for it.]';

exports.managerTasks = onSchedule(
  { schedule: 'every 5 minutes', timeZone: TZ, secrets: [ANTHROPIC_KEY, TELEGRAM_TOKEN] },
  async () => {
    const key = ANTHROPIC_KEY.value();
    const now = Date.now();
    const boards = await ownerBoards();
    for (const board of boards) {
      const due = (await loadPendingTasks(board.id)).filter(t => (t.runAtMs || 0) <= now);
      if (!due.length) continue;
      const boardRef = db.collection('boards').doc(board.id);
      for (const task of due) {
        const taskRef = tasksCol().doc(task.id);
        // Claim atomically so an overlapping run can't execute the same task twice.
        const claimed = await db.runTransaction(async (tx) => {
          const s = await tx.get(taskRef);
          if (!s.exists || s.data().status !== 'pending') return false;
          tx.set(taskRef, { status: 'running', startedAt: Date.now() }, { merge: true });
          return true;
        });
        if (!claimed) continue;
        try {
          const fresh = (await boardRef.get()).data() || board;
          const show = (fresh.shows || []).find(s => s.id === task.showId) || (fresh.shows || [])[0];
          if (!show) { await taskRef.set({ status: 'done', ranAt: Date.now(), result: 'no show' }, { merge: true }); continue; }
          const ctx = buildManagerContextNode(fresh, show, { nowMs: Date.now(), tasks: await loadPendingTasks(board.id) });
          const recurring = !!normalizeRepeat(task.repeat);
          const apiMsgs = [{ role: 'user', content: SCHED_PREFIX + (task.instruction || '') + (recurring ? SCHED_RECUR_NOTE : '') }];
          const { reply, ops, actions } = await runManagerLoop({ bandId: board.id, board: fresh, show, ctx, apiMsgs, email: ADMIN_EMAIL, key });
          if (ops.length) {
            await db.runTransaction(async (tx) => {
              const snap = await tx.get(boardRef);
              if (!snap.exists) return;
              const b = snap.data();
              ops.forEach(op => applyOpToBoard(op, b));
              b._updatedAt = new Date().toISOString();
              tx.set(boardRef, b);
            });
          }
          // Leave a trace in the chat so the owner sees what the manager did.
          try {
            const chatRef = db.collection('managerChat').doc(board.id);
            const cs = await chatRef.get();
            const msgs = (cs.exists && Array.isArray(cs.data().messages)) ? cs.data().messages : [];
            msgs.push({ role: 'assistant', text: '⏰ *Scheduled task ran* — ' + (task.title || task.instruction || '') + '\n\n' + (reply || '(done)'), ts: Date.now() });
            await chatRef.set({ messages: msgs.slice(-40) }, { merge: true });
          } catch (e) { logger.error('task chat note failed: ' + e.message); }
          // Recurrence is guaranteed here, in code — not left to the model. Re-arm
          // the SAME doc to its next future occurrence (skipping any missed ones).
          const nextMs = recurring ? nextFutureRunMs(task.runAtMs, task.repeat) : null;
          if (nextMs != null) {
            await taskRef.set({ status: 'pending', runAtMs: nextMs, startedAt: null, lastRanAt: Date.now(), lastResult: (reply || '').slice(0, 500), runs: (task.runs || 0) + 1 }, { merge: true });
          } else {
            await taskRef.set({ status: 'done', ranAt: Date.now(), result: (reply || '').slice(0, 500), actions, runs: (task.runs || 0) + 1 }, { merge: true });
          }
        } catch (e) {
          logger.error('managerTask ' + task.id + ' failed: ' + e.message);
          const label = (task.title || task.instruction || 'A scheduled task').slice(0, 90);
          const recurs = !!normalizeRepeat(task.repeat);
          // Don't let a failure be silent — push to the owner and leave a chat note.
          try { await pushToOwner('Scheduled task failed', label + ' — ' + (e.message || 'error').slice(0, 120)); } catch (_) { }
          try {
            const chatRef = db.collection('managerChat').doc(board.id);
            const cs = await chatRef.get();
            const msgs = (cs.exists && Array.isArray(cs.data().messages)) ? cs.data().messages : [];
            msgs.push({ role: 'assistant', text: '⚠️ *Scheduled task failed* — ' + label + '\n\n' + (e.message || 'error') + (recurs ? '\n\n(It stays scheduled and will try again next time.)' : '') , ts: Date.now() });
            await chatRef.set({ messages: msgs.slice(-40) }, { merge: true });
          } catch (_) { }
          // Even on failure, re-arm a recurring task so one bad run doesn't kill the series.
          const nextMs = recurs ? nextFutureRunMs(task.runAtMs, task.repeat) : null;
          if (nextMs != null) await taskRef.set({ status: 'pending', runAtMs: nextMs, startedAt: null, lastError: (e.message || '').slice(0, 300), lastErrorAt: Date.now() }, { merge: true });
          else await taskRef.set({ status: 'error', ranAt: Date.now(), error: (e.message || '').slice(0, 300) }, { merge: true });
        }
      }
    }
  }
);

/* ============================ TELEGRAM WEBHOOK ============================
   Telegram POSTs bot updates here. On "/start <code>" it links the sender's
   chat to the Soundcheck user the code was generated for (telegramLinks/{code}
   → telegramChats/{bandId}.users[]). Other messages get a gentle hint (no
   two-way chat yet). Verified via the secret_token set at registration. */
exports.telegramWebhook = onRequest({ secrets: [TELEGRAM_TOKEN] }, async (req, res) => {
  try {
    const token = TELEGRAM_TOKEN.value();
    if (req.get('X-Telegram-Bot-Api-Secret-Token') !== tgWebhookSecret(token)) { res.status(403).send('no'); return; }
    const update = req.body || {};
    // Poll button taps
    const cq = update.callback_query;
    if (cq) {
      const mm = (cq.data || '').match(/^poll:([^:]+):(\d+)$/);
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      if (mm && chatId != null) {
        const pollId = mm[1], opt = parseInt(mm[2], 10);
        const pref = db.collection('telegramPolls').doc(pollId);
        let label = '', question = '';
        await db.runTransaction(async (tx) => {
          const s = await tx.get(pref); if (!s.exists) return;
          const p = s.data(); question = p.question || '';
          label = (p.options || [])[opt]; if (label == null) return;
          const responses = Array.isArray(p.responses) ? p.responses : [];
          const rec = (p.recipients || []).find(r => String(r.chatId) === String(chatId)) || {};
          const email = rec.email || ('tg:' + (cq.from && cq.from.id));
          const entry = { email, chatId, firstName: (cq.from && cq.from.first_name) || rec.firstName || '', option: opt, optionLabel: label, ts: Date.now() };
          const idx = responses.findIndex(r => String(r.chatId) === String(chatId) || r.email === email);
          if (idx >= 0) responses[idx] = entry; else responses.push(entry);
          p.responses = responses; tx.set(pref, p);
        });
        await tgApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: label ? ('Got it: ' + label) : 'This poll has closed.' }).catch(() => {});
        if (label) { try { await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: '❓ ' + question + '\n\n✅ You answered: ' + label }); } catch (_) {} }
      } else {
        await tgApi(token, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      }
      res.status(200).send('ok'); return;
    }
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) { res.status(200).send('ok'); return; }
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const m = text.match(/^\/start\s+(\S+)/);
    if (m) {
      const code = m[1];
      const linkRef = db.collection('telegramLinks').doc(code);
      const linkSnap = await linkRef.get();
      if (!linkSnap.exists) { await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'That link is invalid or expired. Generate a new one in the Soundcheck app (Admin → Connect Telegram).' }); res.status(200).send('ok'); return; }
      const { bandId, email } = linkSnap.data();
      const ref = db.collection('telegramChats').doc(bandId);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const users = (s.exists && Array.isArray(s.data().users)) ? s.data().users : [];
        const entry = { email, chatId, username: (msg.from && msg.from.username) || '', firstName: (msg.from && msg.from.first_name) || '', ts: Date.now() };
        const idx = users.findIndex(u => u.email === email);
        if (idx >= 0) users[idx] = entry; else users.push(entry);
        tx.set(ref, { users }, { merge: true });
      });
      await linkRef.delete().catch(() => {});
      await tgApi(token, 'sendMessage', { chat_id: chatId, text: '✅ Linked to Soundcheck. The band manager can now message you here.' });
      res.status(200).send('ok'); return;
    }
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'Hi! To link your account, open Soundcheck → Admin → Connect Telegram and tap the link there.' });
    res.status(200).send('ok');
  } catch (e) { logger.error('telegramWebhook: ' + e.message); res.status(200).send('ok'); }
});
