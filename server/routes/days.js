// Day-commit lifecycle. The new task system has four logical states for
// the Tasks tab; the SPA picks its layout based on `mode` returned here.
//
//   planning-today        → today is empty OR has tasks but no DayCommit;
//                           user can add and commit
//   today-incomplete      → today is committed and at least one task is
//                           still open; New Task button is disabled
//   planning-tomorrow     → today is committed and all done; user is
//                           planning tomorrow (might be empty or partial)
//   tomorrow-committed    → today is committed and done, tomorrow is
//                           committed; nothing to do until lockTime hits
//
// Auto-commit: if a date already in the past (date < today) has tasks
// but no DayCommit row, we lazily create one. That covers existing users
// from before this feature shipped + the night-before-planner whose
// uncommitted "tomorrow" became today via lockTime rollover.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { userToday, userTomorrow, msUntilNextLock, dateInTz } = require('../time');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
router.use(requireAuth);

// Returns the calendar date a one-shot Task lives on. Recurring tasks
// have no scheduledDate — they're not "for a specific day" in the same
// sense; their commit status is implicit (they auto-appear daily).
function taskDate(task) {
  return task.scheduledDate || null;
}

// Counts of one-shot scheduled-for-date tasks (total + done). Recurring
// tasks contribute via completedDates: for the given date, scheduled =
// (does the recurrence touch that date?), completed = (did they tick it?).
// We mirror the SPA's own aggregation logic: see countTaskInRange there.
function recurringHitsDate(task, dayISO) {
  if (!task.recurrence) return false;
  const r = task.recurrence;
  if (r.endsBefore && dayISO >= r.endsBefore) return false;
  const created = (task.createdAt instanceof Date ? task.createdAt : new Date(task.createdAt));
  const createdISO = `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, '0')}-${String(created.getUTCDate()).padStart(2, '0')}`;
  if (createdISO > dayISO) return false;
  if (r.type === 'monthly') {
    const startDay = parseInt((task.startedAt || '').slice(8, 10), 10);
    const dayPart  = parseInt(dayISO.slice(8, 10), 10);
    return Number.isFinite(startDay) && startDay === dayPart;
  }
  const dow = new Date(`${dayISO}T00:00:00Z`).getUTCDay();
  const days = r.daysOfWeek || [];
  return days.includes(dow);
}

function isRecurringDoneOn(task, dayISO) {
  return Array.isArray(task.completedDates) && task.completedDates.includes(dayISO);
}

// Returns { total, done } for the given date. Aggregates one-shot
// tasks (scheduledDate match) + recurring tasks (recurrence hits date).
function countForDate(allTasks, dayISO) {
  let total = 0, done = 0;
  for (const t of allTasks) {
    if (!t.recurrence) {
      if (t.scheduledDate === dayISO) {
        total++;
        if (t.done) done++;
      }
    } else {
      if (recurringHitsDate(t, dayISO)) {
        // Skip explicit skip markers stored as "skip:YYYY-MM-DD".
        const cd = t.completedDates || [];
        if (cd.includes('skip:' + dayISO)) continue;
        total++;
        if (isRecurringDoneOn(t, dayISO)) done++;
      }
    }
  }
  return { total, done };
}

// Backfill: any past date with tasks but no DayCommit gets one created
// retroactively. Idempotent — repeated runs are no-ops once rows exist.
async function autoCommitPastDates(userId, today) {
  // Distinct past scheduledDates with at least one one-shot task.
  const distinctDates = await prisma.task.findMany({
    where: { userId, scheduledDate: { lt: today, not: null } },
    distinct: ['scheduledDate'],
    select: { scheduledDate: true },
  });
  const dates = distinctDates.map(d => d.scheduledDate).filter(Boolean);
  if (dates.length === 0) return;
  const existing = await prisma.dayCommit.findMany({
    where: { userId, date: { in: dates } },
    select: { date: true },
  });
  const have = new Set(existing.map(e => e.date));
  const missing = dates.filter(d => !have.has(d));
  if (!missing.length) return;
  // createMany skipDuplicates so a race with another request doesn't 500.
  await prisma.dayCommit.createMany({
    data: missing.map((date) => ({ userId, date })),
    skipDuplicates: true,
  });
}

