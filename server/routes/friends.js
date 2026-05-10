// Social graph: friend search, friend requests, friends list, friends inbox.
// All endpoints require auth. Real names only — no @handles. Direction
// matters at request time (fromUser asked toUser) but stops mattering once
// the row flips to 'accepted'; either side can DM the other or unfriend.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');
const pushModule = require('./push');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();
router.use(requireAuth);

// Public-shape user record returned by every friends endpoint.
// Email is intentionally excluded — only the user themselves (via
// /api/auth/me) and the admin (/api/admin/users) ever see it.
function shapeUser(u) {
  return {
    id: u.id,
    name: u.name,
    picture: u.picture,
    lastSeenAt: u.lastSeenAt,
    // Free-form "where I live" string. Public — every authenticated user
    // can see this on search results and friend rows.
    location: u.location || null,
  };
}

// Helper: find the "other" user in a Friendship row (the one that isn't `meId`).
function otherSide(meId, row) {
  return row.fromUserId === meId ? row.toUser : row.fromUser;
}

// ─── Date + task aggregation helpers ─────────────────────────
// All math uses UTC dates. Cross-TZ skew is at most a few hours per
// day boundary, which is acceptable for "today's exec rate" / streak
// at-a-glance. Per-user TZ math can come later if needed.
function pad2(n) { return String(n).padStart(2, '0'); }
function utcISO(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return utcISO(dt);
}

// Mirror of the frontend's countTaskInRange but for a single (task, day).
function countTaskOnDay(t, dayISO, todayISO) {
  if (dayISO > todayISO) return { scheduled: 0, completed: 0 };
  const createdISO = utcISO(new Date(t.createdAt));
  if (!t.recurrence) {
    // One-shots are scheduled on their committed day (scheduledDate),
    // not the day they were created. Falls back to createdISO for legacy
    // rows that predate scheduledDate.
    const onISO = t.scheduledDate || createdISO;
    if (onISO === dayISO) return { scheduled: 1, completed: t.done ? 1 : 0 };
    return { scheduled: 0, completed: 0 };
  }
  if (createdISO > dayISO) return { scheduled: 0, completed: 0 };
  if (t.recurrence.endsBefore && dayISO >= t.recurrence.endsBefore) return { scheduled: 0, completed: 0 };
  const cd = t.completedDates || [];
  if (cd.includes('skip:' + dayISO)) return { scheduled: 0, completed: 0 };
  if (t.recurrence.type === 'monthly') {
    const startDay = parseInt((t.startedAt || '').slice(8, 10), 10);
    const dayPart  = parseInt(dayISO.slice(8, 10), 10);
    if (!Number.isFinite(startDay) || startDay !== dayPart) return { scheduled: 0, completed: 0 };
    return { scheduled: 1, completed: cd.includes(dayISO) ? 1 : 0 };
  }
  const days = t.recurrence.daysOfWeek || [];
  if (!days.length) return { scheduled: 0, completed: 0 };
  const [y, m, d] = dayISO.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (!days.includes(dow)) return { scheduled: 0, completed: 0 };
  return { scheduled: 1, completed: cd.includes(dayISO) ? 1 : 0 };
}

function dayRateFromTasks(tasks, dayISO, todayISO) {
  let s = 0, c = 0;
  for (const t of tasks) {
    const r = countTaskOnDay(t, dayISO, todayISO);
    s += r.scheduled; c += r.completed;
  }
  return s === 0 ? null : Math.round((c / s) * 100);
}

/* Consecutive days at 100% execution, walking backwards from today.
   Mid-day grace: if today is in progress (rate < 100), the streak
   walks back from yesterday so the user isn't penalized before
   midnight. Days with no scheduled tasks are skipped without
   breaking the streak. Capped at 365 to stop a malformed dataset
   from spinning the loop. */
