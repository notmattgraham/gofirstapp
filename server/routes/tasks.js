const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { userToday, userTomorrow, isOverrideActive, isDevAccount } = require('../time');

const router = express.Router();
router.use(requireAuth);

const VALID_CATEGORIES = new Set(['Family', 'Fitness', 'Career', 'Self-Improvement', 'Other']);
function sanitizeCategory(v) {
  return typeof v === 'string' && VALID_CATEGORIES.has(v) ? v : null;
}

// Only this allow-listed account is permitted to set devMode=true on tasks.
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
    scheduledDate: t.scheduledDate,
    parentTaskId: t.parentTaskId,
    recurrence: t.recurrence,
    trackStreak: t.trackStreak,
    category: t.category,
    devMode: t.devMode,
    done: t.done,
    completedDates: t.completedDates,
    createdAt: t.createdAt.getTime ? t.createdAt.getTime() : t.createdAt,
  };
}

// "Today is complete" → no remaining incomplete tasks scheduled for today.
// Recurring tasks count as complete if today's ISO is in completedDates.
async function todayCompletionState(user) {
  const today = userToday(user);
  const tasks = await prisma.task.findMany({ where: { userId: user.id } });
  let total = 0, incomplete = 0;
  const dow = new Date(today + 'T00:00:00').getDay();
  for (const t of tasks) {
    if (t.devMode) continue;
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
// Returns ok:true OR ok:false plus a reason code AND a friendly message
// suitable for showing the user verbatim.
async function canMutateForDate(user, scheduledDate) {
  if (isDevAccount(user)) return { ok: true };
  const today = userToday(user);
  const tomorrow = userTomorrow(user);
  if (scheduledDate === today) {
    if (isOverrideActive(user)) return { ok: true };
    const todayState = await todayCompletionState(user);
    if (todayState.total > 0) {
      return {
        ok: false,
        reason: 'today_locked',
        message: 'Today is locked. Complete all tasks to unlock tomorrow.',
      };
    }
    return {
      ok: false,
      reason: 'today_locked',
      message: 'Today is locked. Start planning for tomorrow.',
    };
  }
  if (scheduledDate === tomorrow) {
    const todayState = await todayCompletionState(user);
    if (todayState.complete) return { ok: true };
    const word = todayState.incomplete === 1 ? 'task' : 'tasks';
    return {
      ok: false,
      reason: 'today_incomplete',
      message: `Finish today\u2019s ${todayState.incomplete} unchecked ${word} before planning tomorrow.`,
    };
  }
  return {
    ok: false,
    reason: 'date_out_of_window',
    message: 'Tasks can only be added for tomorrow.',
  };
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
  const { text, startedAt, recurrence, trackStreak, category, devMode, scheduledDate } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'text required' });

  const isRecurring = !!recurrence;
  const date = scheduledDate || (isRecurring ? null : userTomorrow(req.user));

  // One-shot tasks need to pass the lock check on their scheduledDate.
  // Recurring tasks (templates) can be created during the editing window for tomorrow,
  // since they'll start auto-populating from then on.
  const checkDate = isRecurring ? userTomorrow(req.user) : date;
  const guard = await canMutateForDate(req.user, checkDate);
  if (!guard.ok) {
    return rejectLocked(res, guard);
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
  const allowed = ['text', 'startedAt', 'recurrence', 'trackStreak', 'done', 'completedDates', 'category', 'devMode', 'scheduledDate'];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) data[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(data, 'category')) {
    data.category = sanitizeCategory(data.category);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'devMode')) {
    data.devMode = allowedDevMode(req.user, data.devMode);
  }

  // Lock check — but completion-only updates (done / completedDates) bypass the lock.
  // The user can always check or uncheck a task; that's the entire point of today's list.
  const onlyCompletionFields = Object.keys(data).every(k => k === 'done' || k === 'completedDates');
  if (!onlyCompletionFields && !isDevAccount(req.user)) {
    const date = existing.scheduledDate || (existing.recurrence ? userTomorrow(req.user) : userToday(req.user));
    const guard = await canMutateForDate(req.user, date);
    if (!guard.ok) {
      return rejectLocked(res, guard);
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

  if (!isDevAccount(req.user)) {
    const date = existing.scheduledDate || (existing.recurrence ? userTomorrow(req.user) : userToday(req.user));
    const guard = await canMutateForDate(req.user, date);
    if (!guard.ok) {
      return rejectLocked(res, guard);
    }
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
router.get('/missed', async (req, res) => {
  const today = userToday(req.user);
  const rows = await prisma.task.findMany({
    where: {
      userId: req.user.id,
      done: false,
      recurrence: null,
      scheduledDate: { not: null, lt: today },
    },
    orderBy: { scheduledDate: 'desc' },
  });
  res.json({ missed: rows.map(shape) });
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
      devMode: original.devMode,
      done: false,
      completedDates: [],
    },
  });
  res.json({ task: shape(dup) });
});

module.exports = router;
