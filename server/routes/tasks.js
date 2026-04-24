const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

// Trim a task record to the fields the client needs (and nothing more).
const VALID_CATEGORIES = new Set(['Family', 'Fitness', 'Career', 'Self-Improvement', 'Other']);
function sanitizeCategory(v) {
  return typeof v === 'string' && VALID_CATEGORIES.has(v) ? v : null;
}

// Only this allow-listed account is permitted to set devMode=true on tasks.
// Every other user's devMode is forced to false regardless of what the client sends.
const DEV_ACCOUNT = 'mattgraham15@gmail.com';
function allowedDevMode(user, requested) {
  if (!requested) return false;
  return user && user.email === DEV_ACCOUNT;
}

function shape(t) {
  return {
    id: t.id,
    text: t.text,
    startedAt: t.startedAt,
    recurrence: t.recurrence,
    trackStreak: t.trackStreak,
    category: t.category,
    devMode: t.devMode,
    done: t.done,
    completedDates: t.completedDates,
    createdAt: t.createdAt.getTime ? t.createdAt.getTime() : t.createdAt,
  };
}

router.get('/', async (req, res) => {
  const rows = await prisma.task.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ tasks: rows.map(shape) });
});

router.post('/', async (req, res) => {
  const { text, startedAt, recurrence, trackStreak, category, devMode } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'text required' });

  const isDaily = recurrence && recurrence.type === 'daily';
  const task = await prisma.task.create({
    data: {
      userId: req.user.id,
      text: trimmed,
      startedAt: startedAt || new Date().toISOString(),
      recurrence: recurrence || null,
      trackStreak: !!(isDaily && trackStreak),
      category: sanitizeCategory(category),
      devMode: allowedDevMode(req.user, devMode),
      done: false,
      completedDates: [],
    },
  });
  res.json({ task: shape(task) });
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user.id) return res.status(404).json({ error: 'not found' });

  const data = {};
  const allowed = ['text', 'startedAt', 'recurrence', 'trackStreak', 'done', 'completedDates', 'category', 'devMode'];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) data[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(data, 'category')) {
    data.category = sanitizeCategory(data.category);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'devMode')) {
    data.devMode = allowedDevMode(req.user, data.devMode);
  }

  // Tracking only makes sense for daily recurrence; enforce server-side.
  const effectiveRecurrence = data.recurrence !== undefined ? data.recurrence : existing.recurrence;
  if (!effectiveRecurrence || effectiveRecurrence.type !== 'daily') data.trackStreak = false;

  const task = await prisma.task.update({ where: { id }, data });
  res.json({ task: shape(task) });
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user.id) return res.status(404).json({ error: 'not found' });
  await prisma.task.delete({ where: { id } });
  res.json({ ok: true });
});

// One-shot import from a brand-new user's localStorage. Refuses to run if
// the user already has tasks — prevents accidental double-imports after
// a device-refresh.
router.post('/import', async (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks array required' });

  const existingCount = await prisma.task.count({ where: { userId: req.user.id } });
  if (existingCount > 0) return res.status(409).json({ error: 'tasks already exist' });

  const rows = await prisma.$transaction(tasks.map((t) => prisma.task.create({
    data: {
      userId: req.user.id,
      text: String(t.text || '').slice(0, 240),
      startedAt: t.startedAt || new Date().toISOString(),
      recurrence: t.recurrence || null,
      trackStreak: !!(t.recurrence && t.recurrence.type === 'daily' && t.trackStreak),
      category: sanitizeCategory(t.category),
      done: !!t.done,
      completedDates: Array.isArray(t.completedDates) ? t.completedDates.slice(0, 3650) : [],
    },
  })));
  res.json({ created: rows.length });
});

module.exports = router;
