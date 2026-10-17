import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, getRoom } from './game.js';
import { hasQwenKey } from './qwen.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const HEARTBEAT_MS = 15_000;
const MSGS_PER_SEC = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, qwen: hasQwenKey }));
  }
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  if (!extname(path)) path += '.html'; // /host -> host.html, /play -> play.html
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let windowStart = Date.now();
  let count = 0;

  ws.on('message', (raw) => {
    // Simple per-socket rate limit: protects the game loop from a spamming client.
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > MSGS_PER_SEC) return ws.close(1008, 'rate limit');

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (err) {
      console.error('handler error', err);
      reply(ws, { t: 'error', code: 'server', message: 'Server error.' });
    }
  });

  ws.on('close', () => ws.ctx?.room.detach(ws));
  ws.on('error', () => {});
});

function reply(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function handle(ws, msg) {
  // App-level ping lets the client measure RTT and detect half-open sockets
  // (common on mobile networks, where TCP can look alive but isn't).
  if (msg.t === 'ping') return reply(ws, { t: 'pong', ts: msg.ts, serverNow: Date.now() });

  if (msg.t === 'host:create') {
    const topic = String(msg.topic ?? '').trim().slice(0, 120) || 'General knowledge';
    const count = Math.min(20, Math.max(3, Number(msg.count) || 8));
    const difficulty = ['easy', 'medium', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'medium';
    const language = String(msg.language ?? 'English').slice(0, 30);
    const room = new Room({ topic, count, difficulty, language });
    console.log(`[room ${room.pin}] created: "${topic}" x${count} (${difficulty}, ${language})`);
    reply(ws, { t: 'host:created', pin: room.pin, hostToken: room.hostToken });
    return room.attachHost(ws);
  }

  if (msg.t === 'host:resume') {
    const room = getRoom(msg.pin);
    if (!room || room.hostToken !== msg.hostToken) return reply(ws, { t: 'error', code: 'unknown_session', message: 'Room not found.' });
    return room.attachHost(ws);
  }

  if (msg.t === 'player:join' || msg.t === 'player:resume') {
    const room = getRoom(msg.pin);
    if (!room) return reply(ws, { t: 'error', code: msg.t === 'player:resume' ? 'unknown_session' : 'bad_pin', message: 'Game PIN not found.' });
    return msg.t === 'player:join' ? room.addPlayer(ws, msg.name) : room.resumePlayer(ws, msg.token);
  }

  const ctx = ws.ctx;
  if (!ctx) return reply(ws, { t: 'error', code: 'no_session', message: 'Not in a room.' });

  if (ctx.role === 'host' && msg.t.startsWith('host:')) return ctx.room.hostCommand(msg.t.slice(5), msg);
  if (ctx.role === 'player' && msg.t === 'player:answer') return ctx.room.answer(ctx.playerId, msg);
}

// Protocol-level heartbeat: terminate sockets that miss a pong so their
// players show as offline promptly and their slot can be resumed.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Quiz server on http://localhost:${PORT}`);
  console.log(hasQwenKey ? 'Qwen question generation: enabled' : 'Qwen: no QWEN_API_KEY, using sample questions');
});
