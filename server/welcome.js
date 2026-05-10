// Welcome-DM scheduler. Runs every minute and, for every user whose
// account was created 15+ minutes ago AND whose `welcomeDmSentAt`
// is still null, sends an auto-DM from the admin thanking them for
// downloading. One-shot per user — the `welcomeDmSentAt` column
// makes the trigger idempotent forever after.
//
// We deliberately do NOT gate on `lastSeenAt` — the DM goes out 15
// minutes after `createdAt` regardless of how active the user has
// been in between. If they happen to be offline they pick the
// message up next time they open the app; if they're online they
// see it land via WS + push.
//
// The DM is stamped with `hiddenFromAdminAt = now` so it does NOT
// appear in the admin's inbox listing — the thread only surfaces if
// the recipient writes back.
//
// On first boot we mark every EXISTING user as already-welcomed (via
// raw SQL — the column exists in DB after `db push`, regardless of
// whether the Prisma client has been regenerated yet) so flipping
// this feature on doesn't flood every account with a welcome DM at
// once. Only signups created AFTER the boot are eligible.

const prisma = require('./db');
const pushModule = require('./routes/push');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();
const WELCOME_BODY = 'Thank you for downloading the GOFIRST app. If there\'s anything I can do to improve your experience with the app, please let me know. - Matt';
// Wait this long after createdAt before sending the welcome DM.
const SIGNUP_AGE_THRESHOLD_MS = 15 * 60 * 1000;
const TICK_MS = 60 * 1000;

async function findAdmin() {
  return await prisma.user.findFirst({ where: { isAdmin: true } })
    || await prisma.user.findFirst({ where: { email: { equals: ADMIN_EMAIL, mode: 'insensitive' } } });
}

let _bootDone = false;
async function ensureBoot() {
  if (_bootDone) return;
  _bootDone = true;
  // One-shot backfill: anyone created BEFORE this feature shipped
  // gets a non-null welcomeDmSentAt so they're never eligible. We
  // use a 1-minute fudge so a user signing up in the same second
  // the server starts isn't accidentally skipped.
  try {
    const result = await prisma.$executeRaw`
      UPDATE "User"
      SET "welcomeDmSentAt" = NOW()
      WHERE "welcomeDmSentAt" IS NULL
        AND "createdAt" < NOW() - INTERVAL '1 minute'
    `;
    if (result > 0) console.log(`[welcome] backfilled ${result} pre-existing users as already-welcomed`);
  } catch (e) {
    console.warn('[welcome] backfill failed:', e.message);
  }
}

async function tick() {
  await ensureBoot();
  const admin = await findAdmin();
  if (!admin) return; // No admin user yet — try again next tick.

  // Anyone created 15+ minutes ago who hasn't been welcomed yet.
  // The welcomeDmSentAt column makes this idempotent — once stamped,
  // a user never matches this query again.
  const cutoff = new Date(Date.now() - SIGNUP_AGE_THRESHOLD_MS);
  let eligible;
  try {
    eligible = await prisma.user.findMany({
      where: {
        welcomeDmSentAt: null,
        createdAt: { lte: cutoff },
        id: { not: admin.id },
      },
      select: {
        id: true, name: true,
        notifyMessages: true, notifySystem: true,
      },
    });
  } catch (e) {
    console.warn('[welcome] candidate query failed:', e.message);
    return;
  }

  for (const user of eligible) {
    try {
      const message = await prisma.message.create({
        data: {
          fromUserId: admin.id,
          toUserId: user.id,
          content: WELCOME_BODY,
          hiddenFromAdminAt: new Date(),
        },
        select: { id: true, fromUserId: true, toUserId: true, content: true, attachment: true, readAt: true, createdAt: true },
      });
      // Stamp welcomeDmSentAt so we don't double-send on the next tick.
      await prisma.user.update({
        where: { id: user.id },
        data: { welcomeDmSentAt: new Date() },
      });

      // Real-time WS to the recipient if they're connected.
      if (typeof global.wsBroadcast === 'function') {
        global.wsBroadcast(user.id, { type: 'message', message });
      }

      // OS push (fire-and-forget; pushForMessage no-ops if push isn't
      // configured or the user has notifyMessages off).
      try {
        await pushModule.pushForMessage({
          senderUser: { id: admin.id, name: admin.name || 'Matt' },
          recipientUser: {
            id: user.id,
            notifyMessages: user.notifyMessages,
            notifySystem: user.notifySystem,
          },
          content: WELCOME_BODY,
          hasAttachment: false,
          isSystem: false,
        });
      } catch (e) {
        console.warn('[welcome/push] failed', user.id, e.message);
      }

      console.log(`[welcome] sent to ${user.id}`);
    } catch (err) {
      console.warn('[welcome] send failed for', user.id, err.message);
    }
  }
}

let timer = null;
function start() {
  if (timer) return;
  // First tick on a short delay so the DB is reachable and the
  // server is fully booted before we hit it.
  setTimeout(() => tick().catch((e) => console.warn('[welcome] tick error', e.message)), 45_000);
  timer = setInterval(() => tick().catch((e) => console.warn('[welcome] tick error', e.message)), TICK_MS);
  console.log(`[welcome] scheduler started (every ${TICK_MS / 60_000} min, signup-age threshold ${SIGNUP_AGE_THRESHOLD_MS / 60_000} min)`);
}

module.exports = { start, tick };
