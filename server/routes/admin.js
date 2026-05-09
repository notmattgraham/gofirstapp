// Admin / developer dashboard. Hidden URL at /admin in the SPA layer; this
// router holds the JSON endpoints. Every request must come from the single
// allow-listed admin email — anyone else gets a 404 (not 403, so the
// existence of the dashboard isn't even acknowledged to other accounts).

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const { dateInTz } = require('../time');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();
// Coach status is purely DB-driven — promote via the role picker in /dev.

// Wrap async handlers so any thrown error reaches Express's error middleware
// (returning a 500) instead of becoming an unhandledRejection that crashes
// the dyno. Every async handler in this file MUST go through this.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();
router.use(requireAuth);

// Access gate. 404 (not 403) so the route is invisible to outsiders.
// Allowed: the admin (DB flag or env-email fallback) OR the coach (DB
// flag only). Admin and coach are distinct roles; both can hit /dev.
router.use((req, res, next) => {
  if (!req.user) return res.status(404).json({ error: 'not_found' });
  const email = (req.user.email || '').toLowerCase();
  const isAdmin = !!req.user.isAdmin || email === ADMIN_EMAIL;
  const isCoach = !!req.user.isCoach;
  if (!isAdmin && !isCoach) return res.status(404).json({ error: 'not_found' });
  next();
});

// Helper: is the given user the app-wide admin? DB flag wins, env email
// is the bootstrap fallback (mirrors how isCoach works).
function isAdmin(user) {
  if (!user) return false;
  return !!user.isAdmin || (user.email || '').toLowerCase() === ADMIN_EMAIL;
}

// "Am I admin?" — used by the dashboard UI to show/hide itself before
// kicking off the heavier data calls. Reports the caller's specific role
// so the dashboard can hide admin-only sections (Broadcast, Delete) from
// the coach.
router.get('/me', (req, res) => {
  res.json({
    admin: true,
    email: req.user.email,
    name: req.user.name,
    isAdmin: isAdmin(req.user),
  });
});

// Helper: walk a task across the whole window since createdAt and tally
// scheduled vs completed days. Mirrors the logic the frontend uses for
// per-user analytics, but server-side so the dashboard can show one number.
function taskCounts(t) {
  const completedDates = Array.isArray(t.completedDates) ? t.completedDates : [];
  if (!t.recurrence) {
    // One-shots: scheduled = 1 if it has a scheduledDate, completed = 1 if done.
    if (!t.scheduledDate) return { scheduled: 0, completed: 0 };
    return { scheduled: 1, completed: t.done ? 1 : 0 };
  }
  // Recurring: count days-of-week from createdAt to "today" (server UTC date is
  // close enough for an aggregate dashboard — exact per-user TZ isn't worth the
  // cost when we're just rolling up across all users).
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

// Collapse a list of tasks into top-line numbers for one user.
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

// GET /api/admin/stats — aggregate numbers for the whole app.
router.get('/stats', wrap(async (_req, res) => {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = new Date(now.getTime() - 30 * day);

  const [userCount, paidCount, activeUserIds30, allUsers] = await Promise.all([
    prisma.user.count(),
    // "Paid" = anyone on the coaching subscription (coachingClient flag).
    prisma.user.count({ where: { coachingClient: true } }),
    // "Active" = created a task in the last 30 days. Distinct user ids.
    prisma.task.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    // Per-user execution rate, computed via summarizeTasks for consistency
    // with the per-row column. Pulling task fields once and bucketing in JS.
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

  // App-wide execution rate = average of per-user rates (equal weight per
  // user). Users who have no scheduled tasks are excluded so a freshly
  // created account doesn't drag the average to 0.
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
      paid: paidCount,
    },
    appExecutionRate,
    serverDate: dateInTz(now, 'UTC'),
  });
}));