// GET /api/days/state — drives the Tasks tab's mode. Returns enough for
// the SPA to render the right view + countdown without recomputing
// lockTime/TZ math client-side.
router.get('/state', wrap(async (req, res) => {
  const me = req.user;
  const today = userToday(me);
  const tomorrow = userTomorrow(me);

  // Lazy-backfill committed status for any past date with tasks. Cheap
  // — once it's done for a user it's a no-op forever.
  await autoCommitPastDates(me.id, today);

  // Pull all tasks once (small per-user cost) for total/done aggregation.
  const allTasks = await prisma.task.findMany({
    where: { userId: me.id },
    select: {
      id: true, recurrence: true, scheduledDate: true, done: true,
      completedDates: true, createdAt: true, startedAt: true,
    },
  });

  const todayCounts    = countForDate(allTasks, today);
  const tomorrowCounts = countForDate(allTasks, tomorrow);

  // Was today/tomorrow ever explicitly committed?
  const commits = await prisma.dayCommit.findMany({
    where: { userId: me.id, date: { in: [today, tomorrow] } },
    select: { date: true },
  });
  const committedSet = new Set(commits.map(c => c.date));
  let todayCommitted = committedSet.has(today);
  const tomorrowCommitted = committedSet.has(tomorrow);

  // Edge case: today has tasks but no DayCommit, AND those tasks were
  // created on a previous calendar day in the user's TZ. That means
  // they were planned as "tomorrow" before the most recent lockTime
  // rolled. Per the agreed rule (auto-commit if list non-empty when
  // lockTime hits), commit them now.
  if (!todayCommitted && todayCounts.total > 0) {
    const todayOneShots = allTasks.filter(t => !t.recurrence && t.scheduledDate === today);
    const anyPlannedAhead = todayOneShots.some((t) => {
      const created = t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt);
      return dateInTz(created, me.timezone || 'UTC') !== today;
    });
    if (anyPlannedAhead) {
      await prisma.dayCommit.create({ data: { userId: me.id, date: today } }).catch(() => {});
      todayCommitted = true;
    }
  }

  const todayDone     = todayCounts.total > 0 && todayCounts.done >= todayCounts.total;
  const todayRemaining = Math.max(0, todayCounts.total - todayCounts.done);

  // Mode resolution. See top-of-file comment for the four states.
  let mode;
  if (!todayCommitted)                                        mode = 'planning-today';
  else if (!todayDone)                                        mode = 'today-incomplete';
  else if (todayDone && tomorrowCommitted)                    mode = 'tomorrow-committed';
  else /* todayDone && !tomorrowCommitted */                  mode = 'planning-tomorrow';

  res.json({
    mode,
    today,
    tomorrow,
    todayCommitted,
    todayCount: todayCounts.total,
    todayDoneCount: todayCounts.done,
    todayRemaining,
    todayDone,
    tomorrowCommitted,
    tomorrowCount: tomorrowCounts.total,
    msUntilNextLock: msUntilNextLock(me),
    lockTime: me.lockTime || '00:00',
  });
}));

// POST /api/days/:date/commit — explicit commit. Date must be today or
// tomorrow; can't commit past dates (already implicitly committed) or
// dates further out (the system only ever lets you plan one day ahead).
router.post('/:date/commit', wrap(async (req, res) => {
  const me = req.user;
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid_date' });
  }
  const today = userToday(me);
  const tomorrow = userTomorrow(me);
  if (date !== today && date !== tomorrow) {
    return res.status(400).json({ error: 'date_out_of_range' });
  }
  await prisma.dayCommit.upsert({
    where: { userId_date: { userId: me.id, date } },
    update: {}, // no-op on re-commit
    create: { userId: me.id, date },
  });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.autoCommitPastDates = autoCommitPastDates;
