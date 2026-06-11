/**
 * Kairos Surveillance — Cloudflare Workers Relay
 *
 * Routes:
 *   GET  /watch/<roomId>               — HTML viewer page (canvas + WebSocket)
 *   WS   /viewer/<roomId>              — WebSocket stream to browser
 *   WS   /publish/<roomId>?secret=...  — WebSocket from camera (requires secret)
 *   POST /subscribe/<roomId>           — email alert subscription
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler secret put PUBLISH_SECRET
 *   wrangler deploy
 */

export { RelayRoom } from './relay-room.js';

const R = {
  PUBLISH:   /^\/publish\/([A-Za-z0-9_-]+)$/,
  VIEWER_WS: /^\/viewer\/([A-Za-z0-9_-]+)$/,
  WATCH:     /^\/watch\/([A-Za-z0-9_-]+)$/,
  SUBSCRIBE: /^\/subscribe\/([A-Za-z0-9_-]+)$/,
};

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // Camera publishes frames via WebSocket
    const pub = path.match(R.PUBLISH);
    if (pub) {
      if (url.searchParams.get('secret') !== env.PUBLISH_SECRET) {
        return new Response('Unauthorized', { status: 403 });
      }
      return room(env, pub[1], request);
    }

    // Browser receives frames via WebSocket
    const view = path.match(R.VIEWER_WS);
    if (view) return room(env, view[1], request);

    // HTML viewer page
    const watch = path.match(R.WATCH);
    if (watch) {
      return new Response(viewerHtml(watch[1], url.host), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Email subscription
    const sub = path.match(R.SUBSCRIBE);
    if (sub) return room(env, sub[1], request);

    return new Response('Not found', { status: 404 });
  },
};

function room(env, roomId, request) {
  const id   = env.RELAY_ROOM.idFromName(roomId);
  const stub = env.RELAY_ROOM.get(id);
  return stub.fetch(request);
}

// ── Viewer HTML ───────────────────────────────────────────────────────────────
// Receives JPEG frames over WebSocket and paints them onto a <canvas>.
// Functionally identical to the old MJPEG viewer — same URL, same look.

function viewerHtml(roomId, host) {
  const wsUrl    = `wss://${host}/viewer/${roomId}`;
  const watchUrl = `https://${host}/watch/${roomId}`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kairos — Live</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100dvh; display: flex; flex-direction: column; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 14px 20px; display: flex; align-items: center; gap: 12px; }
    .logo { width: 28px; height: 28px; fill: #58a6ff; flex-shrink: 0; }
    h1 { font-size: 17px; font-weight: 600; }
    .badge { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; animation: blink 2s ease-in-out infinite; }
    .dot.live { background: #3fb950; color: #3fb950; }
    .dot.waiting { background: #8b949e; color: #8b949e; animation: none; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
    main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; gap: 20px; }
    .frame { background: #010409; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.6); max-width: 100%; }
    canvas { display: block; max-width: 100%; max-height: 72dvh; }
    .overlay { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; flex-direction: column; gap: 12px; background: #010409; color: #8b949e; text-align: center; padding: 20px; border-radius: 12px; }
    .overlay.visible { display: flex; }
    .frame-wrap { position: relative; }
    .notify-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px 20px; width: 100%; max-width: 480px; }
    .notify-box h2 { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
    .row { display: flex; gap: 8px; }
    input[type=email] { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; outline: none; }
    input[type=email]:focus { border-color: #58a6ff; }
    .btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; }
    .btn-primary { background: #238636; color: #fff; }
    .btn-secondary { background: #21262d; color: #e6edf3; }
    footer { text-align: center; padding: 10px; font-size: 12px; color: #484f58; }
  </style>
</head>
<body>
  <header>
    <svg class="logo" viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
    <h1>Kairos Surveillance</h1>
    <span class="badge" id="badge">
      <span class="dot waiting" id="dot"></span>
      <span id="badgeText">Verbinde…</span>
    </span>
  </header>

  <main>
    <div class="frame-wrap">
      <canvas id="feed" width="1280" height="720"></canvas>
      <div class="overlay visible" id="overlay">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="#8b949e"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
        <p id="overlayText" style="font-size:15px">Warte auf Kamera…</p>
        <button onclick="location.reload()" class="btn btn-primary" style="margin-top:4px">Neu laden</button>
      </div>
    </div>

    <div class="notify-box">
      <h2>Bewegungsbenachrichtigungen</h2>
      <div id="subForm">
        <div class="row">
          <input type="email" id="emailInput" placeholder="deine@email.de">
          <button class="btn btn-primary" onclick="subscribe()">Aktivieren</button>
        </div>
        <p id="subMsg" style="font-size:13px;margin-top:8px;display:none"></p>
      </div>
      <div id="unsubForm" style="display:none">
        <div class="row">
          <span style="flex:1;font-size:14px;padding:8px 0;color:#3fb950">✓ Benachrichtigungen aktiv</span>
          <button class="btn btn-secondary" onclick="unsubscribe()">Deaktivieren</button>
        </div>
      </div>
    </div>
  </main>

  <footer>Raum: ${roomId}</footer>

  <script>
    const canvas  = document.getElementById('feed');
    const ctx     = canvas.getContext('2d');
    const overlay = document.getElementById('overlay');
    const dot     = document.getElementById('dot');
    const badge   = document.getElementById('badgeText');

    function setStatus(state, text) {
      dot.className = 'dot ' + state;
      badge.textContent = text;
    }

    function connect() {
      const ws = new WebSocket('${wsUrl}');
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setStatus('live', 'Live');
      };

      ws.onmessage = ({ data }) => {
        // Each message is a complete JPEG — decode and paint onto canvas
        const blob = new Blob([data], { type: 'image/jpeg' });
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          overlay.classList.remove('visible');
        };
        img.src = url;
      };

      ws.onclose = () => {
        setStatus('waiting', 'Getrennt');
        overlay.classList.add('visible');
        document.getElementById('overlayText').textContent = 'Verbindung getrennt — verbinde neu…';
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setStatus('waiting', 'Fehler');
        ws.close();
      };
    }

    connect();

    // ── Email subscriptions ───────────────────────────────────────────────────
    const STORE_KEY  = 'kairos_sub_${roomId}';
    if (localStorage.getItem(STORE_KEY)) showUnsubForm();

    function showUnsubForm() {
      document.getElementById('subForm').style.display   = 'none';
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
      if (res.ok) {
        localStorage.setItem(STORE_KEY, email);
        showUnsubForm();
      } else {
        const msg = document.getElementById('subMsg');
        msg.textContent = 'Fehler. Bitte erneut versuchen.';
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
      document.getElementById('subForm').style.display   = 'block';
      document.getElementById('unsubForm').style.display = 'none';
      document.getElementById('emailInput').value        = '';
    }

    // Reconnect when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) connect();
    });
  </script>
</body>
</html>`;
}