// GET /api/admin/users — list every user with light per-user rollups.
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
      overridesUsed: u.overridesUsed,
      coachingClient: u.coachingClient,
      isCoach: u.isCoach,
      isAdmin: u.isAdmin,
      taskCount: summary.totalTasks,
      streakCount: u.quitStreaks.length,
      executionRate: summary.executionRate,
      scheduled: summary.scheduled,
      completed: summary.completed,
    };
  });

  res.json({ users: rows });
}));

// PATCH /api/admin/users/:id/coaching — toggle coachingClient for a user.
// Body: { coachingClient: boolean }
router.patch('/users/:id/coaching', wrap(async (req, res) => {
  const { coachingClient } = req.body || {};
  if (typeof coachingClient !== 'boolean') {
    return res.status(400).json({ error: 'coachingClient_required' });
  }
  try {
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { coachingClient },
      select: { id: true, email: true, name: true, coachingClient: true },
    });
    res.json({ user: updated });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

// PATCH /api/admin/users/:id/overrides — adjust a user's monthly override
// quota usage. Body: { overridesUsed: number } (clamped 0..3 — same cap
// as the per-user runtime). Lets the admin reset (0), bump (++), or
// claw back (--) overrides without the user having to wait out the
// monthly window.
router.patch('/users/:id/overrides', wrap(async (req, res) => {
  const raw = req.body && req.body.overridesUsed;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return res.status(400).json({ error: 'overridesUsed_required' });
  }
  const clamped = Math.max(0, Math.min(3, Math.floor(raw)));
  try {
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        overridesUsed: clamped,
        // Reset the monthly window when admin sets to 0 so the next
        // organic monthly rollover doesn't immediately reset again.
        ...(clamped === 0 ? { overrideMonthStart: new Date() } : {}),
      },
      select: { id: true, email: true, name: true, overridesUsed: true, overrideMonthStart: true },
    });
    res.json({ user: updated });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

// PATCH /api/admin/users/:id/role — set a user's role.
// Body: { role: 'user' | 'client' | 'coach' | 'admin' }
//   user   → coachingClient=false, isCoach=false, isAdmin=false
//   client → coachingClient=true,  isCoach=false, isAdmin=false
//   coach  → coachingClient=false, isCoach=true,  isAdmin=false  (demote any other coach)
//   admin  → coachingClient=false, isCoach=false, isAdmin=true   (demote any other admin)
// Only the admin can promote anyone TO admin (the coach has dashboard
// access but can't grant the admin role).
router.patch('/users/:id/role', wrap(async (req, res) => {
  const role = (req.body && req.body.role) || '';
  if (!['user', 'client', 'coach', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  if (role === 'admin' && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'admin_only' });
  }
  try {
    if (role === 'coach') {
      // Only one coach at a time — demote anyone else flagged.
      await prisma.user.updateMany({
        where: { isCoach: true, NOT: { id: req.params.id } },
        data: { isCoach: false },
      });
    }
    if (role === 'admin') {
      // Only one admin at a time — demote anyone else flagged.
      await prisma.user.updateMany({
        where: { isAdmin: true, NOT: { id: req.params.id } },
        data: { isAdmin: false },
      });
    }
    const data = role === 'admin'
      ? { coachingClient: false, isCoach: false, isAdmin: true }
      : role === 'coach'
        ? { coachingClient: false, isCoach: true, isAdmin: false }
        : role === 'client'
          ? { coachingClient: true, isCoach: false, isAdmin: false }
          : { coachingClient: false, isCoach: false, isAdmin: false };
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, email: true, name: true, coachingClient: true, isCoach: true, isAdmin: true },
    });
    res.json({ user: updated });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

// DELETE /api/admin/users/:id — hard delete. Cascades through tasks,
// streaks, messages, and friendships per the schema's onDelete: Cascade.
// Admin-only; refuses to delete the calling admin.
router.delete('/users/:id', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin_only' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
}));

// POST /api/admin/broadcast — admin-only mass DM. Body: { content, attachment? }.
// Creates one Message per non-admin user with hiddenFromAdminAt stamped at
// creation time so the admin's inbox does not get flooded with N empty
// threads. A thread surfaces in the admin inbox only when the recipient
// replies (creating a row with hiddenFromAdminAt = null).
const MAX_BROADCAST_RECIPIENTS = 5000;
const BROADCAST_MAX_LENGTH = 4000;
const BROADCAST_MAX_ATTACHMENT = 4 * 1024 * 1024; // 4MB base64
const BROADCAST_ATTACHMENT_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

router.post('/broadcast', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'admin_only' });
  const { content, attachment } = req.body || {};
  const trimmed = typeof content === 'string' ? content.trim() : '';
  const hasAttachment = typeof attachment === 'string' && attachment.length > 0;
  if (!trimmed && !hasAttachment) return res.status(400).json({ error: 'content_required' });
  if (trimmed.length > BROADCAST_MAX_LENGTH) return res.status(400).json({ error: 'content_too_long' });
  if (hasAttachment) {
    if (attachment.length > BROADCAST_MAX_ATTACHMENT) return res.status(413).json({ error: 'attachment_too_large' });
    if (!BROADCAST_ATTACHMENT_RE.test(attachment)) return res.status(400).json({ error: 'invalid_attachment' });
  }

  const recipients = await prisma.user.findMany({
    where: { id: { not: req.user.id } },
    select: { id: true },
  });
  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    return res.status(413).json({ error: 'too_many_recipients', count: recipients.length });
  }
  if (recipients.length === 0) return res.json({ sent: 0 });

  const now = new Date();
  // createMany doesn't return ids, but we don't need them — websocket pushes
  // use a prebuilt payload below. Hidden-from-admin so threads only surface
  // when recipients reply.
  await prisma.message.createMany({
    data: recipients.map((r) => ({
      fromUserId: req.user.id,
      toUserId: r.id,
      content: trimmed,
      attachment: hasAttachment ? attachment : null,
      hiddenFromAdminAt: now,
      createdAt: now,
    })),
  });

  // Real-time push to whoever's online. Best-effort; offline recipients pick
  // it up the next time they hit GET /api/messages/dm/<admin-id>.
  if (typeof global.wsBroadcast === 'function') {
    for (const r of recipients) {
      global.wsBroadcast(r.id, {
        type: 'message',
        message: {
          fromUserId: req.user.id,
          toUserId: r.id,
          content: trimmed,
          attachment: hasAttachment ? attachment : null,
          readAt: null,
          createdAt: now.toISOString(),
        },
      });
    }
  }

  res.json({ sent: recipients.length });
}));

