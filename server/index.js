require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('./auth');
const { WebSocketServer } = require('ws');
const prisma = require('./db');

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

// Body size cap. Bumped from 5mb → 30mb so DM video attachments
// (capped at ~25mb base64 = ~18mb of binary video) fit through the
// JSON parser. Most requests are tiny — this only matters for the
// attachment path. Per-route validators still enforce stricter
// per-payload caps; this is just the outer ceiling.
app.use(express.json({ limit: '30mb' }));
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

// Bump lastSeenAt on every authenticated /api/* hit (throttled to 1/min/user).
// Fire-and-forget — never blocks the response.
app.use('/api', require('./middleware').trackLastSeen);

// Health probe for Railway.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Keepalive ping — clients and this server itself hit this to prevent Railway sleep.
app.get('/ping', (_req, res) => res.status(200).send('pong'));

// API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/streaks', require('./routes/streaks'));
app.use('/api/overrides', require('./routes/overrides'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/push', require('./routes/push'));
app.use('/api/days', require('./routes/days'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/collaborators', require('./routes/collaborators'));

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
// appears in the main SPA bundle. The page itself calls /api/admin/me to
// confirm the user is the allow-listed admin; non-admin sessions just see
// a 404-style screen. Reachable at both /admin and /dev for convenience.
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

// ─── WebSocket server for real-time coaching chat ──────────────────────────
// Parses the gofirst.sid cookie from the WS upgrade request, looks the
// session up in Postgres, and resolves it to a user. If the session is invalid
// the socket is destroyed immediately.

function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

// userId → Set of open WebSocket connections (supports multiple tabs).
const wsClients = new Map();

// Broadcast a JSON payload to every open connection for a given userId.
function wsBroadcast(userId, payload) {
  const sockets = wsClients.get(userId);
  if (!sockets) return;
  const json = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(json); } catch (_) {}
    }
  }
}
// Expose on global so messages.js can call it without a circular import.
global.wsBroadcast = wsBroadcast;

const wss = new WebSocketServer({ noServer: true });
const pushModule = require('./routes/push');

wss.on('connection', (ws, userId, info) => {
  // Register the socket.
  if (!wsClients.has(userId)) wsClients.set(userId, new Set());
  wsClients.get(userId).add(ws);

  // Cache role on the socket so per-message lookups don't hit the DB.
  ws._userId = userId;
  ws._isCoach = !!info?.isCoach;
  ws._isClient = !!info?.coachingClient;
  ws._coachId = info?.coachId || null;
  ws._viewingPeer = null; // peer id whose DM thread is currently on screen

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg) return;

    if (msg.type === 'typing') {
      // Resolve recipient based on the sender's role:
      //   coach          → typing to msg.to (a coaching client they're chatting with)
      //   coaching-client → typing to the coach (no msg.to needed; legacy path)
      //   regular user   → typing to msg.to (a friend / pinned-admin / pinned-coach
      //                     thread peer). Authorization is "trust-the-WS"
      //                     because the WS itself is session-authenticated;
      //                     worst case is a stray typing dot, not data leak.
      //                     Previously this branch fell through and friend
      //                     DMs got no typing indicator at all.
      let to = null;
      if (ws._isCoach) {
        to = typeof msg.to === 'string' ? msg.to : null;
      } else if (ws._isClient && !msg.to) {
        to = ws._coachId;
      } else if (typeof msg.to === 'string') {
        to = msg.to;
      }
      if (!to || to === userId) return;

      // Forward — recipient's UI shows the indicator until the trailing
      // timeout expires. We don't store anything; this is fire-and-forget.
      wsBroadcast(to, { type: 'typing', from: userId });
      return;
    }

    if (msg.type === 'viewing') {
      // Client tells us which DM thread (if any) is currently on screen.
      // We use this for push-suppression: if a recipient is staring at
      // the sender's thread, they don't need a notification on top.
      const next = (typeof msg.peerId === 'string' && msg.peerId) ? msg.peerId : null;
      const prev = ws._viewingPeer;
      if (next === prev) return;
      ws._viewingPeer = next;
      pushModule.setViewingPeer(userId, next, prev);
      return;
    }
  });

  ws.on('close', () => {
    // Clean up the active-thread marker so we don't suppress a future
    // push for a peer this socket was looking at before disconnecting.
    if (ws._viewingPeer) {
      pushModule.clearViewingPeer(userId, ws._viewingPeer);
      ws._viewingPeer = null;
    }
    const set = wsClients.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) wsClients.delete(userId);
    }
  });

  ws.on('error', () => {});
});

