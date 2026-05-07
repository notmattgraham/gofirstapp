// Social graph: friend search, friend requests, friends list, friends inbox.
// All endpoints require auth. Real names only — no @handles. Direction
// matters at request time (fromUser asked toUser) but stops mattering once
// the row flips to 'accepted'; either side can DM the other or unfriend.

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware');

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
  };
}

// Helper: find the "other" user in a Friendship row (the one that isn't `meId`).
function otherSide(meId, row) {
  return row.fromUserId === meId ? row.toUser : row.fromUser;
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
      fromUser: { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true } },
      toUser:   { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true } },
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
        { name:  { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
      // Skip placeholder accounts that never set a name.
      name: { not: null },
    },
    select: { id: true, name: true, email: true, picture: true, lastSeenAt: true },
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
    return res.status(200).json({ friendshipId: accepted.id, status: 'accepted', autoAccepted: true });
  }

  const created = await prisma.friendship.create({
    data: { fromUserId: me.id, toUserId, status: 'pending' },
  });
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
      fromUser: { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true } },
      toUser:   { select: { id: true, name: true, email: true, picture: true, lastSeenAt: true } },
    },
  });
  const friends = friendRows.map(r => otherSide(me.id, r));
  if (friends.length === 0) return res.json({ threads: [] });

  // For each friend, latest message in either direction + my unread count.
  const threads = await Promise.all(friends.map(async (friend) => {
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
    return { user: shapeUser(friend), latest, unread };
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
      recurrence: true, createdAt: true,
    },
  });

  // ---- Date helpers (UTC, matching the rest of the server) ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`; }
  function addDaysISO(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return toISO(dt);
  }
  const today = new Date();
  const todayISO = toISO(today);

  // Mirrors the frontend's countTaskInRange for a single day.
  function countOnDay(t, dayISO) {
    if (dayISO > todayISO) return { scheduled: 0, completed: 0 };
    const createdISO = toISO(new Date(t.createdAt));
    if (!t.recurrence) {
      if (createdISO === dayISO) return { scheduled: 1, completed: t.done ? 1 : 0 };
      return { scheduled: 0, completed: 0 };
    }
    if (createdISO > dayISO) return { scheduled: 0, completed: 0 };
    if (t.recurrence.endsBefore && dayISO >= t.recurrence.endsBefore) return { scheduled: 0, completed: 0 };
    const days = t.recurrence.daysOfWeek || [];
    if (!days.length) return { scheduled: 0, completed: 0 };
    const [y, m, d] = dayISO.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!days.includes(dow)) return { scheduled: 0, completed: 0 };
    const cd = t.completedDates || [];
    if (cd.includes('skip:' + dayISO)) return { scheduled: 0, completed: 0 };
    return { scheduled: 1, completed: cd.includes(dayISO) ? 1 : 0 };
  }
  function dayRate(dayISO) {
    let s = 0, c = 0;
    for (const t of tasks) { const r = countOnDay(t, dayISO); s += r.scheduled; c += r.completed; }
    return s === 0 ? null : Math.round((c / s) * 100);
  }

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
      rate: dayRate(iso),
    };
  });

  res.json({ todayISO, todayRate: dayRate(todayISO), weekDays });
}));

module.exports = router;
module.exports.areFriendsServer = areFriendsServer;
