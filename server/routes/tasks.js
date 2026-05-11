const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { userToday, userTomorrow, isOverrideActive, isFirstDay } = require('../time');
const { attachActor } = require('../collab');
const pushModule = require('./push');

const router = express.Router();
router.use(requireAuth);
// Resolves req.acting (the user we're operating on behalf of). Without
// ?as=<premiumOwnerId>, req.acting === req.user. With ?as= present and
// the caller authorized as a collaborator, req.acting is the OWNER and
// req.collab is the signed-in collaborator. All downstream queries scope
// off req.acting.id; req.collab is consulted only to fire the
// "collaborator changed your list" push.
router.use(attachActor);

// Fire a push to the Premium owner when a collaborator mutates their
// list. No-op when the request is self-acting (no req.collab) or when
// the owner has notifySystem off. Fire-and-forget; never blocks the
// response.
function notifyOwnerOfCollabAction(req, verb, taskText) {
  if (!req.collab) return;
  const ownerId = req.acting.id;
  const collabName = req.collab.name || req.collab.email || 'Your collaborator';
  const text = (taskText || '').toString().slice(0, 120);
  (async () => {
    try {
      const owner = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { id: true, notifySystem: true },
      });
      if (!owner || owner.notifySystem === false) return;
      await pushModule.sendPushToUser(owner.id, {
        title: `${collabName} ${verb} a task`,
        body:  text || ' ',
        url:   '/',
        tag:   'collab-action',
      });
    } catch (e) { console.warn('[collab/push]', e.message); }
  })();
}

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
  const todayDay = parseInt(today.slice(8, 10), 10);
  for (const t of tasks) {
    if (t.recurrence) {
      let scheduled = false;
      if (t.recurrence.type === 'monthly') {
        const startDay = parseInt((t.startedAt || '').slice(8, 10), 10);
        scheduled = Number.isFinite(startDay) && startDay === todayDay;
      } else {
        const days = (t.recurrence.daysOfWeek) || [];
        scheduled = days.includes(dow);
      }
      if (scheduled) {
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

// Decide if a task with the given scheduledDate may be created / edited /
// deleted, given the day-commit lifecycle:
//   past dates  → never mutable (history is history)
//   today       → mutable only if NOT committed (planning-today mode)
//   tomorrow    → mutable only if today is committed AND today is done
//                 AND tomorrow is NOT yet committed
//   further out → never (the system only ever lets you plan one day out)
//
// Completion-only updates (done / completedDates) bypass this — see
// PATCH handler. Recurring tasks bypass too — they're habit templates,
// not entries in any single day's committed list.
async function canMutateForDate(user, scheduledDate) {
  if (!scheduledDate) return { ok: true };
  const today    = userToday(user);
  const tomorrow = userTomorrow(user);

  if (scheduledDate < today) {
    return { ok: false, reason: 'past_date', message: 'Past days are locked.' };
  }

  if (scheduledDate === today) {
    const commit = await prisma.dayCommit.findUnique({
      where: { userId_date: { userId: user.id, date: today } },
    });
    if (commit) return { ok: false, reason: 'today_committed', message: 'Today is locked.' };
    return { ok: true };
  }

  if (scheduledDate === tomorrow) {
    const todayCommit = await prisma.dayCommit.findUnique({
      where: { userId_date: { userId: user.id, date: today } },
    });
    if (!todayCommit) {
      return { ok: false, reason: 'today_not_committed', message: 'Commit today first.' };
    }
    const todayState = await todayCompletionState(user);
    if (todayState.total > 0 && !todayState.complete) {
      return { ok: false, reason: 'today_incomplete', message: 'Finish today first.' };
    }
    const tomorrowCommit = await prisma.dayCommit.findUnique({
      where: { userId_date: { userId: user.id, date: tomorrow } },
    });
    if (tomorrowCommit) {
      return { ok: false, reason: 'tomorrow_committed', message: 'Tomorrow is locked.' };
    }
    return { ok: true };
  }

  return { ok: false, reason: 'too_far_ahead', message: "Can't plan more than one day ahead." };
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
    where: { userId: req.acting.id },
    orderBy: { createdAt: 'desc' },
  });
  // Compute todayComplete from the rows we already have rather than
  // hitting the DB a second time. Used to be a separate findMany on
  // the same table — doubled per-request DB roundtrips and noticeably
  // slow for users with hundreds of tasks (especially when a
  // collaborator is viewing them on a slower mobile connection).
  res.json({
    tasks: rows.map(shape),
    today: userToday(req.acting),
    tomorrow: userTomorrow(req.acting),
    todayComplete: todayCompletionStateFromTasks(req.acting, rows).complete,
    overrideActive: isOverrideActive(req.acting),
  });
});