function executionStreakFromTasks(tasks, todayISO) {
  let cursor = todayISO;
  const todayRate = dayRateFromTasks(tasks, todayISO, todayISO);
  let streak = 0;
  if (todayRate === 100) { streak = 1; cursor = addDaysISO(cursor, -1); }
  else                   { cursor = addDaysISO(cursor, -1); }
  for (let i = 0; i < 365; i++) {
    const r = dayRateFromTasks(tasks, cursor, todayISO);
    if (r === null) { cursor = addDaysISO(cursor, -1); continue; }
    if (r === 100)  { streak++; cursor = addDaysISO(cursor, -1); }
    else            { break; }
  }
  return streak;
}

// True iff the two users are accepted friends in either direction.
async function areFriendsServer(a, b) {
  if (a === b) return false;
  const f = await prisma.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { fromUserId: a, toUserId: b },
        { fromUserId: b, toUserId: a },
      ],
    },
    select: { id: true },
  });
  return !!f;
}

// GET /api/friends — { friends, incoming, outgoing }.
//   friends  — accepted on either side (the other party in each row)
//   incoming — pending where I'm the toUser (someone asked me)
//   outgoing — pending where I'm the fromUser (I asked someone)
router.get('/', wrap(async (req, res) => {
  const me = req.user;
  const rows = await prisma.friendship.findMany({
    where: {
      OR: [
        { fromUserId: me.id },
        { toUserId: me.id },
      ],
    },
    include: {
      fromUser: { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true, location: true } },
      toUser:   { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true, location: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const friends  = [];
  const incoming = [];
  const outgoing = [];
  for (const r of rows) {
    const other = otherSide(me.id, r);
    if (r.status === 'accepted') {
      friends.push({ friendshipId: r.id, since: r.acceptedAt, user: shapeUser(other) });
    } else if (r.status === 'pending') {
      if (r.toUserId === me.id) incoming.push({ friendshipId: r.id, requestedAt: r.createdAt, user: shapeUser(other) });
      else                       outgoing.push({ friendshipId: r.id, requestedAt: r.createdAt, user: shapeUser(other) });
    }
  }
  res.json({ friends, incoming, outgoing });
}));

// GET /api/friends/search?q= — find people by display name (case-insensitive).
// Excludes the current user, anyone who already has a friendship row with
// the user (any status), and the coach (coaching is a paid relationship,
// not a friend one).
router.get('/search', wrap(async (req, res) => {
  const q = String((req.query && req.query.q) || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const me = req.user;

  // Existing friendships in either direction — exclude all of them.
  const existing = await prisma.friendship.findMany({
    where: { OR: [{ fromUserId: me.id }, { toUserId: me.id }] },
    select: { fromUserId: true, toUserId: true },
  });
  const excludeIds = new Set([me.id]);
  existing.forEach(f => { excludeIds.add(f.fromUserId); excludeIds.add(f.toUserId); });

  const users = await prisma.user.findMany({
    where: {
      id: { notIn: [...excludeIds] },
      OR: [
        { name:     { contains: q, mode: 'insensitive' } },
        { email:    { contains: q, mode: 'insensitive' } },
        // Match the user's free-form "where I live" string too so the
        // same search box doubles as a "find people in my area" filter
        // — typing "austin" surfaces every user whose location contains
        // it. Two-char minimum keeps single-letter typos from returning
        // half the user base.
        { location: { contains: q, mode: 'insensitive' } },
      ],
      // Skip placeholder accounts that never set a name.
      name: { not: null },
    },
    select: { id: true, name: true, email: true, picture: true, lastSeenAt: true, location: true },
    take: 12,
    orderBy: { name: 'asc' },
  });
  res.json({ users: users.map(shapeUser) });
}));

// POST /api/friends/request — body: { toUserId }
// Creates a pending row from me → target. Idempotent if a pending request
// already exists in that direction; if a pending row exists the OTHER way
// (the target asked me first), this auto-accepts instead.
router.post('/request', wrap(async (req, res) => {
  const me = req.user;
  const { toUserId } = req.body || {};
  if (!toUserId || typeof toUserId !== 'string') return res.status(400).json({ error: 'toUserId_required' });
  if (toUserId === me.id) return res.status(400).json({ error: 'cannot_friend_self' });

  const target = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true } });
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  // Look up any existing relationship in either direction.
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { fromUserId: me.id, toUserId },
        { fromUserId: toUserId, toUserId: me.id },
      ],
    },
  });

  if (existing) {
    if (existing.status === 'accepted') {
      return res.status(409).json({ error: 'already_friends', friendshipId: existing.id });
    }
    if (existing.fromUserId === me.id) {
      return res.status(409).json({ error: 'already_requested', friendshipId: existing.id });
    }
    // The target already asked me — auto-accept.
    const accepted = await prisma.friendship.update({
      where: { id: existing.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    });
    // Original requester gets a push: their pending request just turned
    // into an accepted friendship.
    (async () => {
      try {
        const requester = await prisma.user.findUnique({
          where: { id: existing.fromUserId },
          select: { id: true, notifyFriends: true },
        });
        await pushModule.pushForFriendAccepted({
          accepterUser: { id: me.id, name: me.name },
          requesterUser: requester,
        });
      } catch (e) { console.warn('[push/friend-accepted-auto] failed', e.message); }
    })();
    return res.status(200).json({ friendshipId: accepted.id, status: 'accepted', autoAccepted: true });
  }

  const created = await prisma.friendship.create({
    data: { fromUserId: me.id, toUserId, status: 'pending' },
  });
  // Push the recipient — they have a pending request waiting.
  (async () => {
    try {
      const target = await prisma.user.findUnique({
        where: { id: toUserId },
        select: { id: true, notifyFriends: true },
      });
      await pushModule.pushForFriendRequest({
        requesterUser: { id: me.id, name: me.name },
        targetUser: target,
      });
    } catch (e) { console.warn('[push/friend-request] failed', e.message); }
  })();
  res.status(201).json({ friendshipId: created.id, status: 'pending' });
}));

