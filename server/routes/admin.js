// Admin / developer dashboard. Hidden URL at /admin (also /dev).
// Only the app-wide admin (DB isAdmin OR env ADMIN_EMAIL) can hit these.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { dateInTz } = require('../time');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();

// Wrap async handlers so any thrown error reaches Express's error middleware
// (returning a 500) instead of becoming an unhandledRejection.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();
router.use(requireAuth);

function isAdmin(user) {
  if (!user) return false;
  return !!user.isAdmin || (user.email || '').toLowerCase() === ADMIN_EMAIL;
}

// Access gate. 404 (not 403) so the route is invisible to outsiders.
router.use((req, res, next) => {
  if (!isAdmin(req.user)) return res.status(404).json({ error: 'not_found' });
  next();
});

router.get('/me', (req, res) => {
  res.json({
    admin: true,
    email: req.user.email,
    name: req.user.name,
    isAdmin: true,
  });
});

function taskCounts(t) {
  const completedDates = Array.isArray(t.completedDates) ? t.completedDates : [];
  if (!t.recurrence) {
    if (!t.scheduledDate) return { scheduled: 0, completed: 0 };
    return { scheduled: 1, completed: t.done ? 1 : 0 };
  }
  const days = (t.recurrence && t.recurrence.daysOfWeek) || [];
  if (!days.length) return { scheduled: 0, completed: completedDates.length };
  const start = new Date(t.createdAt);
  const today = new Date();
  start.setUTCHours(0, 0, 0, 0);
  today.setUTCHours(0, 0, 0, 0);
  let scheduled = 0;
  for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    if (days.includes(d.getUTCDay())) scheduled++;
  }
  return { scheduled, completed: completedDates.length };
}

function summarizeTasks(tasks) {
  let scheduled = 0, completed = 0;
  const byCategory = {};
  let recurringCount = 0;
  let oneShotCount = 0;
  for (const t of tasks) {
    const c = taskCounts(t);
    scheduled += c.scheduled;
    completed += c.completed;
    if (t.recurrence) recurringCount++; else oneShotCount++;
    const cat = t.category || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = { scheduled: 0, completed: 0 };
    byCategory[cat].scheduled += c.scheduled;
    byCategory[cat].completed += c.completed;
  }
  const executionRate = scheduled > 0 ? completed / scheduled : null;
  return {
    totalTasks: tasks.length,
    recurringCount,
    oneShotCount,
    scheduled,
    completed,
    executionRate,
    byCategory,
  };
}

router.get('/stats', wrap(async (_req, res) => {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = new Date(now.getTime() - 30 * day);

  const [userCount, activeUserIds30, allUsers] = await Promise.all([
    prisma.user.count(),
    prisma.task.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.user.findMany({
      select: {
        id: true,
        tasks: {
          select: {
            recurrence: true, scheduledDate: true, done: true,
            completedDates: true, createdAt: true,
          },
        },
      },
    }),
  ]);

  let rateSum = 0, rateCount = 0;
  for (const u of allUsers) {
    const r = summarizeTasks(u.tasks).executionRate;
    if (r != null) { rateSum += r; rateCount++; }
  }
  const appExecutionRate = rateCount > 0 ? rateSum / rateCount : null;

  res.json({
    users: {
      total: userCount,
      active30d: activeUserIds30.length,
    },
    appExecutionRate,
    serverDate: dateInTz(now, 'UTC'),
  });
}));

router.get('/users', wrap(async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      tasks: {
        select: {
          id: true, recurrence: true, scheduledDate: true, done: true,
          completedDates: true, category: true, createdAt: true, updatedAt: true,
        },
      },
      quitStreaks: { select: { id: true } },
    },
  });

  const rows = users.map((u) => {
    const summary = summarizeTasks(u.tasks);
    const lastTaskTouch = u.tasks.reduce((max, t) => {
      const ts = t.updatedAt instanceof Date ? t.updatedAt.getTime() : new Date(t.updatedAt).getTime();
      return ts > max ? ts : max;
    }, 0);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      timezone: u.timezone,
      createdAt: u.createdAt,
      lastActivityAt: lastTaskTouch ? new Date(lastTaskTouch).toISOString() : null,
      isAdmin: u.isAdmin,
      isPremium: u.isPremium,
      taskCount: summary.totalTasks,
      streakCount: u.quitStreaks.length,
      executionRate: summary.executionRate,
      scheduled: summary.scheduled,
      completed: summary.completed,
    };
  });

  res.json({ users: rows });
}));

router.patch('/users/:id/premium', wrap(async (req, res) => {
  const { isPremium } = req.body || {};
  if (typeof isPremium !== 'boolean') {
    return res.status(400).json({ error: 'isPremium_required' });
  }
  try {
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isPremium },
      select: { id: true, email: true, name: true, isPremium: true },
    });
    res.json({ user: updated });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

// PATCH /api/admin/users/:id/role — set a user's role.
// Body: { role: 'user' | 'admin' }
// Only one admin at a time — promoting another admin demotes the current one.
router.patch('/users/:id/role', wrap(async (req, res) => {
  const role = (req.body && req.body.role) || '';
  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  try {
    if (role === 'admin') {
      await prisma.user.updateMany({
        where: { isAdmin: true, NOT: { id: req.params.id } },
        data: { isAdmin: false },
      });
    }
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isAdmin: role === 'admin' },
      select: { id: true, email: true, name: true, isAdmin: true },
    });
    res.json({ user: updated });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

router.delete('/users/:id', wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

// POST /api/admin/purge-others — nuke every user account except the caller's.
router.post('/purge-others', wrap(async (req, res) => {
  const result = await prisma.user.deleteMany({
    where: { id: { not: req.user.id } },
  });
  res.json({ ok: true, deleted: result.count, keptEmail: req.user.email });
}));

router.get('/users/:id', wrap(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      tasks: { orderBy: { createdAt: 'desc' } },
      quitStreaks: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!user) return res.status(404).json({ error: 'not_found' });

  const summary = summarizeTasks(user.tasks);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      timezone: user.timezone,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    summary,
    tasks: user.tasks.map((t) => ({
      id: t.id,
      text: t.text,
      startedAt: t.startedAt,
      scheduledDate: t.scheduledDate,
      recurrence: t.recurrence,
      trackStreak: t.trackStreak,
      category: t.category,
      done: t.done,
      completedDates: t.completedDates,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    streaks: user.quitStreaks.map((s) => ({
      id: s.id,
      name: s.name,
      startAt: s.startAt,
      createdAt: s.createdAt,
    })),
  });
}));

module.exports = router;