// ─── HTTP server ────────────────────────────────────────────────────────────
const port = Number(process.env.PORT) || 3000;
const server = http.createServer(app);

// Intercept WebSocket upgrade requests. Auth is done here by reading the
// session cookie, looking up the Postgres session, and checking passport.user.
server.on('upgrade', async (request, socket, head) => {
  try {
    const cookies = parseCookies(request.headers.cookie || '');
    const rawSid = cookies['gofirst.sid'] || '';
    if (!rawSid) { socket.destroy(); return; }

    // express-session prefixes the SID with "s:" and appends an HMAC.
    // Strip both to get the bare session ID stored in Postgres.
    const sid = rawSid.replace(/^s:/, '').split('.')[0];

    const sessionRow = await prisma.session.findUnique({ where: { sid } });
    if (!sessionRow || sessionRow.expire < new Date()) { socket.destroy(); return; }

    const sess = typeof sessionRow.sess === 'string'
      ? JSON.parse(sessionRow.sess)
      : sessionRow.sess;

    const userId = sess?.passport?.user;
    if (!userId) { socket.destroy(); return; }

    // Any authenticated user gets a WS connection — friends DMs need it
    // too. Role still gets cached on the socket so per-message handlers
    // can authorize without a DB hit per keystroke.
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, coachingClient: true, isCoach: true } });
    if (!user) { socket.destroy(); return; }
    const isCoach = !!user.isCoach;

    // Resolve the coach id once at upgrade time so client-side typing events
    // can be forwarded without an extra DB hit per keystroke. No coach in
    // the DB yet → coachId stays null and typing events from this client
    // simply have no destination.
    let coachId = null;
    if (user.coachingClient && !isCoach) {
      const coach = await prisma.user.findFirst({ where: { isCoach: true } });
      coachId = coach?.id || null;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, userId, { isCoach, coachingClient: user.coachingClient, coachId });
    });
  } catch (e) {
    console.error('[ws upgrade error]', e);
    socket.destroy();
  }
});

server.listen(port, () => {
  console.log(`GoFirst listening on :${port}  (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
  // Start the deadline-nudge scheduler — fires the 2h / 1h push
  // notifications when a user's day-end is approaching and they
  // still have unfinished work or a uncommitted tomorrow.
  try { require('./nudges').start(); }
  catch (e) { console.warn('[nudges] failed to start', e.message); }

  // Welcome-DM scheduler — sends a one-time "Thanks for downloading"
  // DM from admin to each new account once they've been active for
  // 15+ minutes. Hidden from the admin's inbox until they reply.
  try { require('./welcome').start(); }
  catch (e) { console.warn('[welcome] failed to start', e.message); }

  // Inactivity-reengagement scheduler — daily push to anyone whose
  // lastSeenAt is more than 24h old, throttled to 1/day per user.
  try { require('./inactivity').start(); }
  catch (e) { console.warn('[inactivity] failed to start', e.message); }

  // Server-side keepalive: ping ourselves every 5 minutes so Railway never
  // idles the dyno even when no clients are connected.
  const selfUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping`
    : null;
  if (selfUrl) {
    const https = require('https');
    setInterval(() => {
      https.get(selfUrl, (res) => {
        res.resume(); // drain the response so the socket closes cleanly
      }).on('error', (err) => {
        console.warn('[keepalive] self-ping failed:', err.message);
      });
    }, 5 * 60 * 1000); // every 5 minutes
    console.log(`[keepalive] Server self-ping active → ${selfUrl}`);
  }
});
