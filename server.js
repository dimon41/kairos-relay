/**
 * Kairos Surveillance — Cloud Relay Server
 *
 * Architecture:
 *   Phone  ──WebSocket──► /publish/<roomId>?secret=<secret>
 *   Browser ──HTTP────►   /watch/<roomId>        (HTML viewer page)
 *   Browser ──HTTP────►   /stream/<roomId>       (MJPEG stream)
 *   Browser ──HTTP POST►  /subscribe/<roomId>    (email subscription)
 *
 * Environment variables:
 *   PORT              — HTTP port (default 3000)
 *   PUBLISH_SECRET    — shared secret phones must supply (default 'kairos')
 *   RESEND_API_KEY    — Resend API key for motion alert emails
 *   FROM_EMAIL        — sender address (default 'onboarding@resend.dev')
 *   ALERT_COOLDOWN_MS — minimum ms between alerts per room (default 300000 = 5 min)
 */

'use strict';

const http  = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const { parse: parseUrl } = require('url');

const PORT             = parseInt(process.env.PORT             ?? '3000',   10);
const SECRET           = process.env.PUBLISH_SECRET            ?? 'kairos';
const RESEND_API_KEY   = process.env.RESEND_API_KEY            ?? '';
const FROM_EMAIL       = process.env.FROM_EMAIL                ?? 'onboarding@resend.dev';
const ALERT_COOLDOWN   = parseInt(process.env.ALERT_COOLDOWN_MS ?? '300000', 10);

