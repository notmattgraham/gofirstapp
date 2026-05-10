// Deadline-nudge scheduler. Runs every 5 minutes and, for each user
// with at least one push subscription, fires a push when their
// next-lockTime sits 2 hours or 1 hour out — the exact text depends on
// what's still in front of them:
//
//   today-incomplete   → "X tasks left. <2h | 1h> until lock."
//   planning-tomorrow  → "Tomorrow needs a plan. <2h | 1h> until lock."
//
// Other modes (planning-today / tomorrow-committed) get nothing —
// there's nothing time-pressuring to act on.
//
// Dedup: NudgeLog rows uniquely keyed on (userId, kind, date) — a
// successful insert means "we sent it"; a duplicate-key error means
// "already sent for this date." The 5-min tick can fall inside the
// firing window multiple times without re-sending.

const prisma = require('./db');
const { msUntilNextLock, userToday } = require('./time');
const { computeMode } = require('./routes/days');
const pushModule = require('./routes/push');

// Window half-widths around the 2h / 1h marks. The cron tick is 5 min,
// so a 15-min half-width gives roughly 3 ticks of overlap to cover
// missed intervals (Railway sleep, restart, etc.). NudgeLog dedups.
const NUDGE_KINDS = [
  { kind: '2h', targetMs: 2 * 60 * 60 * 1000, halfWindowMs: 15 * 60 * 1000 },
  { kind: '1h', targetMs: 1 * 60 * 60 * 1000, halfWindowMs: 15 * 60 * 1000 },
];

const TICK_MS = 5 * 60 * 1000;

function inWindow(actualMs, target, half) {
  return actualMs >= (target - half) && actualMs <= (target + half);
}

async function tick() {
  if (!pushModule.isConfigured()) return;
  // Only consider users who have at least one push subscription —
  // anyone else can't receive a push anyway.
  const candidates = await prisma.user.findMany({
    where: { pushSubscriptions: { some: {} } },
    select: {
      id: true, email: true, name: true, timezone: true,
      lockTime: true, notifySystem: true,
    },
  });
  for (const u of candidates) {
    if (u.notifySystem === false) continue; // user opted out of system pushes
    let stateInfo;
    try { stateInfo = await computeMode(u); }
    catch (e) { console.warn('[nudges] computeMode failed for', u.id, e.message); continue; }
    // Only nudge in the two modes that actually have pending work.
    const isIncomplete = stateInfo.mode === 'today-incomplete';
    const isPlanning   = stateInfo.mode === 'planning-tomorrow';
    if (!isIncomplete && !isPlanning) continue;

    const ms = msUntilNextLock(u);
    for (const { kind, targetMs, halfWindowMs } of NUDGE_KINDS) {
      if (!inWindow(ms, targetMs, halfWindowMs)) continue;
      // Dedup key uses today's date — the date this lockTime crossing
      // belongs to. Once today rolls over (after lockTime) the user's
      // userToday changes and a fresh date key is in play.
      const dateKey = userToday(u);
      try {
        await prisma.nudgeLog.create({
          data: { userId: u.id, kind, date: dateKey },
        });
      } catch (err) {
        // Duplicate-key (P2002): already sent. Anything else: log + skip.
        if (err && err.code === 'P2002') continue;
        console.warn('[nudges] log insert failed', err.message);
        continue;
      }
      await sendNudge(u, kind, stateInfo).catch((e) =>
        console.warn('[nudges] send failed', u.id, kind, e.message));
    }
  }
}

async function sendNudge(user, kind, stateInfo) {
  const hours = kind === '2h' ? '2 hours' : '1 hour';
  const isIncomplete = stateInfo.mode === 'today-incomplete';
  const remaining = Math.max(0, stateInfo.todayCounts.total - stateInfo.todayCounts.done);
  const taskWord = (n) => `${n} task${n === 1 ? '' : 's'}`;
  const payload = isIncomplete
    ? {
        title: `${hours} left to finish today`,
        body:  `${taskWord(remaining)} still open. Get them done before the day ends.`,
        url:   '/',
        tag:   `deadline-${kind}`,
      }
    : {
        title: `${hours} left to plan tomorrow`,
        body:  `Lock in tomorrow's list before today ends.`,
        url:   '/',
        tag:   `deadline-${kind}`,
      };
  await pushModule.sendPushToUser(user.id, payload);
}

let timer = null;
function start() {
  if (timer) return;
  // Fire one immediate-ish tick on boot (small delay so DB is ready),
  // then every 5 minutes thereafter.
  setTimeout(() => tick().catch((e) => console.warn('[nudges] tick error', e.message)), 30_000);
  timer = setInterval(() => tick().catch((e) => console.warn('[nudges] tick error', e.message)), TICK_MS);
  console.log(`[nudges] scheduler started (every ${TICK_MS / 60_000} min)`);
}

module.exports = { start, tick };
