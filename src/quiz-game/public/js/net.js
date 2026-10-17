// A WebSocket wrapper built for flaky (mobile) networks:
//  - auto-reconnect with exponential backoff + jitter
//  - app-level ping to detect half-open sockets that never fire `close`
//  - reliable sends: messages are kept in an outbox and retried until the
//    server acks them by `mid` (the server handles them idempotently)
//  - server clock offset estimate so countdowns match on every screen

const PING_EVERY_MS = 5000;
const DEAD_AFTER_MS = 12000;
const RETRY_UNACKED_MS = 3000;
const FATAL_CLOSE_CODES = new Set([4000, 4001]); // replaced by another tab, kicked

export class ReliableSocket {
  constructor({ onOpen, onMessage, onStatus }) {
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.attempt = 0;
    this.outbox = new Map(); // mid -> { msg, sentAt, resolve }
    this.ready = false; // session (re)established, safe to flush outbox
    this.clockOffset = 0; // serverTime - localTime
    this.rtt = 0;
    this.lastHeard = 0;
    this.lastPingAt = 0;
    this.stopped = false;

    setInterval(() => this.tick(), 1000);
    const wake = () => { if (!this.isOpen()) this.reconnectNow(); };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.ready = false;
    this.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastHeard = Date.now();
      this.onStatus('online');
      this.ping();
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      this.lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'pong') return this.handlePong(msg);
      if (msg.t === 'ack') return this.handleAck(msg);
      if (msg.serverNow) this.observeServerTime(msg.serverNow);
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // an older socket we already replaced
      this.ready = false;
      if (FATAL_CLOSE_CODES.has(ev.code)) {
        this.stopped = true;
        return this.onStatus('stopped');
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {}; // `close` always follows
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.onStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
    const base = Math.min(8000, 500 * 2 ** this.attempt++);
    const delay = base / 2 + Math.random() * base / 2; // jitter avoids a reconnect stampede
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.stopped) return;
    this.attempt = 0;
    this.drop();
    this.connect();
  }

  drop() {
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  }

  stop() {
    this.stopped = true;
    this.drop();
  }

  send(msg) {
    if (this.isOpen()) this.ws.send(JSON.stringify(msg));
  }

  // Resolves with the server's ack ({ ok, reason }); survives reconnects.
  sendReliable(msg) {
    const mid = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    return new Promise((resolve) => {
      this.outbox.set(mid, { msg: { ...msg, mid }, sentAt: 0, resolve });
      this.flush();
    });
  }

  // Call once the session is re-established (e.g. after `joined`), so
  // retried messages land on an authenticated socket.
  markReady() {
    this.ready = true;
    this.flush();
  }

  flush() {
    if (!this.ready || !this.isOpen()) return;
    const now = Date.now();
    for (const item of this.outbox.values()) {
      if (now - item.sentAt >= RETRY_UNACKED_MS) {
        item.sentAt = now;
        this.ws.send(JSON.stringify(item.msg));
      }
    }
  }

  clearOutbox() {
    for (const item of this.outbox.values()) item.resolve({ ok: false, reason: 'cancelled' });
    this.outbox.clear();
  }

  handleAck(msg) {
    const item = this.outbox.get(msg.mid);
    if (!item) return;
    this.outbox.delete(msg.mid);
    item.resolve({ ok: msg.ok, reason: msg.reason });
  }

  ping() {
    this.lastPingAt = Date.now();
    this.send({ t: 'ping', ts: this.lastPingAt });
  }

  handlePong(msg) {
    const now = Date.now();
    this.rtt = now - msg.ts;
    // Server stamped its clock roughly halfway through the round trip.
    const offset = msg.serverNow + this.rtt / 2 - now;
    this.clockOffset = this.clockOffset ? this.clockOffset * 0.7 + offset * 0.3 : offset;
  }

  observeServerTime(serverNow) {
    if (!this.clockOffset) this.clockOffset = serverNow - Date.now();
  }

  serverNow() { return Date.now() + this.clockOffset; }

  tick() {
    if (!this.isOpen()) return;
    if (Date.now() - this.lastHeard > DEAD_AFTER_MS) {
      // Socket looks open but nothing is arriving: treat as dead.
      this.drop();
      return this.scheduleReconnect();
    }
    if (Date.now() - this.lastPingAt >= PING_EVERY_MS) this.ping();
    this.flush();
  }
}

export const SHAPES = ['triangle', 'diamond', 'circle', 'square'];
export const COLORS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];

export function shapeSVG(i, size = 28) {
  const paths = [
    '<polygon points="16,3 30,28 2,28"/>',
    '<polygon points="16,1 31,16 16,31 1,16"/>',
    '<circle cx="16" cy="16" r="14"/>',
    '<rect x="3" y="3" width="26" height="26"/>',
  ];
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" fill="#fff" aria-hidden="true">${paths[i]}</svg>`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function statusBadge(el) {
  const labels = { connecting: 'Connecting…', online: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline — waiting for network', stopped: 'Disconnected' };
  return (status) => {
    el.dataset.status = status;
    el.textContent = labels[status] || status;
  };
}

// LINE profile photo, or a coloured initial when the player has none.
export function avatar(p, size = 32) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px`;
  if (p.picture) return `<img class="avatar" src="${esc(p.picture)}" alt="" style="${style}" referrerpolicy="no-referrer" loading="lazy" />`;
  const name = String(p.name ?? '?');
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `<span class="avatar" style="${style};background:${COLORS[h % COLORS.length]}">${esc([...name][0]?.toUpperCase() || '?')}</span>`;
}