// roomId → { lastFrame, viewers, subscribers, lastAlertAt }
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      lastFrame:    null,
      viewers:      new Set(),
      subscribers:  new Set(),
      lastAlertAt:  0,
    });
  }
  return rooms.get(id);
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendMotionAlert(roomId, deviceName, watchUrl) {
  const room = getRoom(roomId);
  if (room.subscribers.size === 0) return;

  const now = Date.now();
  if (now - room.lastAlertAt < ALERT_COOLDOWN) {
    console.log(`[${new Date().toISOString()}] Alert cooldown active, skipping`);
    return;
  }
  room.lastAlertAt = now;

  if (!RESEND_API_KEY) {
    console.log(`[${new Date().toISOString()}] Motion alert skipped: RESEND_API_KEY not set`);
    return;
  }

  const to   = [...room.subscribers];
  const body = JSON.stringify({
    from:    FROM_EMAIL,
    to,
    subject: `Motion detected — ${deviceName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#58a6ff">⚠ Motion Detected</h2>
        <p><strong>${deviceName}</strong> detected motion.</p>
        <p>
          <a href="${watchUrl}"
             style="display:inline-block;padding:10px 20px;background:#238636;
                    color:#fff;text-decoration:none;border-radius:6px">
            Watch Live Stream
          </a>
        </p>
        <p style="color:#8b949e;font-size:12px">
          You subscribed to motion alerts for room <code>${roomId}</code>.<br>
          To unsubscribe, visit <a href="${watchUrl}">${watchUrl}</a> and click Unsubscribe.
        </p>
      </div>`,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${RESEND_API_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[${new Date().toISOString()}] Alert sent to ${to.length} subscriber(s) — HTTP ${res.statusCode}`);
        resolve();
      });
    });
    req.on('error', (e) => {
      console.error(`[${new Date().toISOString()}] Email error:`, e.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const { pathname } = parseUrl(req.url, true);

  // ── GET /watch/<roomId> — viewer HTML page ──────────────────────────────
  const watchM = pathname.match(/^\/watch\/([A-Za-z0-9_-]+)$/);
  if (watchM && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(viewerHtml(watchM[1], req.headers.host ?? ''));
    return;
  }

  // ── GET /stream/<roomId> — MJPEG stream ─────────────────────────────────
  const streamM = pathname.match(/^\/stream\/([A-Za-z0-9_-]+)$/);
  if (streamM && req.method === 'GET') {
    const room = getRoom(streamM[1]);
    res.writeHead(200, {
      'Content-Type':  'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    room.viewers.add(res);
    req.on('close', () => room.viewers.delete(res));
    if (room.lastFrame) pushFrame(res, room.lastFrame);
    return;
  }

  // ── POST /subscribe/<roomId> — add email subscriber ─────────────────────
  const subM = pathname.match(/^\/subscribe\/([A-Za-z0-9_-]+)$/);
  if (subM && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, action } = JSON.parse(body);
        const addr = (email ?? '').toLowerCase().trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid email' }));
          return;
        }
        const room = getRoom(subM[1]);
        if (action === 'unsubscribe') {
          room.subscribers.delete(addr);
          console.log(`[${new Date().toISOString()}] Unsubscribed room=${subM[1]} email=${addr}`);
        } else {
          room.subscribers.add(addr);
          console.log(`[${new Date().toISOString()}] Subscribed   room=${subM[1]} email=${addr}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server (publishers) ─────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const { pathname, query } = parseUrl(req.url, true);

  const pubM = pathname.match(/^\/publish\/([A-Za-z0-9_-]+)$/);
  if (!pubM) { ws.close(4001, 'Invalid path'); return; }
  if (query.secret !== SECRET) { ws.close(4003, 'Unauthorized'); return; }

  const roomId = pubM[1];
  const room   = getRoom(roomId);
  const host   = req.headers.host ?? '';
  const ip     = req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] Publisher connected  room=${roomId} ip=${ip}`);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Text message — currently used for motion alerts
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'motion') {
          const watchUrl = `https://${host}/watch/${roomId}`;
          sendMotionAlert(roomId, msg.deviceName ?? 'Kairos Camera', watchUrl)
            .catch(console.error);
        }
      } catch {}
      return;
    }

    // Binary message — JPEG frame
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    room.lastFrame = frame;
    for (const viewer of [...room.viewers]) {
      try {
        pushFrame(viewer, frame);
      } catch {
        room.viewers.delete(viewer);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] Publisher disconnected room=${roomId}`);
  });

  ws.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Publisher error room=${roomId}:`, err.message);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function pushFrame(res, frame) {
  res.write('--frame\r\n');
  res.write('Content-Type: image/jpeg\r\n');
  res.write(`Content-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
}

function viewerHtml(roomId, host) {
  const watchUrl = `https://${host}/watch/${roomId}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kairos — Live View</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100dvh; display: flex; flex-direction: column; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 14px 20px; display: flex; align-items: center; gap: 12px; }
    .logo { width: 28px; height: 28px; fill: #58a6ff; flex-shrink: 0; }
    h1 { font-size: 17px; font-weight: 600; }
    .badge { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 13px; color: #3fb950; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: blink 2s ease-in-out infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
    main { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 20px; gap: 20px; }
    .frame { background: #010409; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.6); max-width: 100%; }
    img { display: block; max-width: 100%; max-height: 72dvh; object-fit: contain; }
    .notify-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px 20px; width: 100%; max-width: 480px; }
    .notify-box h2 { font-size: 14px; font-weight: 600; margin-bottom: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
    .notify-row { display: flex; gap: 8px; }
    .notify-row input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; outline: none; }
    .notify-row input:focus { border-color: #58a6ff; }
    .btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; }
    .btn-primary { background: #238636; color: #fff; }
    .btn-secondary { background: #21262d; color: #e6edf3; }
    .notify-msg { font-size: 13px; margin-top: 8px; }
    footer { text-align: center; padding: 10px; font-size: 12px; color: #484f58; }
  </style>
</head>
<body>
  <header>
    <svg class="logo" viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
    <h1>Kairos Surveillance</h1>
    <span class="badge"><span class="dot"></span>Live</span>
  </header>
  <main>
    <div class="frame">
      <img id="feed" src="/stream/${roomId}" alt="Live camera feed"
           onerror="this.style.display='none'; document.getElementById('err').style.display='block'">
      <div id="err" style="display:none; padding:40px; text-align:center; color:#8b949e">
        <p style="font-size:15px; margin-bottom:12px">Stream not available</p>
        <button onclick="location.reload()" class="btn btn-primary">Retry</button>
      </div>
    </div>

    <div class="notify-box">
      <h2>Motion Alerts</h2>
      <div id="subForm">
        <div class="notify-row">
          <input type="email" id="emailInput" placeholder="your@email.com">
          <button class="btn btn-primary" onclick="subscribe()">Notify me</button>
        </div>
        <p class="notify-msg" id="subMsg" style="display:none"></p>
      </div>
      <div id="unsubForm" style="display:none">
        <div class="notify-row">
          <span style="flex:1; font-size:14px; padding: 8px 0; color:#3fb950">✓ Subscribed</span>
          <button class="btn btn-secondary" onclick="unsubscribe()">Unsubscribe</button>
        </div>
      </div>
    </div>
  </main>
  <footer>Room: ${roomId}</footer>
  <script>
    // Restore subscription state from localStorage
    const STORE_KEY = 'kairos_sub_${roomId}';
    const savedEmail = localStorage.getItem(STORE_KEY);
    if (savedEmail) showUnsubForm();

    function showUnsubForm() {
      document.getElementById('subForm').style.display = 'none';
      document.getElementById('unsubForm').style.display = 'block';
    }

    async function subscribe() {
      const email = document.getElementById('emailInput').value.trim();
      if (!email) return;
      const res = await fetch('/subscribe/${roomId}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const msg = document.getElementById('subMsg');
      if (res.ok) {
        localStorage.setItem(STORE_KEY, email);
        showUnsubForm();
      } else {
        msg.textContent = 'Something went wrong. Please try again.';
        msg.style.color = '#f85149';
        msg.style.display = 'block';
      }
    }

    async function unsubscribe() {
      const email = localStorage.getItem(STORE_KEY);
      if (!email) return;
      await fetch('/subscribe/${roomId}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action: 'unsubscribe' }),
      });
      localStorage.removeItem(STORE_KEY);
      document.getElementById('subForm').style.display = 'block';
      document.getElementById('unsubForm').style.display = 'none';
      document.getElementById('emailInput').value = '';
    }

    // Auto-refresh stream when tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const img = document.getElementById('feed');
        if (img) { img.style.display = 'block'; img.src = '/stream/${roomId}?' + Date.now(); }
        document.getElementById('err').style.display = 'none';
      }
    });
  </script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Kairos relay listening on port ${PORT}  secret=${SECRET}`);
  if (RESEND_API_KEY) {
    console.log(`Email alerts enabled  from=${FROM_EMAIL}  cooldown=${ALERT_COOLDOWN / 1000}s`);
  } else {
    console.log('Email alerts disabled (set RESEND_API_KEY to enable)');
  }
});