// GET /api/admin/coaching-clients — every flagged client with full drill-down.
// One bundled call so the dashboard can render the coaching section without
// firing off a per-client request for each one.
router.get('/coaching-clients', wrap(async (_req, res) => {
  const clients = await prisma.user.findMany({
    where: { coachingClient: true },
    orderBy: { createdAt: 'desc' },
    include: {
      tasks: { orderBy: { createdAt: 'desc' } },
      quitStreaks: { orderBy: { createdAt: 'desc' } },
    },
  });

  const payload = clients.map((u) => {
    const summary = summarizeTasks(u.tasks);
    return {
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        picture: u.picture,
        timezone: u.timezone,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        overridesUsed: u.overridesUsed,
        overrideActiveDate: u.overrideActiveDate,
        coachingClient: u.coachingClient,
      },
      summary,
      tasks: u.tasks.map((t) => ({
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
      streaks: u.quitStreaks.map((s) => ({
        id: s.id,
        name: s.name,
        startAt: s.startAt,
        createdAt: s.createdAt,
      })),
    };
  });

  res.json({ clients: payload });
}));

// GET /api/admin/users/:id — full per-user picture: tasks, streaks, analytics.
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
      overridesUsed: user.overridesUsed,
      overrideMonthStart: user.overrideMonthStart,
      overrideActiveDate: user.overrideActiveDate,
      coachingClient: user.coachingClient,
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
