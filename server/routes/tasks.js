const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { userToday, userTomorrow, isOverrideActive, isFirstDay } = require('../time');

const router = express.Router();
router.use(requireAuth);

const VALID_CATEGORIES = new Set(['Family', 'Fitness', 'Career', 'Self-Improvement', 'Other']);
function sanitizeCategory(v) {
  return typeof v === 'string' && VALID_CATEGORIES.has(v) ? v : null;
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
async function todayCompletionState(user) {
  const today = userToday(user);
  const tasks = await prisma.task.findMany({ where: { userId: user.id } });
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

async function isTodayComplete(user) {
  return (await todayCompletionState(user)).complete;
}

// Decide if a task with the given scheduledDate may be created/edited/deleted.
// Day-lock suspended until app is stable as a reliable to-do list.
// To re-enable, restore the full lock logic here.
async function canMutateForDate(user, scheduledDate) {
  return { ok: true };
}
function rejectLocked(res, guard) {
  return res.status(403).json({
    error: 'locked',
    reason: guard.reason,
    message: guard.message,
  });
}

router.get('/', async (req, res) => {
  const rows = await prisma.task.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    tasks: rows.map(shape),
    today: userToday(req.user),
    tomorrow: userTomorrow(req.user),
    todayComplete: await isTodayComplete(req.user),
    overrideActive: isOverrideActive(req.user),
  });
});

router.post('/', async (req, res) => {
  const { text, startedAt, recurrence, trackStreak, category, scheduledDate, scheduledTime, notes } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'text required' });

  const isRecurring = !!recurrence;
  const date = scheduledDate || (isRecurring ? null : userToday(req.user));

  // Recurring tasks are permanent habit templates, not entries in any single
  // day's committed list — so they bypass the day-lock entirely.
  // One-shot tasks must pass the lock check on their scheduled date.
  if (!isRecurring) {
    const guard = await canMutateForDate(req.user, date);
    if (!guard.ok) return rejectLocked(res, guard);
  }

  const isDaily = recurrence && recurrence.type === 'daily';
  const task = await prisma.task.create({
    data: {
      userId: req.user.id,
      text: trimmed,
      startedAt: startedAt || new Date().toISOString(),
      scheduledDate: isRecurring ? null : date,
      recurrence: recurrence || null,
      trackStreak: !!(isDaily && trackStreak),
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

  // Lock check — but completion-only updates (done / completedDates) bypass the lock,
  // as does editing a recurring task (habit templates aren't part of the daily lock).
  const onlyCompletionFields = Object.keys(data).every(k => k === 'done' || k === 'completedDates');
  const editingRecurring = !!existing.recurrence;
  if (!onlyCompletionFields && !editingRecurring) {
    const date = existing.scheduledDate || userToday(req.user);
    const guard = await canMutateForDate(req.user, date);
    if (!guard.ok) return rejectLocked(res, guard);
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

  // Recurring tasks can always be deleted — they're not part of the daily lock.
  if (!existing.recurrence) {
    const date = existing.scheduledDate || userToday(req.user);
    const guard = await canMutateForDate(req.user, date);
    if (!guard.ok) return rejectLocked(res, guard);
  }

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
