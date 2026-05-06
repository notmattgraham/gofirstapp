const express = require('express');
const passport = require('../auth');
const prisma = require('../db');

const router = express.Router();

// The one coach account. Hardcoded as an env-var default so the whole
// coaching feature can be ripped out by deleting COACH_EMAIL.
const COACH_EMAIL = (process.env.COACH_EMAIL || 'mattgraham15@gmail.com').toLowerCase();

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
    isCoach: (u.email || '').toLowerCase() === COACH_EMAIL,
  };
}

// Who am I?  Returns { user: null } when signed out.
router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: shape(req.user) });
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
