/**
 * Soundcheck — always-on AI band manager (Firebase Cloud Functions, 2nd gen).
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
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const ANTHROPIC_KEY = defineSecret('ANTHROPIC_KEY');

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
  if (!tokens.length) { logger.warn('no notify tokens registered — nothing to push'); return; }
  const resp = await admin.messaging().sendEachForMulticast({
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
        const brief = [
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
      const brief = [
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