router.post('/', async (req, res) => {
  const { text, startedAt, recurrence, trackStreak, category, scheduledDate, scheduledTime, notes } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'text required' });

  const isRecurring = !!recurrence;
  const date = scheduledDate || (isRecurring ? null : userToday(req.acting));

  // Recurring tasks are permanent habit templates, not entries in any single
  // day's committed list — so they bypass the day-lock entirely.
  // One-shot tasks must pass the lock check on their scheduled date.
  if (!isRecurring) {
    const guard = await canMutateForDate(req.acting, date);
    if (!guard.ok) return rejectLocked(res, guard);
  }

  const isDaily = recurrence && recurrence.type === 'daily';
  const wantsTrackStreak = !!(isDaily && trackStreak);
  // Cap free users at FREE_TRACKED_HABIT_CAP tracked daily habits.
  // Note: cap applies to req.acting (the OWNER of the task), not the
  // signed-in actor — a collaborator working on a Premium owner's
  // list inherits the owner's unlimited cap.
  if (wantsTrackStreak && !req.acting.isPremium) {
    const count = await trackedHabitCount(req.acting.id);
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
      userId: req.acting.id,
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
  notifyOwnerOfCollabAction(req, 'added', task.text);
  res.json({ task: shape(task) });
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.acting.id) return res.status(404).json({ error: 'not found' });

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
    const date = existing.scheduledDate || userToday(req.acting);
    const guard = await canMutateForDate(req.acting, date);
    if (!guard.ok) return rejectLocked(res, guard);
  }

  // Free-tier cap on tracked habits, applied when this PATCH would
  // FLIP the field from false→true. Skip when it's already on (no
  // delta) or when the owner is Premium.
  if (
    Object.prototype.hasOwnProperty.call(data, 'trackStreak')
    && data.trackStreak === true
    && existing.trackStreak !== true
    && !req.acting.isPremium
  ) {
    const count = await trackedHabitCount(req.acting.id);
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
  // Suppress the owner-notify ping for completion-only updates: the
  // collaborator just ticking off a task isn't something the owner
  // needs a push about. Anything else (text edit, schedule change,
  // category change, recurrence edit) does fire.
  if (!onlyCompletionFields) notifyOwnerOfCollabAction(req, 'edited', task.text);
  res.json({ task: shape(task) });
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.acting.id) return res.status(404).json({ error: 'not found' });

  // Recurring tasks can always be deleted — they're not part of the daily lock.
  if (!existing.recurrence) {
    const date = existing.scheduledDate || userToday(req.acting);
    const guard = await canMutateForDate(req.acting, date);
    if (!guard.ok) return rejectLocked(res, guard);
  }

  await prisma.task.delete({ where: { id } });
  notifyOwnerOfCollabAction(req, 'removed', existing.text);
  res.json({ ok: true });
});

// One-shot import from a brand-new user's localStorage.
router.post('/import', async (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks array required' });

  const existingCount = await prisma.task.count({ where: { userId: req.acting.id } });
  if (existingCount > 0) return res.status(409).json({ error: 'tasks already exist' });

  const today = userToday(req.acting);
  const rows = await prisma.$transaction(tasks.map((t) => prisma.task.create({
    data: {
      userId: req.acting.id,
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
    const today = userToday(req.acting);
    const rows = await Promise.race([
      prisma.task.findMany({
        where: {
          userId: req.acting.id,
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
  if (!original || original.userId !== req.acting.id) return res.status(404).json({ error: 'not found' });
  if (original.recurrence) return res.status(400).json({ error: 'recurring tasks cannot be carried over' });
  if (original.done) return res.status(400).json({ error: 'task is not missed' });

  const today = userToday(req.acting);
  if (original.scheduledDate >= today) return res.status(400).json({ error: 'task is not in the past' });

  const dup = await prisma.task.create({
    data: {
      userId: req.acting.id,
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
