// Inactivity-reengagement scheduler. Runs hourly and, for every user
// who hasn't been active in 24+ hours, sends a single push reminding
// them to take action. Re-fires once per day (~22h floor between
// sends) while the user remains dormant — coming back resets the
// clock automatically because trackLastSeen updates lastSeenAt on the
// next authenticated API hit.
//
// Eligibility:
//   - lastSeenAt is set AND is more than 24h ago
//   - lastReengagementPushAt is null OR more than 22h ago
//   - User has at least one push subscription
//   - User has notifySystem != false (this push is bucketed as system,
//     not a message — users who opt out of system pushes shouldn't be
//     pulled back in by one)
//
// Capped per tick so a long dormant tail doesn't blow up the loop.

const prisma = require('./db');
const pushModule = require('./routes/push');

const INACTIVITY_MS = 24 * 60 * 60 * 1000;        // 24 hours
const RESEND_FLOOR_MS = 22 * 60 * 60 * 1000;      // ~daily, with slack
const TICK_MS = 60 * 60 * 1000;                   // 1 hour
const PER_TICK_LIMIT = 500;                       // safety valve

const PUSH_TITLE = 'Your goals are waiting.';
const PUSH_BODY  = 'Tap to plan today and take a step forward.';

async function tick() {
  if (!pushModule.isConfigured()) return;
  const now = Date.now();
  const inactiveCutoff = new Date(now - INACTIVITY_MS);
  const resendCutoff   = new Date(now - RESEND_FLOOR_MS);

  let candidates;
  try {
    candidates = await prisma.user.findMany({
      where: {
        lastSeenAt: { not: null, lt: inactiveCutoff },
        notifySystem: { not: false },
        // Either never reengaged, or last reengagement was >= 22h ago.
        OR: [
          { lastReengagementPushAt: null },
          { lastReengagementPushAt: { lt: resendCutoff } },
        ],
        // Skip users with no push subscriptions — nothing to send to.
        pushSubscriptions: { some: {} },
      },
      select: { id: true, name: true },
      take: PER_TICK_LIMIT,
    });
  } catch (e) {
    console.warn('[inactivity] candidate query failed:', e.message);
    return;
  }

  if (!candidates.length) return;

  for (const u of candidates) {
    try {
      // Stamp BEFORE the push send so concurrent ticks (or a long
      // sendPushToUser) don't double-fire. Idempotent if the push
      // itself fails — they'll just have to wait until tomorrow's
      // tick for another shot.
      await prisma.user.update({
        where: { id: u.id },
        data: { lastReengagementPushAt: new Date() },
      });
      await pushModule.sendPushToUser(u.id, {
        title: PUSH_TITLE,
        body:  PUSH_BODY,
        url:   '/',
        tag:   'reengagement',
      });
    } catch (e) {
      console.warn('[inactivity] send failed', u.id, e.message);
    }
  }
  console.log(`[inactivity] reengagement pushes sent: ${candidates.length}`);
}

let timer = null;
function start() {
  if (timer) return;
  // First tick on a short delay so the server is fully up.
  setTimeout(() => tick().catch((e) => console.warn('[inactivity] tick error', e.message)), 60_000);
  timer = setInterval(() => tick().catch((e) => console.warn('[inactivity] tick error', e.message)), TICK_MS);
  console.log(`[inactivity] scheduler started (every ${TICK_MS / 60_000} min, inactivity threshold ${INACTIVITY_MS / 3_600_000}h, resend floor ${RESEND_FLOOR_MS / 3_600_000}h)`);
}

module.exports = { start, tick };
