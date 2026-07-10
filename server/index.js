require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('./auth');

// Keep the Node process alive on unhandled async errors. Express 4 doesn't
// catch errors thrown inside async route handlers; without these listeners
// any such error becomes an unhandledRejection which crashes the dyno on
// modern Node. The Express error handler at the bottom of this file still
// returns a 500 for everything that DOES go through next(err); these
// listeners are the safety net for the cases that don't.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();

// Railway sits behind a proxy. Needed so `secure` cookies + `req.secure` work.
app.set('trust proxy', 1);

// gzip every response that benefits from it.
app.use(require('compression')());

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Session store in Postgres. `createTableIfMissing` bootstraps the session
// table on first boot, so no manual migration is needed for auth.
app.use(session({
  name: 'gofirst.sid',
  store: new PgSession({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    tableName: 'session',
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Health probe for Railway.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Keepalive ping — clients and this server itself hit this to prevent Railway sleep.
app.get('/ping', (_req, res) => res.status(200).send('pong'));

// API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/streaks', require('./routes/streaks'));
app.use('/api/admin', require('./routes/admin'));

// Static assets — the SPA lives in /public.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  // index.html is hot-reloaded via service worker; don't let the browser cache it.
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Hidden admin / developer dashboard. Served as a separate page so it never
// appears in the main SPA bundle. Reachable at both /admin and /dev.
app.get(['/admin', '/admin/', '/dev', '/dev/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// SPA fallback for any non-API route.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Error handler — keep the server alive on unhandled API errors.
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

const port = Number(process.env.PORT) || 3000;
const server = http.createServer(app);

server.listen(port, () => {
  console.log(`GoFirst listening on :${port}  (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
  // Server-side keepalive: ping ourselves every 5 minutes so Railway never
  // idles the dyno even when no clients are connected.
  const selfUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : null;
  if (selfUrl) {
    const https = require('https');
    setInterval(() => {
      https.get(selfUrl, (res) => {
        res.resume();
      }).on('error', (err) => {
        console.warn('[keepalive] self-ping failed:', err.message);
      });
    }, 5 * 60 * 1000);
    console.log(`[keepalive] Server self-ping active → ${selfUrl}`);
  }
});
