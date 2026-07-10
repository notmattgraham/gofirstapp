const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { userToday, userTomorrow } = require('../time');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();
// Effective premium — DB flag OR admin (admins get everything).
function hasPremiumAccess(u) {
  if (!u) return false;
  if (u.isPremium) return true;
  if (u.isAdmin) return true;
  return (u.email || '').toLowerCase() === ADMIN_EMAIL;
}

const router = express.Router();
router.use(requireAuth);

const VALID_CATEGORIES = new Set(['Family', 'Fitness', 'Career', 'Self-Improvement', 'Other']);
function sanitizeCategory(v) {
  return typeof v === 'string' && VALID_CATEGORIES.has(v) ? v : null;
}

// Free-tier cap on tracked habits (recurring tasks with trackStreak=true).
// Premium = unlimited. Mirrored client-side in window.Premium.FREE_TRACKED_HABIT_CAP.
const FREE_TRACKED_HABIT_CAP = 3;
async function trackedHabitCount(userId) {
  return prisma.task.count({ where: { userId, trackStreak: true } });
}

function shape(t) {
  return {
    id: t.id,
    text: t.text,
    startedAt: t.startedAt,
    scheduledDate: t.scheduledDate,
    parentTaskId: t.parentTaskId,
    recurrence: t.recurrence,
    trackStreak: t.trackStreak,
    category: t.category,
    scheduledTime: t.scheduledTime || null,
    notes: t.notes || null,
    done: t.done,
    completedDates: t.completedDates,
    createdAt: t.createdAt.getTime ? t.createdAt.getTime() : t.createdAt,
  };
}

function sanitizeTime(v) {
  // Accept HH:MM in 24-hour format only
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
}

function sanitizeNotes(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 1000);
}

// "Today is complete" → no remaining incomplete tasks scheduled for today.
// Recurring tasks count as complete if today's ISO is in completedDates.
// Pure synchronous — operates on a tasks array the caller already has,
// so /api/tasks doesn't have to hit the DB twice. (Used to be async +
// re-fetch the same task list, doubling the per-request DB roundtrips.)
function todayCompletionStateFromTasks(user, tasks) {
  const today = userToday(user);
  let total = 0, incomplete = 0;
  const dow = new Date(today + 'T00:00:00').getDay();
  for (const t of tasks) {
    if (t.recurrence) {
      const days = (t.recurrence.daysOfWeek) || [];
      if (days.includes(dow)) {
        total++;
        if (!(t.completedDates || []).includes(today)) incomplete++;
      }
    } else if (t.scheduledDate === today) {
      total++;
      if (!t.done) incomplete++;
    }
  }
  return { total, incomplete, complete: incomplete === 0 };
}

// Async path retained for the few callers that don't already have
// the task list in hand. Re-fetches and delegates.
async function todayCompletionState(user) {
  const tasks = await prisma.task.findMany({ where: { userId: user.id } });
  return todayCompletionStateFromTasks(user, tasks);
}

async function isTodayComplete(user) {
  return (await todayCompletionState(user)).complete;
}

router.get('/', async (req, res) => {
  const rows = await prisma.task.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  // Compute todayComplete from the rows we already have rather than
  // hitting the DB a second time. Used to be a separate findMany on
  // the same table — doubled per-request DB roundtrips and noticeably
  // slow for users with hundreds of tasks.
  res.json({
    tasks: rows.map(shape),
    today: userToday(req.user),
    tomorrow: userTomorrow(req.user),
    todayComplete: todayCompletionStateFromTasks(req.user, rows).complete,
  });
});

