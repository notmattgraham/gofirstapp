const express = require('express');
const passport = require('../auth');
const prisma = require('../db');

const router = express.Router();

// Kick off Google OAuth.
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// Google redirects back here after the user approves.
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=error' }),
  (req, res) => res.redirect('/')
);

// Who am I?  Returns { user: null } when signed out.
router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { id, email, name, picture } = req.user;
  res.json({ user: { id, email, name, picture } });
});

// Update the signed-in user's display name / avatar. The client sends
// { name?: string, picture?: string } where `picture` is a base64 data-URL
// pre-downscaled to 256x256 (~30–50 KB as JPEG). Cap at ~700 KB for safety.
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
    // Must be a data URL or an http(s) URL.
    const ok = /^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/)/i.test(req.body.picture);
    if (!ok && req.body.picture !== '') {
      return res.status(400).json({ error: 'invalid picture' });
    }
    data.picture = req.body.picture || null;
  }
  if (Object.keys(data).length === 0) return res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, picture: req.user.picture } });
  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: { id: user.id, email: user.email, name: user.name, picture: user.picture } });
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
