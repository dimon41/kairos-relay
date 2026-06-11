/**
 * RelayRoom — Cloudflare Durable Object
 *
 * One instance per roomId. Holds:
 *   - the publisher WebSocket (camera)
 *   - all active viewer WebSockets (browsers)
 *   - the last JPEG frame (sent immediately to new viewers)
 *   - email subscriber list (persisted in DO storage)
 */

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between alerts per room

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env   = env;

    this.publisher  = null;   // WebSocket | null
    this.viewers    = new Set();
    this.lastFrame  = null;   // ArrayBuffer | null
    this.lastAlertAt = 0;
  }

  async fetch(request) {
    const url      = new URL(request.url);
    const upgrade  = request.headers.get('Upgrade') ?? '';

    // ── WebSocket connections ─────────────────────────────────────────────────
    if (upgrade.toLowerCase() === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());

      if (url.pathname.includes('/publish/')) {
        this._acceptPublisher(server, url.host, url.pathname);
      } else {
        this._acceptViewer(server);
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── POST /subscribe/<roomId> ──────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname.includes('/subscribe/')) {
      return this._handleSubscribe(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Publisher (camera) ──────────────────────────────────────────────────────

  _acceptPublisher(ws, host, pathname) {
    ws.accept();
    this.publisher = ws;

    // roomId is the last path segment  (/publish/<roomId>)
    const roomId = pathname.split('/').pop();

    ws.addEventListener('message', async ({ data }) => {
      if (data instanceof ArrayBuffer) {
        // Binary = JPEG frame → forward to all viewers
        this.lastFrame = data;
        for (const viewer of [...this.viewers]) {
          try {
            viewer.send(data);
          } catch {
            this.viewers.delete(viewer);
          }
        }
      } else {
        // Text = JSON control message (e.g. motion alert)
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'motion') {
            const watchUrl = `https://${host}/watch/${roomId}`;
            await this._sendMotionAlerts(roomId, msg.deviceName ?? 'Kairos Camera', watchUrl);
          }
        } catch { /* ignore malformed */ }
      }
    });

    ws.addEventListener('close', () => { this.publisher = null; });
    ws.addEventListener('error', () => { this.publisher = null; });
  }

  // ── Viewer (browser) ────────────────────────────────────────────────────────

  _acceptViewer(ws) {
    ws.accept();
    this.viewers.add(ws);

    // Send last frame immediately — viewer sees something right away
    if (this.lastFrame) {
      try { ws.send(this.lastFrame); } catch { /* ignore */ }
    }

    ws.addEventListener('close', () => this.viewers.delete(ws));
    ws.addEventListener('error', () => this.viewers.delete(ws));
  }

  // ── Email subscriptions ─────────────────────────────────────────────────────

  async _handleSubscribe(request) {
    let body;
    try { body = await request.json(); } catch {
      return _json({ error: 'Bad request' }, 400);
    }

    const { email, action } = body;
    const addr = (email ?? '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return _json({ error: 'Invalid email' }, 400);
    }

    const subs = (await this.state.storage.get('subscribers')) ?? [];
    const updated = action === 'unsubscribe'
      ? subs.filter(s => s !== addr)
      : subs.includes(addr) ? subs : [...subs, addr];

    await this.state.storage.put('subscribers', updated);
    return _json({ ok: true });
  }

  async _sendMotionAlerts(roomId, deviceName, watchUrl) {
    const apiKey = this.env.RESEND_API_KEY;
    if (!apiKey) return;

    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_COOLDOWN_MS) return;

    const subs = (await this.state.storage.get('subscribers')) ?? [];
    if (subs.length === 0) return;

    this.lastAlertAt = now;

    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    this.env.FROM_EMAIL ?? 'onboarding@resend.dev',
        to:      subs,
        subject: `Bewegung erkannt — ${deviceName}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#58a6ff">⚠ Bewegung erkannt</h2>
            <p><strong>${deviceName}</strong> hat Bewegung erkannt.</p>
            <p>
              <a href="${watchUrl}"
                 style="display:inline-block;padding:10px 20px;background:#238636;
                        color:#fff;text-decoration:none;border-radius:6px">
                Live-Stream ansehen
              </a>
            </p>
          </div>`,
      }),
    }).catch(() => { /* fire-and-forget */ });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