router.post('/', async (req, res) => {
  const { text, startedAt, recurrence, trackStreak, category, scheduledDate, scheduledTime, notes } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'text required' });

  const isRecurring = !!recurrence;
  const date = scheduledDate || (isRecurring ? null : userToday(req.user));

  const isDaily = recurrence && recurrence.type === 'daily';
  const wantsTrackStreak = !!(isDaily && trackStreak);
  // Cap free users at FREE_TRACKED_HABIT_CAP tracked daily habits.
  if (wantsTrackStreak && !hasPremiumAccess(req.user)) {
    const count = await trackedHabitCount(req.user.id);
    if (count >= FREE_TRACKED_HABIT_CAP) {
      return res.status(402).json({
        error: 'free_tier_cap',
        cap: FREE_TRACKED_HABIT_CAP,
        message: `Free accounts can track ${FREE_TRACKED_HABIT_CAP} habits. Upgrade to Premium for unlimited.`,
      });
    }
  }
  const task = await prisma.task.create({
    data: {
      userId: req.user.id,
      text: trimmed,
      startedAt: startedAt || new Date().toISOString(),
      scheduledDate: isRecurring ? null : date,
      recurrence: recurrence || null,
      trackStreak: wantsTrackStreak,
      category: sanitizeCategory(category),
      scheduledTime: sanitizeTime(scheduledTime),
      notes: sanitizeNotes(notes),
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
  const allowed = ['text', 'startedAt', 'recurrence', 'trackStreak', 'done', 'completedDates', 'category', 'scheduledDate', 'scheduledTime', 'notes'];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) data[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(data, 'category')) {
    data.category = sanitizeCategory(data.category);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'scheduledTime')) {
    data.scheduledTime = sanitizeTime(data.scheduledTime);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'notes')) {
    data.notes = sanitizeNotes(data.notes);
  }

  // Free-tier cap on tracked habits, applied when this PATCH would
  // FLIP the field from false→true. Skip when it's already on (no
  // delta) or when the owner is Premium.
  if (
    Object.prototype.hasOwnProperty.call(data, 'trackStreak')
    && data.trackStreak === true
    && existing.trackStreak !== true
    && !hasPremiumAccess(req.user)
  ) {
    const count = await trackedHabitCount(req.user.id);
    if (count >= FREE_TRACKED_HABIT_CAP) {
      return res.status(402).json({
        error: 'free_tier_cap',
        cap: FREE_TRACKED_HABIT_CAP,
        message: `Free accounts can track ${FREE_TRACKED_HABIT_CAP} habits. Upgrade to Premium for unlimited.`,
      });
    }
  }

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

// One-shot import from a brand-new user's localStorage.
router.post('/import', async (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks array required' });

  const existingCount = await prisma.task.count({ where: { userId: req.user.id } });
  if (existingCount > 0) return res.status(409).json({ error: 'tasks already exist' });

  const today = userToday(req.user);
  const rows = await prisma.$transaction(tasks.map((t) => prisma.task.create({
    data: {
      userId: req.user.id,
      text: String(t.text || '').slice(0, 240),
      startedAt: t.startedAt || new Date().toISOString(),
      // Imported one-shots land on today so they show up immediately.
      scheduledDate: t.recurrence ? null : today,
      recurrence: t.recurrence || null,
      trackStreak: !!(t.recurrence && t.recurrence.type === 'daily' && t.trackStreak),
      category: sanitizeCategory(t.category),
      done: !!t.done,
      completedDates: Array.isArray(t.completedDates) ? t.completedDates.slice(0, 3650) : [],
    },
  })));
  res.json({ created: rows.length });
});

// "Missed tasks" page — one-shots from a past day that the user never completed.
// Uses Prisma.DbNull (SQL NULL) to correctly filter JSON? field, and a 5s server-side
// timeout so a slow DB query never hangs the client's Store.load() indefinitely.
router.get('/missed', async (req, res) => {
  try {
    const today = userToday(req.user);
    const rows = await Promise.race([
      prisma.task.findMany({
        where: {
          userId: req.user.id,
          done: false,
          recurrence: Prisma.DbNull,
          scheduledDate: { not: null, lt: today },
        },
        orderBy: { scheduledDate: 'desc' },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('missed-query-timeout')), 5000)
      ),
    ]);
    res.json({ missed: rows.map(shape) });
  } catch (e) {
    console.warn('[/missed] error, returning empty:', e.message);
    res.json({ missed: [] });
  }
});

// Re-add a missed task to today as a duplicate. Always allowed regardless
// of lock state — by design, the user can always own up to a missed task.
// The original record stays intact (still counts as a miss in analytics).
router.post('/missed/:id/retry', async (req, res) => {
  const { id } = req.params;
  const original = await prisma.task.findUnique({ where: { id } });
  if (!original || original.userId !== req.user.id) return res.status(404).json({ error: 'not found' });
  if (original.recurrence) return res.status(400).json({ error: 'recurring tasks cannot be carried over' });
  if (original.done) return res.status(400).json({ error: 'task is not missed' });

  const today = userToday(req.user);
  if (original.scheduledDate >= today) return res.status(400).json({ error: 'task is not in the past' });

  const dup = await prisma.task.create({
    data: {
      userId: req.user.id,
      text: original.text,
      startedAt: original.startedAt,
      scheduledDate: today,
      parentTaskId: original.id,
      recurrence: null,
      trackStreak: false,
      category: original.category,
      done: false,
      completedDates: [],
    },
  });
  res.json({ task: shape(dup) });
});

module.exports = router;