// POST /api/friends/accept/:id — accept a pending request where I'm the toUser.
router.post('/accept/:id', wrap(async (req, res) => {
  const me = req.user;
  const row = await prisma.friendship.findUnique({ where: { id: req.params.id } });
  if (!row || row.toUserId !== me.id) return res.status(404).json({ error: 'not_found' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
  const updated = await prisma.friendship.update({
    where: { id: row.id },
    data: { status: 'accepted', acceptedAt: new Date() },
  });
  // Notify the original requester that their request was accepted.
  (async () => {
    try {
      const requester = await prisma.user.findUnique({
        where: { id: row.fromUserId },
        select: { id: true, notifyFriends: true },
      });
      await pushModule.pushForFriendAccepted({
        accepterUser: { id: me.id, name: me.name },
        requesterUser: requester,
      });
    } catch (e) { console.warn('[push/friend-accepted] failed', e.message); }
  })();
  res.json({ friendshipId: updated.id, status: 'accepted' });
}));

// DELETE /api/friends/:id — works for: declining an incoming request,
// cancelling an outgoing request, or unfriending. Either side may delete.
router.delete('/:id', wrap(async (req, res) => {
  const me = req.user;
  const row = await prisma.friendship.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.fromUserId !== me.id && row.toUserId !== me.id) {
    return res.status(404).json({ error: 'not_found' });
  }
  await prisma.friendship.delete({ where: { id: row.id } });
  res.json({ ok: true });
}));

// GET /api/friends/threads — list of accepted friends with last message
// preview + unread count, sorted newest-first. Drives the friends inbox
// in the chat tab (mirrors the coach inbox shape).
router.get('/threads', wrap(async (req, res) => {
  const me = req.user;
  const friendRows = await prisma.friendship.findMany({
    where: { status: 'accepted', OR: [{ fromUserId: me.id }, { toUserId: me.id }] },
    include: {
      fromUser: { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true, location: true } },
      toUser:   { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true, location: true } },
    },
  });
  if (friendRows.length === 0) return res.json({ threads: [] });

  // Bulk-load tasks for every friend in one query, then bucket per-user
  // so we can compute today's exec rate + execution streak without an
  // N-times round-trip to the DB.
  const friendIds = friendRows.map(r => otherSide(me.id, r).id);
  const allTasks = await prisma.task.findMany({
    where: { userId: { in: friendIds } },
    select: {
      userId: true, scheduledDate: true, done: true,
      completedDates: true, recurrence: true, createdAt: true,
      startedAt: true,
    },
  });
  const tasksByUser = {};
  for (const t of allTasks) {
    if (!tasksByUser[t.userId]) tasksByUser[t.userId] = [];
    tasksByUser[t.userId].push(t);
  }
  const todayISO = utcISO(new Date());

  // For each friend, latest message in either direction + my unread count.
  const threads = await Promise.all(friendRows.map(async (row) => {
    const friend = otherSide(me.id, row);
    const friendTasks = tasksByUser[friend.id] || [];
    const todayRate = dayRateFromTasks(friendTasks, todayISO, todayISO);
    const executionStreak = executionStreakFromTasks(friendTasks, todayISO);
    const [latestFrom, latestTo, unread] = await Promise.all([
      prisma.message.findFirst({
        where: { fromUserId: friend.id, toUserId: me.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, content: true, attachment: true, createdAt: true, readAt: true },
      }),
      prisma.message.findFirst({
        where: { fromUserId: me.id, toUserId: friend.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, content: true, attachment: true, createdAt: true },
      }),
      prisma.message.count({
        where: { fromUserId: friend.id, toUserId: me.id, readAt: null },
      }),
    ]);
    let latest = null;
    if (latestFrom && latestTo) {
      latest = latestFrom.createdAt > latestTo.createdAt
        ? { ...latestFrom, fromMe: false }
        : { ...latestTo, fromMe: true };
    } else if (latestFrom) latest = { ...latestFrom, fromMe: false };
    else if (latestTo)     latest = { ...latestTo, fromMe: true };
    return { user: shapeUser(friend), friendshipId: row.id, latest, unread, todayRate, executionStreak };
  }));

  threads.sort((a, b) => {
    const ta = a.latest ? new Date(a.latest.createdAt).getTime() : 0;
    const tb = b.latest ? new Date(b.latest.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json({ threads });
}));

// GET /api/friends/:userId/glance
// Aggregate execution data for a friend: today's exec rate + this week's
// per-day rates. NO task contents leave the server — the response only
// carries percentages and dates so a friend can see how disciplined the
// other person is being without seeing what they're actually working on.
router.get('/:userId/glance', wrap(async (req, res) => {
  const me = req.user;
  const friendId = req.params.userId;
  if (friendId === me.id) return res.status(400).json({ error: 'cannot_glance_self' });
  if (!(await areFriendsServer(me.id, friendId))) {
    return res.status(403).json({ error: 'not_friends' });
  }

  const tasks = await prisma.task.findMany({
    where: { userId: friendId },
    select: {
      scheduledDate: true, done: true, completedDates: true,
      recurrence: true, createdAt: true, startedAt: true,
    },
  });

  const today = new Date();
  const todayISO = utcISO(today);

  // Week (Sunday → Saturday) containing today.
  const dow = today.getUTCDay();
  const sunday = addDaysISO(todayISO, -dow);
  const letters = ['S','M','T','W','T','F','S'];
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const iso = addDaysISO(sunday, i);
    return {
      iso,
      letter: letters[i],
      isToday: iso === todayISO,
      isFuture: iso > todayISO,
      rate: dayRateFromTasks(tasks, iso, todayISO),
    };
  });

  res.json({
    todayISO,
    todayRate: dayRateFromTasks(tasks, todayISO, todayISO),
    executionStreak: executionStreakFromTasks(tasks, todayISO),
    weekDays,
  });
}));

module.exports = router;
module.exports.areFriendsServer = areFriendsServer;
