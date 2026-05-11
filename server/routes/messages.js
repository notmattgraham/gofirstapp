// Coaching chat — messages between coaching clients and the coach.
// All endpoints require auth. Clients can only message the coach; the coach
// can message any client. Message history is scoped to the pair.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const pushModule = require('./push');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();
const MAX_MESSAGE_LENGTH = 4000;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
router.use(requireAuth);

// Helper: is the given user the coach? Coach status is purely DB-driven —
// flip via the role picker in /dev. No more email fallback.
function isCoach(user) {
  return !!user.isCoach;
}

// Helper: is the given user the app-wide admin? DB flag wins; env-email
// fallback bootstraps before anyone is flagged. Admin can DM any user
// without a friend relationship — used both for outgoing 1:1 follow-ups
// and for receiving replies to broadcasts.
function isAdmin(user) {
  return !!user.isAdmin || (user.email || '').toLowerCase() === ADMIN_EMAIL;
}

// Helper: fetch the coach user record (the single user with isCoach=true).
// Returns null if no one has been promoted in /dev yet — coaching-client
// endpoints respond with 503 coach_not_found in that case.
async function fetchCoach() {
  return prisma.user.findFirst({ where: { isCoach: true } });
}

// GET /api/messages/admin-threads — admin-only inbox listing.
// One row per peer who has at least one message between us with
// hiddenFromAdminAt = null. That's exactly the set of users who have
// either replied to a broadcast or sent the admin a fresh message after
// the admin last "deleted" the conversation.
router.get('/admin-threads', wrap(async (req, res) => {
  const me = req.user;
  if (!isAdmin(me)) return res.status(403).json({ error: 'admin_only' });

  // Pull every visible (non-hidden) message touching the admin, in a single
  // query, then bucket in JS. Cap at a reasonable number — even the most
  // chatty admin won't have more than a few thousand active threads.
  const visible = await prisma.message.findMany({
    where: {
      hiddenFromAdminAt: null,
      OR: [
        { fromUserId: me.id },
        { toUserId: me.id },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 5000,
    select: {
      id: true, fromUserId: true, toUserId: true,
      content: true, attachment: true, readAt: true, createdAt: true,
    },
  });

  // Bucket into peer → latest message + unread count.
  const byPeer = new Map();
  for (const m of visible) {
    const peerId = m.fromUserId === me.id ? m.toUserId : m.fromUserId;
    let bucket = byPeer.get(peerId);
    if (!bucket) {
      bucket = { latest: null, unread: 0 };
      byPeer.set(peerId, bucket);
    }
    if (!bucket.latest || new Date(m.createdAt) > new Date(bucket.latest.createdAt)) {
      bucket.latest = m;
    }
    if (m.fromUserId === peerId && !m.readAt) bucket.unread += 1;
  }

  if (byPeer.size === 0) return res.json({ threads: [] });

  // Hydrate peer profile fields in one query.
  const peers = await prisma.user.findMany({
    where: { id: { in: Array.from(byPeer.keys()) } },
    select: { id: true, name: true, picture: true, lastSeenAt: true },
  });

  const threads = peers.map((p) => {
    const b = byPeer.get(p.id);
    const fromMe = b.latest.fromUserId === me.id;
    return {
      // Same shape as /api/friends/threads so the SPA inbox can merge both
      // lists into a single `inbox-thread-list`. `kind` distinguishes admin
      // threads from friend threads at render time (no glance row, shows a
      // delete-conversation control, etc).
      user: { id: p.id, name: p.name, picture: p.picture, lastSeenAt: p.lastSeenAt },
      kind: 'admin',
      latest: {
        id: b.latest.id,
        content: b.latest.content,
        createdAt: b.latest.createdAt,
        readAt: b.latest.readAt,
        fromMe,
      },
      unread: b.unread,
    };
  });

  threads.sort((a, b) => new Date(b.latest.createdAt) - new Date(a.latest.createdAt));
  res.json({ threads });
}));

// GET /api/messages/admin-pin — for non-admin users.
// Returns the admin user record + latest message preview + unread count
// IF this user has at least one message with the admin (in either
// direction). Mirrors the "pinned coach" entry that coaching clients see.
// When the caller IS the admin, or has no messages with the admin, returns
// { admin: null } so the SPA can skip rendering the pinned row.
router.get('/admin-pin', wrap(async (req, res) => {
  const me = req.user;
  if (isAdmin(me)) return res.json({ admin: null });

  const admin = await prisma.user.findFirst({ where: { isAdmin: true } })
    || await prisma.user.findFirst({ where: { email: { equals: ADMIN_EMAIL, mode: 'insensitive' } } });
  if (!admin) return res.json({ admin: null });

  const [latest, unread] = await Promise.all([
    prisma.message.findFirst({
      where: {
        OR: [
          // Outbound from me → admin only counts if it wasn't sent
          // through the Share Feedback portal (which stamps
          // hiddenFromSenderAt). That keeps the pinned-admin row
          // empty until the admin actually replies.
          { fromUserId: me.id, toUserId: admin.id, hiddenFromSenderAt: null },
          // Any inbound from admin → me always surfaces the thread
          // (admin replies + broadcasts).
          { fromUserId: admin.id, toUserId: me.id },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fromUserId: true, content: true, attachment: true, createdAt: true, readAt: true },
    }),
    prisma.message.count({
      where: { fromUserId: admin.id, toUserId: me.id, readAt: null },
    }),
  ]);
  if (!latest) return res.json({ admin: null });

  res.json({
    admin: { id: admin.id, name: admin.name, picture: admin.picture, lastSeenAt: admin.lastSeenAt },
    latest: {
      id: latest.id,
      content: latest.content,
      attachment: latest.attachment,
      createdAt: latest.createdAt,
      fromMe: latest.fromUserId === me.id,
    },
    unread,
  });
}));

// DELETE /api/messages/dm/:userId — admin-only "delete conversation".
// Stamps hiddenFromAdminAt on every message in the pair so the thread
// vanishes from the admin's inbox listing. Recipient still keeps full
// history. If the user later sends a new message, that new row has
// hiddenFromAdminAt = null and the thread re-surfaces.
router.delete('/dm/:userId', wrap(async (req, res) => {
  const me = req.user;
  if (!isAdmin(me)) return res.status(403).json({ error: 'admin_only' });
  const otherId = req.params.userId;
  if (otherId === me.id) return res.status(400).json({ error: 'cannot_dm_self' });
  const result = await prisma.message.updateMany({
    where: {
      hiddenFromAdminAt: null,
      OR: [
        { fromUserId: me.id, toUserId: otherId },
        { fromUserId: otherId, toUserId: me.id },
      ],
    },
    data: { hiddenFromAdminAt: new Date() },
  });
  res.json({ ok: true, hidden: result.count });
}));

// GET /api/messages
// For a coaching client: returns the full conversation with the coach.
// For the coach: returns a summary list of every client thread (latest msg + unread count).
router.get('/', wrap(async (req, res) => {
  const me = req.user;

  if (isCoach(me)) {
    // Coach view: one row per coaching client, sorted by most recent message.
    const clients = await prisma.user.findMany({
      where: { coachingClient: true },
      select: {
        id: true, name: true, picture: true,
        sentMessages: {
          where: { toUserId: me.id },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, createdAt: true, readAt: true },
        },
        receivedMessages: {
          where: { fromUserId: me.id },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, createdAt: true },
        },
      },
    });

    // For each client compute unread count (messages FROM client that coach hasn't read).
    const threads = await Promise.all(clients.map(async (client) => {
      const unread = await prisma.message.count({
        where: { fromUserId: client.id, toUserId: me.id, readAt: null },
      });
      // Determine the latest message across both directions.
      const fromClient = client.sentMessages[0] || null;
      const fromCoach = client.receivedMessages[0] || null;
      let latest = null;
      if (fromClient && fromCoach) {
        latest = fromClient.createdAt > fromCoach.createdAt ? fromClient : fromCoach;
        latest = { ...latest, fromMe: fromClient.createdAt <= fromCoach.createdAt };
      } else if (fromClient) {
        latest = { ...fromClient, fromMe: false };
      } else if (fromCoach) {
        latest = { ...fromCoach, fromMe: true };
      }
      // Email omitted — privacy. Coach identifies clients by display name.
      return { client: { id: client.id, name: client.name, picture: client.picture }, latest, unread };
    }));

    // Sort by latest message timestamp descending (threads with no messages go last).
    threads.sort((a, b) => {
      const ta = a.latest ? new Date(a.latest.createdAt).getTime() : 0;
      const tb = b.latest ? new Date(b.latest.createdAt).getTime() : 0;
      return tb - ta;
    });

    return res.json({ threads });
  }

  // Client view: return the full conversation with the coach.
  if (!me.coachingClient) return res.status(403).json({ error: 'not_a_coaching_client' });

  const coach = await fetchCoach();
  if (!coach) return res.status(503).json({ error: 'coach_not_found' });

  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { fromUserId: me.id, toUserId: coach.id },
        { fromUserId: coach.id, toUserId: me.id },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, fromUserId: true, toUserId: true, content: true, attachment: true, readAt: true, createdAt: true },
  });

  // Mark unread messages from coach as read.
  const unreadIds = messages.filter(m => m.fromUserId === coach.id && !m.readAt).map(m => m.id);
  if (unreadIds.length > 0) {
    await prisma.message.updateMany({
      where: { id: { in: unreadIds } },
      data: { readAt: new Date() },
    });
  }

  res.json({
    messages,
    coachId: coach.id,
    coach: {
      id: coach.id,
      name: coach.name,
      picture: coach.picture,
      lastSeenAt: coach.lastSeenAt,
    },
  });
}));

