// Web push notifications. Phase 1 surface: a public-key endpoint the
// client uses to subscribe, plus subscribe/unsubscribe writes against
// the PushSubscription table. The actual send is exposed as a helper
// (sendPushToUser / sendPushToUsers) so admin broadcast and future
// event-driven hooks can share it.
//
// VAPID:
//   - VAPID_PUBLIC_KEY  — defaults to the project's public key; safe in code.
//   - VAPID_PRIVATE_KEY — MUST come from env. Without it, push is silently
//                         disabled and every send is a no-op (logged once).
//   - VAPID_CONTACT     — mailto: or https: URL for push provider abuse contact.

const express = require('express');
const webpush = require('web-push');
const prisma = require('../db');
const { requireAuth } = require('../middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY
  || 'BHthNObIObekn_2sjPnlhe2I4901AGH54Xf4o7W5RBFHNz6A7TcILpzEFaiEiuGpL3QEFVuwk_lQ4_6Kr6F6FUw';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:help@gofirstbrand.com';

let configured = false;
if (VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
    configured = true;
  } catch (e) {
    console.error('[push] VAPID setup failed:', e.message);
  }
} else {
  console.warn('[push] VAPID_PRIVATE_KEY missing — push is disabled. Set the env var to enable.');
}

// GET /api/push/vapid-public-key — used by the SPA to subscribe via
// PushManager.subscribe({ applicationServerKey }).
router.get('/vapid-public-key', (_req, res) => {
  res.json({ key: VAPID_PUBLIC, enabled: configured });
});

// POST /api/push/subscribe — body: PushSubscriptionJSON ({ endpoint, keys: { p256dh, auth } })
// Optional: { label } (e.g. "iPhone Safari"). Idempotent on endpoint —
// resubscribing the same device just refreshes the keys + label.
router.post('/subscribe', requireAuth, wrap(async (req, res) => {
  const sub = req.body || {};
  const endpoint = sub.endpoint;
  const p256dh   = sub.keys && sub.keys.p256dh;
  const auth     = sub.keys && sub.keys.auth;
  const label    = typeof sub.label === 'string' ? sub.label.slice(0, 120) : null;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'missing_subscription_fields' });
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: req.user.id, p256dh, auth, label, lastUsedAt: new Date() },
    create: { userId: req.user.id, endpoint, p256dh, auth, label },
  });
  res.json({ ok: true });
}));

// POST /api/push/unsubscribe — body: { endpoint }. Removes that one
// device for the current user. Used when the SPA unsubscribes via
// pushManager.subscription.unsubscribe().
router.post('/unsubscribe', requireAuth, wrap(async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint_required' });
  await prisma.pushSubscription.deleteMany({
    where: { endpoint, userId: req.user.id },
  });
  res.json({ ok: true });
}));

// GET /api/push/status — does this user currently have any active
// subscriptions? Used by the Profile UI to show the toggle as on/off.
router.get('/status', requireAuth, wrap(async (req, res) => {
  const count = await prisma.pushSubscription.count({ where: { userId: req.user.id } });
  res.json({ enabled: configured, subscribed: count > 0, count });
}));

// ─── Send helpers ──────────────────────────────────────────────────────

// Send a notification to one user across every subscription they have.
// Returns { sent, failed, removed } counts. Subscriptions that 404/410
// ("subscription is gone") are deleted so we don't keep retrying them.
async function sendPushToUser(userId, payload) {
  if (!configured) return { sent: 0, failed: 0, removed: 0, skipped: true };
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  return _fanOut(subs, payload);
}

// Send to many users at once. Used by the admin broadcast endpoint.
async function sendPushToUsers(userIds, payload) {
  if (!configured) return { sent: 0, failed: 0, removed: 0, skipped: true };
  if (!userIds.length) return { sent: 0, failed: 0, removed: 0, skipped: false };
  const subs = await prisma.pushSubscription.findMany({
    where: { userId: { in: userIds } },
  });
  return _fanOut(subs, payload);
}

async function _fanOut(subs, payload) {
  let sent = 0, failed = 0, removed = 0;
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
      );
      sent++;
      // Best-effort: don't await — keeps the per-push round trip lean.
      prisma.pushSubscription.update({
        where: { id: s.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // Subscription is gone; clean it up so we don't keep trying.
        try {
          await prisma.pushSubscription.delete({ where: { id: s.id } });
          removed++;
        } catch {}
      } else {
        failed++;
        console.warn('[push] send failed:', code, err && err.body);
      }
    }
  }));
  return { sent, failed, removed, skipped: false };
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.sendPushToUsers = sendPushToUsers;
module.exports.isConfigured = () => configured;
