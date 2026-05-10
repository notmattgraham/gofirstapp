// Feedback endpoint. Posts the typed body server-side via the
// help@gofirstbrand.com Gmail account using SMTP + an app password.
// `Reply-To` is set to the signed-in user's email so help@ can hit
// Reply and land directly in the user's inbox.
//
// Why server-side instead of opening mailto in the user's email
// client: most users don't have a desktop email app set up, and on
// PWAs / iOS the mailto handoff is flaky. Going through Gmail SMTP
// keeps the experience entirely in-app.
//
// Required env vars to actually send:
//   GMAIL_APP_PASSWORD    — 16-char app password generated for
//                           help@gofirstbrand.com (Google Account →
//                           Security → 2-step verification → App
//                           passwords). NOT the regular login pw.
//   FEEDBACK_EMAIL_FROM   — optional override; defaults to
//                           "help@gofirstbrand.com".
//   FEEDBACK_EMAIL_TO     — optional override; defaults to the
//                           same address.
//
// If GMAIL_APP_PASSWORD is missing the route still 200s, but the body
// is just logged to stdout — useful for dev / before the env var is
// configured on the host.

const express = require('express');
const nodemailer = require('nodemailer');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const FROM = process.env.FEEDBACK_EMAIL_FROM || 'help@gofirstbrand.com';
const TO   = process.env.FEEDBACK_EMAIL_TO   || 'help@gofirstbrand.com';

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) return null;
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM, pass },
  });
  return _transporter;
}

router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
  const me = req.user;
  const raw = (req.body && typeof req.body.body === 'string') ? req.body.body : '';
  const body = raw.trim().slice(0, 5000);
  if (!body) return res.status(400).json({ error: 'empty_body' });

  const senderName  = (me && me.name)  || '';
  const senderEmail = (me && me.email) || '';
  const subject = senderName
    ? `GoFirst feedback — ${senderName}`
    : `GoFirst feedback — ${senderEmail || 'user'}`;

  // Plain-text body. Includes the user's identity at the top so help@
  // sees who it's from at a glance even before opening Reply.
  const text =
`From: ${senderName ? senderName + ' ' : ''}<${senderEmail}>
User ID: ${me.id}

${body}
`;

  const transporter = getTransporter();
  if (!transporter) {
    // Env not wired yet — log so feedback isn't silently dropped, and
    // still return success so the SPA UX feels normal.
    console.warn('[feedback] GMAIL_APP_PASSWORD not set; logging only:\n', text);
    return res.json({ ok: true, mode: 'logged' });
  }

  try {
    await transporter.sendMail({
      from: `"GoFirst" <${FROM}>`,
      to: TO,
      replyTo: senderEmail || undefined,
      subject,
      text,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] sendMail failed', err);
    res.status(500).json({ error: 'send_failed' });
  }
});

module.exports = router;