// GET /api/messages/dm/:userId  (friends, OR admin↔anyone)
// Conversation between me and an accepted friend. Marks incoming as read.
// Admin↔anyone is allowed without a friendship (in either direction) — the
// admin can read replies to broadcasts, and any user can read what the
// admin sent them.
router.get('/dm/:userId', wrap(async (req, res) => {
  const me = req.user;
  const otherId = req.params.userId;
  if (otherId === me.id) return res.status(400).json({ error: 'cannot_dm_self' });

  let allowed = isAdmin(me);
  if (!allowed) {
    // Other party might be the admin — non-admin user opening the
    // pinned-admin thread to read a broadcast.
    const other = await prisma.user.findUnique({
      where: { id: otherId },
      select: { isAdmin: true, email: true },
    });
    if (other && isAdmin(other)) allowed = true;
  }
  if (!allowed) {
    const f = await prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { fromUserId: me.id, toUserId: otherId },
          { fromUserId: otherId, toUserId: me.id },
        ],
      },
      select: { id: true },
    });
    if (!f) return res.status(403).json({ error: 'not_friends' });
  }

  const friend = await prisma.user.findUnique({
    where: { id: otherId },
    // Email intentionally omitted — friends shouldn't see each other's email.
    select: { id: true, name: true, picture: true, lastSeenAt: true },
  });
  if (!friend) return res.status(404).json({ error: 'user_not_found' });

  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { fromUserId: me.id, toUserId: otherId },
        { fromUserId: otherId, toUserId: me.id },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, fromUserId: true, toUserId: true, content: true, attachment: true, readAt: true, createdAt: true },
  });

  // Mark unread incoming as read.
  const unreadIds = messages.filter(m => m.fromUserId === otherId && !m.readAt).map(m => m.id);
  if (unreadIds.length > 0) {
    await prisma.message.updateMany({
      where: { id: { in: unreadIds } },
      data: { readAt: new Date() },
    });
  }

  res.json({ messages, friend });
}));

