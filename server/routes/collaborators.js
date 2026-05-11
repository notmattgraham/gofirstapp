// Premium collaborators. Premium users grant ONE other account
// add/edit/delete/complete access to their task list (executive-
// assistant / spouse use case). Schema enforces the 1:1 invariant
// via @@unique on Collaboration.premiumUserId.
//
// Endpoints:
//   GET    /api/collaborators   — { mine, accessibleAccounts }
//   POST   /api/collaborators   — body: { email }; Premium user adds
//                                 their collaborator by email.
//   DELETE /api/collaborators/mine            — Premium user revokes
//                                               their own collaborator.
//   DELETE /api/collaborators/access/:ownerId — Collaborator removes
//                                               themselves from a grant.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
router.use(requireAuth);

function shapeUser(u) {
  return {
    id: u.id,
    name: u.name || null,
    email: u.email,
    picture: u.picture || null,
  };
}

// What grants are in play for the signed-in user, on both sides?
//   mine               — the collaborator I (Premium) have, or null
//   accessibleAccounts — Premium users who've granted ME access
router.get('/', wrap(async (req, res) => {
  const me = req.user;

  const [outgoing, incoming] = await Promise.all([
    prisma.collaboration.findFirst({
      where: { premiumUserId: me.id },
      include: { collaboratorUser: true },
    }),
    prisma.collaboration.findMany({
      where: { collaboratorUserId: me.id },
      include: { premiumUser: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  res.json({
    isPremium: !!me.isPremium,
    mine: outgoing
      ? { ...shapeUser(outgoing.collaboratorUser), since: outgoing.createdAt }
      : null,
    accessibleAccounts: incoming.map((c) => ({
      ...shapeUser(c.premiumUser),
      since: c.createdAt,
    })),
  });
}));

// Premium user adds a collaborator by email. Idempotent if the same
// pair is already in place — re-POSTing with the same email is a no-op
// 200. POSTing a different email when one is already set returns 409
// (Premium user must DELETE first, deliberately).
router.post('/', express.json(), wrap(async (req, res) => {
  const me = req.user;
  if (!me.isPremium) return res.status(403).json({ error: 'premium_only' });

  const rawEmail = (req.body && typeof req.body.email === 'string') ? req.body.email.trim().toLowerCase() : '';
  if (!rawEmail) return res.status(400).json({ error: 'email_required' });
  if (rawEmail === (me.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'cannot_collaborate_self' });
  }

  const target = await prisma.user.findFirst({
    where: { email: { equals: rawEmail, mode: 'insensitive' } },
    select: { id: true, name: true, email: true, picture: true },
  });
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  const existing = await prisma.collaboration.findFirst({
    where: { premiumUserId: me.id },
  });
  if (existing) {
    if (existing.collaboratorUserId === target.id) {
      // Idempotent re-add — return current state.
      return res.json({
        ok: true,
        collaborator: { ...shapeUser(target), since: existing.createdAt },
      });
    }
    return res.status(409).json({ error: 'collaborator_already_set' });
  }

  const created = await prisma.collaboration.create({
    data: { premiumUserId: me.id, collaboratorUserId: target.id },
  });
  res.json({
    ok: true,
    collaborator: { ...shapeUser(target), since: created.createdAt },
  });
}));

// Premium user revokes their collaborator.
router.delete('/mine', wrap(async (req, res) => {
  const me = req.user;
  await prisma.collaboration.deleteMany({ where: { premiumUserId: me.id } });
  res.json({ ok: true });
}));

// Collaborator removes themselves from one Premium account's grant.
router.delete('/access/:ownerId', wrap(async (req, res) => {
  const me = req.user;
  const ownerId = req.params.ownerId;
  await prisma.collaboration.deleteMany({
    where: { premiumUserId: ownerId, collaboratorUserId: me.id },
  });
  res.json({ ok: true });
}));

module.exports = router;
