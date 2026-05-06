const prisma = require('./db');

function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

// Bump a user's lastSeenAt on authenticated requests, throttled per-user
// to one DB write per minute so we don't hammer Postgres on every poll.
// Fire-and-forget — never blocks the request, never rejects on error.
const _lastSeenWrites = new Map();
const SEEN_THROTTLE_MS = 60_000;

function trackLastSeen(req, _res, next) {
  const u = req.user;
  if (u && u.id) {
    const now = Date.now();
    const last = _lastSeenWrites.get(u.id) || 0;
    if (now - last > SEEN_THROTTLE_MS) {
      _lastSeenWrites.set(u.id, now);
      prisma.user.update({
        where: { id: u.id },
        data: { lastSeenAt: new Date(now) },
      }).catch(() => {});
    }
  }
  next();
}

module.exports = { requireAuth, trackLastSeen };