// GET /api/messages/:clientId  (coach only)
// Full conversation between coach and a specific client. Also marks coach's
// incoming messages from that client as read.
router.get('/:clientId', wrap(async (req, res) => {
  const me = req.user;
  if (!isCoach(me)) return res.status(403).json({ error: 'forbidden' });

  const { clientId } = req.params;
  const client = await prisma.user.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, picture: true, coachingClient: true,
      timezone: true,
      tasks: {
        // Pull every task — frontend filters for today's view AND uses the
        // full set to compute at-a-glance analytics (week heatmap, exec
        // rate, top streaks, etc) without an extra round-trip.
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, text: true, scheduledDate: true, scheduledTime: true, done: true, completedDates: true, category: true, recurrence: true, createdAt: true, trackStreak: true, startedAt: true },
      },
    },
  });
  if (!client || !client.coachingClient) return res.status(404).json({ error: 'not_found' });

  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { fromUserId: me.id, toUserId: clientId },
        { fromUserId: clientId, toUserId: me.id },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, fromUserId: true, toUserId: true, content: true, attachment: true, readAt: true, createdAt: true },
  });

  // Mark incoming messages from this client as read.
  const unreadIds = messages.filter(m => m.fromUserId === clientId && !m.readAt).map(m => m.id);
  if (unreadIds.length > 0) {
    await prisma.message.updateMany({
      where: { id: { in: unreadIds } },
      data: { readAt: new Date() },
    });
  }

  res.json({ messages, client: { id: client.id, name: client.name, picture: client.picture, timezone: client.timezone }, tasks: client.tasks });
}));

