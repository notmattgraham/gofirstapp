const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');

// Free-tier cap on quit streaks ("walking away from"). Premium is
// unlimited. Mirrored client-side in window.Premium.FREE_QUIT_STREAK_CAP
// so the SPA can disable the Add button + show the upgrade prompt
// before the user even tries.
const FREE_QUIT_STREAK_CAP = 3;

const router = express.Router();
router.use(requireAuth);

function shape(s) {
  return {
    id: s.id,
    name: s.name,
    type: 'quit',
    startAt: s.startAt,
    createdAt: s.createdAt.getTime ? s.createdAt.getTime() : s.createdAt,
  };
}

router.get('/', async (req, res) => {
  const rows = await prisma.quitStreak.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ streaks: rows.map(shape) });
});

router.post('/', async (req, res) => {
  const { name, startAt } = req.body || {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'name required' });
  // Cap free users at FREE_QUIT_STREAK_CAP. The SPA suppresses the Add
  // button at the cap (with an upgrade nudge), but defense-in-depth
  // here so a direct API call can't bypass it.
  if (!req.user.isPremium) {
    const count = await prisma.quitStreak.count({ where: { userId: req.user.id } });
    if (count >= FREE_QUIT_STREAK_CAP) {
      return res.status(402).json({
        error: 'free_tier_cap',
        cap: FREE_QUIT_STREAK_CAP,
        message: 'Free accounts can track 3 quit streaks. Upgrade to Premium for unlimited.',
      });
    }
  }
  const row = await prisma.quitStreak.create({
    data: {
      userId: req.user.id,
      name: trimmed,
      startAt: startAt || new Date().toISOString(),
    },
  });
  res.json({ streak: shape(row) });
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.quitStreak.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user.id) return res.status(404).json({ error: 'not found' });
  const data = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) data.name = String(req.body.name || '').trim();
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'startAt')) data.startAt = req.body.startAt;
  const row = await prisma.quitStreak.update({ where: { id }, data });
  res.json({ streak: shape(row) });
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.quitStreak.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user.id) return res.status(404).json({ error: 'not found' });
  await prisma.quitStreak.delete({ where: { id } });
  res.json({ ok: true });
});

router.post('/import', async (req, res) => {
  const { streaks } = req.body || {};
  if (!Array.isArray(streaks)) return res.status(400).json({ error: 'streaks array required' });
  const existingCount = await prisma.quitStreak.count({ where: { userId: req.user.id } });
  if (existingCount > 0) return res.status(409).json({ error: 'streaks already exist' });
  const rows = await prisma.$transaction(streaks.map((s) => prisma.quitStreak.create({
    data: {
      userId: req.user.id,
      name: String(s.name || '').slice(0, 80),
      startAt: s.startAt || new Date().toISOString(),
    },
  })));
  res.json({ created: rows.length });
});

module.exports = router;
