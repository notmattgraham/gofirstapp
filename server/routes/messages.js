// Coaching chat — messages between coaching clients and the coach.
// All endpoints require auth. Clients can only message the coach; the coach
// can message any client. Message history is scoped to the pair.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');

const COACH_EMAIL = (process.env.COACH_EMAIL || 'mattgraham15@gmail.com').toLowerCase();
const MAX_MESSAGE_LENGTH = 4000;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
router.use(requireAuth);

// Helper: is the given user the coach?
// DB flag wins; the env-email fallback bootstraps the very first coach
// before anyone has been flagged via /dev.
function isCoach(user) {
  return !!user.isCoach || (user.email || '').toLowerCase() === COACH_EMAIL;
}

// Helper: fetch the coach user record. Prefer a user explicitly flagged in
// the DB; fall back to the env-configured email.
async function fetchCoach() {
  const flagged = await prisma.user.findFirst({ where: { isCoach: true } });
  if (flagged) return flagged;
  return prisma.user.findFirst({ where: { email: { equals: COACH_EMAIL, mode: 'insensitive' } } });
}

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
        id: true, email: true, name: true, picture: true,
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
      return { client: { id: client.id, email: client.email, name: client.name, picture: client.picture }, latest, unread };
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
      id: true, email: true, name: true, picture: true, coachingClient: true,
      timezone: true,
      tasks: {
        // Pull every task — frontend filters for today's view AND uses the
        // full set to compute at-a-glance analytics (week heatmap, exec
        // rate, top streaks, etc) without an extra round-trip.
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, text: true, scheduledDate: true, scheduledTime: true, done: true, completedDates: true, category: true, recurrence: true, createdAt: true, trackStreak: true },
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

  res.json({ messages, client: { id: client.id, email: client.email, name: client.name, picture: client.picture, timezone: client.timezone }, tasks: client.tasks });
}));

// POST /api/messages
// Send a message. Body: { content, toUserId?, attachment? }
// `attachment` is an optional base64 image data URL.
// Clients always send to the coach (toUserId is ignored).
// The coach must supply toUserId (the client's ID).
const MAX_ATTACHMENT_LENGTH = 4 * 1024 * 1024; // 4MB of base64 (~3MB binary)
const ATTACHMENT_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

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

  if (isCoach(me)) {
    // Coach is sending to a client.
    if (!toUserId) return res.status(400).json({ error: 'toUserId_required' });
    const recipient = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true, coachingClient: true } });
    if (!recipient || !recipient.coachingClient) return res.status(404).json({ error: 'client_not_found' });
    recipientId = toUserId;
  } else {
    // Client is sending to the coach.
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

  res.status(201).json({ message });
}));

module.exports = router;