// POST /api/messages
// Send a message. Body: { content, toUserId?, attachment? }
// `attachment` is an optional base64 image data URL.
// Clients always send to the coach (toUserId is ignored).
// The coach must supply toUserId (the client's ID).
// 25 MB of base64 = ~18 MB of binary. Big enough for a short phone
// video (~15-30s at typical bitrates), small enough that a row read
// from Postgres doesn't blow up the message handler. Images take
// far less than this in practice (chat downscales them to 1280px).
const MAX_ATTACHMENT_LENGTH = 25 * 1024 * 1024;
// Allow image OR short video. Quicktime / mov is here for iOS — the
// system video picker hands back .mov files from the camera roll.
const ATTACHMENT_RE = /^data:(image\/(png|jpe?g|webp|gif)|video\/(mp4|webm|quicktime));base64,[A-Za-z0-9+/=]+$/;

router.post('/', wrap(async (req, res) => {
  const me = req.user;
  const { content, toUserId, attachment } = req.body || {};

  // A message must have either text or an image (or both). Empty messages
  // are rejected.
  const trimmed = typeof content === 'string' ? content.trim() : '';
  const hasAttachment = typeof attachment === 'string' && attachment.length > 0;
  if (!trimmed && !hasAttachment) {
    return res.status(400).json({ error: 'content_required' });
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'content_too_long' });
  }
  if (hasAttachment) {
    if (attachment.length > MAX_ATTACHMENT_LENGTH) {
      return res.status(413).json({ error: 'attachment_too_large' });
    }
    if (!ATTACHMENT_RE.test(attachment)) {
      return res.status(400).json({ error: 'invalid_attachment' });
    }
  }

  let recipientId;

  if (toUserId) {
    // Explicit recipient — the coach replying to a client, OR any user
    // DMing a friend. Allowed pairs: coach↔client OR accepted friends.
    if (toUserId === me.id) return res.status(400).json({ error: 'cannot_dm_self' });
    const recipient = await prisma.user.findUnique({
      where: { id: toUserId },
      select: { id: true, coachingClient: true, isCoach: true, isAdmin: true, email: true },
    });
    if (!recipient) return res.status(404).json({ error: 'recipient_not_found' });

    const isCoachToClient = isCoach(me) && recipient.coachingClient;
    const isClientToCoach = me.coachingClient && !!recipient.isCoach;
    // Admin can DM anyone (outgoing 1:1 follow-ups), and anyone can DM the
    // admin (replying to a broadcast). No friend relationship required.
    const isAdminPair = isAdmin(me) || isAdmin(recipient);
    let allowed = isCoachToClient || isClientToCoach || isAdminPair;
    if (!allowed) {
      // Friend DM path — both sides must be accepted friends.
      const f = await prisma.friendship.findFirst({
        where: {
          status: 'accepted',
          OR: [
            { fromUserId: me.id, toUserId },
            { fromUserId: toUserId, toUserId: me.id },
          ],
        },
        select: { id: true },
      });
      allowed = !!f;
    }
    if (!allowed) return res.status(403).json({ error: 'not_authorized' });
    recipientId = toUserId;
  } else {
    // Legacy path with no toUserId: a coaching client DMing the coach.
    if (!me.coachingClient) return res.status(403).json({ error: 'not_a_coaching_client' });
    const coach = await fetchCoach();
    if (!coach) return res.status(503).json({ error: 'coach_not_found' });
    recipientId = coach.id;
  }

  const message = await prisma.message.create({
    data: {
      fromUserId: me.id,
      toUserId: recipientId,
      content: trimmed,
      attachment: hasAttachment ? attachment : null,
    },
    select: { id: true, fromUserId: true, toUserId: true, content: true, attachment: true, readAt: true, createdAt: true },
  });

  // Real-time push via the WebSocket broadcast map (populated by server/index.js).
  // The broadcast function is injected at startup; safe to skip if not wired.
  if (typeof global.wsBroadcast === 'function') {
    global.wsBroadcast(recipientId, { type: 'message', message });
    // Also echo back to sender on other open tabs.
    global.wsBroadcast(me.id, { type: 'message', message });
  }

  // OS-level push to the recipient (skipped if they're actively viewing
  // this thread, or have notifyMessages off). Fire-and-forget — never
  // blocks the response, never bubbles errors to the API caller.
  (async () => {
    try {
      const recipientFull = await prisma.user.findUnique({
        where: { id: recipientId },
        select: { id: true, notifyMessages: true, notifySystem: true },
      });
      await pushModule.pushForMessage({
        senderUser: { id: me.id, name: me.name },
        recipientUser: recipientFull,
        content: trimmed,
        hasAttachment,
        isSystem: false,
      });
    } catch (e) { console.warn('[push/dm] failed', e.message); }
  })();

  res.status(201).json({ message });
}));

module.exports = router;
