// Collaboration helpers shared between routes/collaborators.js and any
// route that needs to act on someone else's data (tasks, day-commits).
//
// "Actor" terminology:
//   - req.user      — the signed-in account making the request
//   - req.acting    — set by resolveActor() when ?as=USERID is present
//                     and authorized. Holds the OWNER's user record (the
//                     Premium account whose list we're operating on).
//   - req.collab    — set ONLY when the actor differs from the owner.
//                     Holds the signed-in collaborator's user record.
//                     Routes use this to decide whether to fire a
//                     "your assistant just changed something" push to
//                     the owner.

const prisma = require('./db');

// Resolve who this request is acting AS. By default it's req.user (the
// signed-in account). When ?as=USERID is present, verify the signed-in
// user has collaborator access to that user, and act as them instead.
//
// Throws an error with .status set to the right HTTP code on failure.
async function resolveActor(req) {
  const me = req.user;
  if (!me) {
    const err = new Error('unauthenticated');
    err.status = 401;
    throw err;
  }
  const asId = (req.query && req.query.as) || null;
  if (!asId || asId === me.id) {
    req.acting = me;
    req.collab = null;
    return me;
  }
  const grant = await prisma.collaboration.findFirst({
    where: { premiumUserId: asId, collaboratorUserId: me.id },
    select: { id: true },
  });
  if (!grant) {
    const err = new Error('not_a_collaborator');
    err.status = 403;
    throw err;
  }
  // Pull the full owner record — downstream code reads timezone /
  // lockTime / etc. off it (the OWNER's settings drive their day,
  // not the collaborator's).
  const owner = await prisma.user.findUnique({ where: { id: asId } });
  if (!owner) {
    const err = new Error('owner_not_found');
    err.status = 404;
    throw err;
  }
  req.acting = owner;
  req.collab = me;
  return owner;
}

// Express middleware wrapper around resolveActor. Routes that mount it
// can rely on req.acting being set by the time the handler runs.
function attachActor(req, res, next) {
  resolveActor(req)
    .then(() => next())
    .catch((err) => {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'actor_error' });
    });
}

module.exports = { resolveActor, attachActor };
