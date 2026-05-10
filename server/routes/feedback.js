// Share-Feedback portal. Creates a regular Message from the signed-in
// user → the admin, but stamps `hiddenFromSenderAt = now` so the
// thread doesn't appear in the user's pinned-admin row until the admin
// replies. From the admin's side it shows up in the normal inbox
// alongside any other DM. When the admin replies, the reply has
// hiddenFromSenderAt = null, the thread surfaces in the user's
// inbox, and they can scroll back to read their original feedback.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const pushModule = require('./push');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();
const MAX_FEEDBACK_LENGTH = 4000;

const router = express.Router();
router.use(requireAuth);

router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
  const me = req.user;
  const raw = (req.body && typeof req.body.body === 'string') ? req.body.body : '';
  const content = raw.trim().slice(0, MAX_FEEDBACK_LENGTH);
  if (!content) return res.status(400).json({ error: 'empty_body' });

  // Find the admin user. DB flag wins; ADMIN_EMAIL env var bootstraps
  // before anyone is flagged in /dev. Same priority order as messages.js.
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } })
    || await prisma.user.findFirst({ where: { email: { equals: ADMIN_EMAIL, mode: 'insensitive' } } });
  if (!admin) return res.status(503).json({ error: 'admin_not_found' });
  if (admin.id === me.id) return res.status(400).json({ error: 'cannot_feedback_self' });

  const message = await prisma.message.create({
    data: {
      fromUserId: me.id,
      toUserId: admin.id,
      content,
      hiddenFromSenderAt: new Date(),
    },
    select: { id: true, fromUserId: true, toUserId: true, content: true, attachment: true, readAt: true, createdAt: true },
  });

  // Real-time WS broadcast to the admin only — we deliberately DON'T
  // echo back to the sender (which is what /api/messages does for
  // multi-tab sync), so the user's UI never flickers with a copy of
  // their own feedback in the inbox.
  if (typeof global.wsBroadcast === 'function') {
    global.wsBroadcast(admin.id, { type: 'message', message });
  }

  // OS push to admin. Same machinery as a regular DM.
  (async () => {
    try {
      const adminFull = await prisma.user.findUnique({
        where: { id: admin.id },
        select: { id: true, notifyMessages: true, notifySystem: true },
      });
      await pushModule.pushForMessage({
        senderUser: { id: me.id, name: me.name },
        recipientUser: adminFull,
        content,
        hasAttachment: false,
        isSystem: false,
      });
    } catch (e) { console.warn('[feedback/push] failed', e.message); }
  })();

  res.json({ ok: true });
});

module.exports = router;
