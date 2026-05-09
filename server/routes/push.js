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
  // Tell APNs / FCM to prioritise delivery and to drop the message if
  // the device is offline for more than 4 hours. Without these headers
  // web-push defaults to "normal" urgency and no TTL, which lets the
  // push provider batch — observed to add 1–2 minute delays on iOS.
  const sendOptions = {
    urgency: 'high',
    TTL: 4 * 60 * 60, // seconds
  };
  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
        sendOptions,
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

// ─── Active-thread tracker ─────────────────────────────────────────────
//
// Suppression policy for DM pushes: if the recipient currently has the
// sender's DM thread open (any device), we skip the push. The map below
// is updated by the WebSocket 'viewing' message handler in server/index.js.
//
//   key = recipient userId
//   val = Set of peerIds the recipient is currently viewing (one per WS
//         connection — multiple devices/tabs can each have their own peer
//         open). Set is removed entirely when empty so a stale entry
//         never accumulates.
const _viewing = new Map();

function setViewingPeer(userId, peerId, prevPeerId) {
  if (prevPeerId) {
    const set = _viewing.get(userId);
    if (set) {
      set.delete(prevPeerId);
      if (set.size === 0) _viewing.delete(userId);
    }
  }
  if (peerId) {
    let set = _viewing.get(userId);
    if (!set) { set = new Set(); _viewing.set(userId, set); }
    set.add(peerId);
  }
}

function clearViewingPeer(userId, peerId) {
  if (!peerId) return;
  const set = _viewing.get(userId);
  if (!set) return;
  set.delete(peerId);
  if (set.size === 0) _viewing.delete(userId);
}

function isViewingPeer(userId, peerId) {
  const set = _viewing.get(userId);
  return !!(set && set.has(peerId));
}

// ─── Event-driven push helpers ─────────────────────────────────────────
//
// Each helper:
//   - reads the recipient's per-event pref (defaulting on),
//   - skips if not configured,
//   - returns silently on any error so a failed push never trips the
//     calling endpoint.

function _truncate(s, max) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Inbound DM (friend↔friend, coach↔client, broadcast reply landing on
// admin). `senderUser` is the message author; `recipientUser` carries
// the per-event pref. `isSystem` true → uses notifySystem instead of
// notifyMessages (admin in-app broadcast pushes route here).
async function pushForMessage({ senderUser, recipientUser, content, hasAttachment, isSystem = false }) {
  if (!configured) return;
  if (!recipientUser) return;
  const prefKey = isSystem ? 'notifySystem' : 'notifyMessages';
  if (recipientUser[prefKey] === false) return;
  // Suppress when the recipient is currently looking at this exact thread —
  // they already see the WS-delivered message land in real time.
  if (isViewingPeer(recipientUser.id, senderUser.id)) return;
  const senderName = (senderUser.name || '').trim() || 'GoFirst';
  let body;
  if (content && content.trim()) body = _truncate(content, 80);
  else if (hasAttachment)        body = 'Sent a photo.';
  else                           body = 'Sent a message.';
  return sendPushToUser(recipientUser.id, {
    title: senderName,
    body,
    url: `/?dm=${senderUser.id}`,
    tag: `dm:${senderUser.id}`,
  });
}

// Friend request received — fires for the target of a new request.
async function pushForFriendRequest({ requesterUser, targetUser }) {
  if (!configured) return;
  if (!targetUser || targetUser.notifyFriends === false) return;
  const requesterName = (requesterUser.name || '').trim() || 'Someone';
  return sendPushToUser(targetUser.id, {
    title: 'New friend request',
    body: `${requesterName} wants to add you as a friend.`,
    url: '/?social=requests',
    tag: 'friend-request',
  });
}

// Friend request accepted — fires for the original requester.
async function pushForFriendAccepted({ accepterUser, requesterUser }) {
  if (!configured) return;
  if (!requesterUser || requesterUser.notifyFriends === false) return;
  const accepterName = (accepterUser.name || '').trim() || 'Someone';
  return sendPushToUser(requesterUser.id, {
    title: `${accepterName} accepted your friend request`,
    body: 'You\'re now friends. Tap to send a message.',
    url: `/?dm=${accepterUser.id}`,
    tag: 'friend-accepted',
  });
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.sendPushToUsers = sendPushToUsers;
module.exports.isConfigured = () => configured;
module.exports.pushForMessage = pushForMessage;
module.exports.pushForFriendRequest = pushForFriendRequest;
module.exports.pushForFriendAccepted = pushForFriendAccepted;
module.exports.setViewingPeer = setViewingPeer;
module.exports.clearViewingPeer = clearViewingPeer;
module.exports.isViewingPeer = isViewingPeer;
