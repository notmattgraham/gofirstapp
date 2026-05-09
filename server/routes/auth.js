const express = require('express');
const passport = require('../auth');
const prisma = require('../db');
const { userToday } = require('../time');

const router = express.Router();

// Coach status is now purely DB-driven — promote a user via the role
// picker in /dev. No more email-based fallback.
//
// The one app-wide admin still has an env-email fallback so the dashboard
// works on a fresh database before any user has been flagged.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'help@gofirstbrand.com').toLowerCase();

// Kick off Google OAuth.
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// Google redirects back here after the user approves.
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=error' }),
  (req, res) => res.redirect('/')
);

function shape(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    timezone: u.timezone,
    overridesUsed: u.overridesUsed,
    overrideActiveDate: u.overrideActiveDate,
    // Coaching fields — frontend uses these to switch tab layout + show chat.
    coachingClient: u.coachingClient || false,
    // DB flag is the source of truth. Set via /dev role picker.
    isCoach: !!u.isCoach,
    isAdmin: !!u.isAdmin || (u.email || '').toLowerCase() === ADMIN_EMAIL,
    tutorialSeen: !!u.tutorialSeen,
    onboardedAt: u.onboardedAt ? u.onboardedAt.toISOString?.() || u.onboardedAt : null,
    // Coalesce nullables defensively for users created before these
    // columns existed — Prisma returns the column as the default `true`
    // once the migration runs, but a stale shape returned mid-deploy
    // would otherwise leak `undefined` into the SPA.
    notifyMessages: u.notifyMessages !== false,
    notifyFriends:  u.notifyFriends  !== false,
    notifySystem:   u.notifySystem   !== false,
  };
}

// Who am I?  Returns { user: null } when signed out.
//
// Side effect: existing users (any task or streak in the DB) who don't
// have onboardedAt set yet get it back-filled to their createdAt. The
// commitment-onboarding ritual only fires for accounts where there's
// truly nothing yet — we don't want to ask a 6-month user to "list
// the habits you're quitting" all over again. Done lazily on the first
// /me hit after the migration so we don't need a one-shot script.
router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  let user = req.user;
  if (user.onboardedAt == null) {
    const [taskCount, streakCount] = await Promise.all([
      prisma.task.count({ where: { userId: user.id } }),
      prisma.quitStreak.count({ where: { userId: user.id } }),
    ]);
    if (taskCount + streakCount > 0) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { onboardedAt: user.createdAt || new Date() },
      });
    }
  }
  res.json({ user: shape(user) });
});

// Update the signed-in user's display name / avatar / timezone.
router.patch('/me', express.json({ limit: '2mb' }), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  const data = {};
  if (typeof req.body.name === 'string') {
    const trimmed = req.body.name.trim().slice(0, 60);
    data.name = trimmed || null;
  }
  if (typeof req.body.picture === 'string') {
    if (req.body.picture.length > 700000) {
      return res.status(413).json({ error: 'picture too large' });
    }
    const ok = /^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/)/i.test(req.body.picture);
    if (!ok && req.body.picture !== '') {
      return res.status(400).json({ error: 'invalid picture' });
    }
    data.picture = req.body.picture || null;
  }
  if (typeof req.body.timezone === 'string') {
    // Trust IANA-shaped strings only ("Region/City" or fixed names like "UTC").
    if (/^[A-Za-z_+\-/0-9]{3,60}$/.test(req.body.timezone)) data.timezone = req.body.timezone;
  }
  if (Object.keys(data).length === 0) return res.json({ user: shape(req.user) });
  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: shape(user) });
});

// POST /api/auth/tutorial-seen — flip the tutorialSeen flag once the
// user has finished or skipped the first-login welcome tour. Idempotent:
// already-true stays true; calling again is a no-op.
router.post('/tutorial-seen', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { tutorialSeen: true },
  });
  res.json({ user: shape(user) });
});

// POST /api/auth/onboarding-commit — the commitment-ritual write.
// Body: { habits: string[], tasks: string[] }
//   habits → one QuitStreak per non-empty entry (any count, capped at 20).
//   tasks  → one one-shot Task per non-empty entry, scheduled for "today"
//            in the user's timezone. At least 3 required.
// Sets User.onboardedAt = now and User.tutorialSeen = true (the
// commitment ritual replaces the explanatory tabs tour for these users).
// Idempotent on the flag — calling again with onboardedAt already set
// returns 409 without writing anything.
const ONBOARD_MAX_HABITS = 20;
const ONBOARD_MAX_TASKS  = 30;
const ONBOARD_MIN_TASKS  = 3;
const ONBOARD_MAX_TEXT   = 200;

router.post('/onboarding-commit', express.json({ limit: '64kb' }), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.onboardedAt) return res.status(409).json({ error: 'already_onboarded' });

  const cleanList = (arr, max) => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => (typeof s === 'string' ? s.trim().slice(0, ONBOARD_MAX_TEXT) : ''))
      .filter(Boolean)
      .slice(0, max);
  };
  const habits = cleanList(req.body && req.body.habits, ONBOARD_MAX_HABITS);
  const tasks  = cleanList(req.body && req.body.tasks,  ONBOARD_MAX_TASKS);
  if (tasks.length < ONBOARD_MIN_TASKS) {
    return res.status(400).json({ error: 'min_three_tasks_required' });
  }

  const today = userToday(req.user);
  // Local-time "now" for startedAt — same format the SPA uses (YYYY-MM-DDTHH:MM).
  // We don't have the user's exact wall-clock down to the minute on the
  // server, so we approximate using their TZ-localized date + 00:00. The
  // SPA will tweak this when needed; what matters is the date is correct.
  const startedAt = `${today}T00:00`;
  const now = new Date();

  // One transaction so a half-write never leaves the user partially
  // onboarded with an empty task list.
  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: req.user.id },
      data: { onboardedAt: now, tutorialSeen: true },
    }),
    ...habits.map((name) =>
      prisma.quitStreak.create({
        data: { userId: req.user.id, name, startAt: startedAt },
      })
    ),
    ...tasks.map((text) =>
      prisma.task.create({
        data: {
          userId: req.user.id,
          text,
          startedAt,
          scheduledDate: today,
        },
      })
    ),
  ]);
  res.json({ user: shape(updated), habits: habits.length, tasks: tasks.length });
});

// PATCH /api/auth/notify-prefs — flip per-event push toggles. Body may
// contain any subset of { notifyMessages, notifyFriends, notifySystem };
// missing keys are left alone. Boolean-only — anything else is a 400.
router.patch('/notify-prefs', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  const data = {};
  for (const k of ['notifyMessages', 'notifyFriends', 'notifySystem']) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
      if (typeof req.body[k] !== 'boolean') return res.status(400).json({ error: `${k}_must_be_boolean` });
      data[k] = req.body[k];
    }
  }
  if (Object.keys(data).length === 0) return res.json({ user: shape(req.user) });
  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: shape(user) });
});

// Log out. Destroys the session so the cookie can't be replayed.
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('gofirst.sid');
      res.json({ ok: true });
    });
  });
});

module.exports = router;
