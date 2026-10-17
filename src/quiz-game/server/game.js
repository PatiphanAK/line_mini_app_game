// Server-authoritative game state. Clients never decide timing or scoring:
// they only render snapshots, so a dropped or reordered message can't
// desync anyone. Every state change re-sends a full snapshot.

import { randomBytes, randomInt } from 'node:crypto';
import { generateQuestions, hasQwenKey, FALLBACK_QUESTIONS } from './qwen.js';

const PREVIEW_MS = 3000;
const ANSWER_GRACE_MS = 400;
const MAX_PLAYERS = 200;
const LOBBY_DISCONNECT_DROP_MS = 2 * 60_000;
const ROOM_IDLE_MS = 2 * 60 * 60_000;
const ROOM_EMPTY_MS = 30 * 60_000;

const rooms = new Map(); // pin -> Room

const token = () => randomBytes(18).toString('base64url');

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export class Room {
  constructor({ topic, count, difficulty, language }) {
    do this.pin = String(randomInt(100000, 1000000));
    while (rooms.has(this.pin));
    this.hostToken = token();
    this.hostSocket = null;
    this.players = new Map(); // id -> player
    this.topic = topic;
    this.phase = 'lobby'; // lobby | preview | question | reveal | leaderboard | ended
    this.ready = false; // questions generated?
    this.genNote = null;
    this.questions = [];
    this.qIndex = -1;
    this.phaseEndsAt = 0;
    this.questionStartedAt = 0;
    this.timer = null;
    this.version = 0;
    this.touch();
    this.emptySince = Date.now();
    rooms.set(this.pin, this);
    this.loadQuestions({ topic, count, difficulty, language });
  }

  touch() { this.lastActivity = Date.now(); }

  async loadQuestions(opts) {
    if (!hasQwenKey) {
      this.questions = FALLBACK_QUESTIONS;
      this.genNote = 'No QWEN_API_KEY set: using built-in sample questions.';
    } else {
      try {
        this.questions = await generateQuestions(opts);
      } catch (err) {
        console.error(`[room ${this.pin}] question generation failed:`, err.message);
        this.questions = FALLBACK_QUESTIONS;
        this.genNote = `Qwen failed (${err.message.slice(0, 120)}). Using sample questions.`;
      }
    }
    if (!rooms.has(this.pin)) return; // room was collected while waiting
    this.ready = true;
    this.broadcast();
  }

  // ---------- connections ----------

  attachHost(ws) {
    if (this.hostSocket && this.hostSocket !== ws) {
      send(this.hostSocket, { t: 'error', code: 'replaced', message: 'Host opened in another tab.' });
      this.hostSocket.close(4000, 'replaced');
    }
    this.hostSocket = ws;
    ws.ctx = { role: 'host', room: this };
    this.touch();
    this.sendSnapshot(ws);
  }

  addPlayer(ws, rawName) {
    const name = String(rawName ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!name) return send(ws, { t: 'error', code: 'bad_name', message: 'Please enter a nickname.' });
    if (this.phase === 'ended') return send(ws, { t: 'error', code: 'ended', message: 'This game has ended.' });
    if (this.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'full', message: 'Room is full.' });
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return send(ws, { t: 'error', code: 'name_taken', message: 'That nickname is taken.' });

    const player = {
      id: token().slice(0, 10),
      token: token(),
      name,
      score: 0,
      streak: 0,
      socket: null,
      disconnectedAt: 0,
      answers: new Map(), // qIndex -> { choice, at, correct, points }
    };
    this.players.set(player.id, player);
    send(ws, { t: 'joined', pin: this.pin, playerId: player.id, token: player.token, name });
    this.bindPlayer(player, ws);
    this.broadcast();
  }

  resumePlayer(ws, tok) {
    const player = [...this.players.values()].find((p) => p.token === tok);
    if (!player) return send(ws, { t: 'error', code: 'unknown_session', message: 'Session expired. Please join again.' });
    send(ws, { t: 'joined', pin: this.pin, playerId: player.id, token: player.token, name: player.name });
    this.bindPlayer(player, ws);
    this.broadcast();
  }

  bindPlayer(player, ws) {
    // Only one live socket per player: a reconnect supersedes the stale one.
    if (player.socket && player.socket !== ws) player.socket.close(4000, 'replaced');
    player.socket = ws;
    player.disconnectedAt = 0;
    ws.ctx = { role: 'player', room: this, playerId: player.id };
    this.touch();
  }

  detach(ws) {
    const ctx = ws.ctx;
    if (!ctx) return;
    if (ctx.role === 'host' && this.hostSocket === ws) this.hostSocket = null;
    if (ctx.role === 'player') {
      const p = this.players.get(ctx.playerId);
      if (p && p.socket === ws) {
        p.socket = null;
        p.disconnectedAt = Date.now();
      }
    }
    if (this.connectionCount() === 0) this.emptySince = Date.now();
    this.broadcast();
  }

  connectionCount() {
    let n = this.hostSocket ? 1 : 0;
    for (const p of this.players.values()) if (p.socket) n++;
    return n;
  }

  // ---------- host commands ----------

  hostCommand(cmd, msg) {
    this.touch();
    // Phase-changing commands are tagged with the phase they were clicked in;
    // drop stale ones so a double click or a resend never skips a question.
    if (msg.expect !== undefined && cmd !== 'kick' && msg.expect !== `${this.phase}:${this.qIndex}`) return;
    switch (cmd) {
      case 'start':
        if (this.phase !== 'lobby' || !this.ready) return;
        if (this.players.size === 0) return send(this.hostSocket, { t: 'error', code: 'no_players', message: 'Wait for at least one player.' });
        return this.goPreview(0);
      case 'skip':
        if (this.phase === 'question') this.goReveal();
        return;
      case 'next':
        if (this.phase === 'reveal') {
          return this.qIndex >= this.questions.length - 1 ? this.goEnded() : this.setPhase('leaderboard', 0);
        }
        if (this.phase === 'leaderboard') return this.goPreview(this.qIndex + 1);
        return;
      case 'kick': {
        const p = this.players.get(String(msg.playerId));
        if (!p) return;
        send(p.socket, { t: 'error', code: 'kicked', message: 'You were removed by the host.' });
        p.socket?.close(4001, 'kicked');
        this.players.delete(p.id);
        return this.broadcast();
      }
      case 'end':
        return this.goEnded();
    }
  }

  // ---------- phases ----------

  setPhase(phase, durationMs, onEnd) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.phaseEndsAt = durationMs ? Date.now() + durationMs : 0;
    if (durationMs && onEnd) this.timer = setTimeout(onEnd, durationMs);
    this.broadcast();
  }

  goPreview(i) {
    this.qIndex = i;
    this.setPhase('preview', PREVIEW_MS, () => this.goQuestion());
  }

  goQuestion() {
    const q = this.questions[this.qIndex];
    const limit = q.timeLimit * 1000;
    clearTimeout(this.timer);
    this.questionStartedAt = Date.now();
    this.phase = 'question';
    this.phaseEndsAt = this.questionStartedAt + limit;
    // Close a little after the visible deadline so answers tapped at 0s
    // that are still in flight over a slow mobile link still count.
    this.timer = setTimeout(() => this.goReveal(), limit + ANSWER_GRACE_MS);
    this.broadcast();
  }

  goReveal() {
    if (this.phase !== 'question') return; // scores must be applied exactly once
    for (const p of this.players.values()) {
      const a = p.answers.get(this.qIndex);
      if (a?.correct) {
        p.streak += 1;
        a.points += Math.min(p.streak - 1, 5) * 100; // streak bonus, capped
        p.score += a.points;
      } else {
        p.streak = 0;
      }
    }
    this.setPhase('reveal', 0);
  }

  goEnded() {
    this.setPhase('ended', 0);
  }

  answer(playerId, msg) {
    const p = this.players.get(playerId);
    const ack = (ok, reason) => send(p?.socket, { t: 'ack', mid: msg.mid, ok, reason });
    if (!p) return;
    const qIndex = Number(msg.qIndex);
    // Idempotent: a retried answer (same question) just gets re-acked.
    if (p.answers.has(qIndex)) return ack(true, 'duplicate');
    if (this.phase !== 'question' || qIndex !== this.qIndex) return ack(false, 'closed');
    const choice = Number(msg.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return ack(false, 'invalid');

    const q = this.questions[qIndex];
    const now = Date.now();
    const limit = q.timeLimit * 1000;
    const elapsed = Math.min(limit, Math.max(0, now - this.questionStartedAt));
    const correct = choice === q.answerIndex;
    // Kahoot-style: 1000 for an instant answer, down to 500 at the buzzer.
    const points = correct ? Math.round(1000 * (1 - elapsed / limit / 2)) : 0;
    p.answers.set(qIndex, { choice, at: now, correct, points });
    ack(true);

    const active = [...this.players.values()].filter((x) => x.socket);
    if (active.length > 0 && active.every((x) => x.answers.has(qIndex))) this.goReveal();
    else this.broadcast();
  }

  // ---------- snapshots ----------

  ranked() {
    return [...this.players.values()].sort((a, b) => b.score - a.score);
  }

  broadcast() {
    this.version++;
    if (this.hostSocket) this.sendSnapshot(this.hostSocket);
    for (const p of this.players.values()) if (p.socket) this.sendSnapshot(p.socket);
  }

  sendSnapshot(ws) {
    const ctx = ws.ctx;
    const base = {
      t: 'state',
      v: this.version,
      serverNow: Date.now(),
      pin: this.pin,
      phase: this.phase,
      ready: this.ready,
      qIndex: this.qIndex,
      total: this.questions.length,
      endsAt: this.phaseEndsAt,
    };
    const q = this.questions[this.qIndex];
    const showQ = q && ['preview', 'question', 'reveal'].includes(this.phase);
    const revealed = this.phase === 'reveal';
    if (showQ) {
      base.question = {
        text: q.text,
        // Choices are hidden during the preview, and the correct index is
        // never sent before reveal, so nobody can peek in devtools.
        choices: this.phase === 'preview' ? null : q.choices,
        timeLimit: q.timeLimit,
        correctIndex: revealed ? q.answerIndex : undefined,
      };
    }

    if (ctx.role === 'host') {
      const ranked = this.ranked();
      Object.assign(base, {
        role: 'host',
        topic: this.topic,
        genNote: this.genNote,
        players: ranked.map((p) => ({ id: p.id, name: p.name, score: p.score, online: !!p.socket })),
        answered: this.phase === 'question' ? [...this.players.values()].filter((p) => p.answers.has(this.qIndex)).length : 0,
      });
      if (revealed) {
        const counts = [0, 0, 0, 0];
        for (const p of this.players.values()) {
          const a = p.answers.get(this.qIndex);
          if (a) counts[a.choice]++;
        }
        base.counts = counts;
      }
    } else {
      const p = this.players.get(ctx.playerId);
      if (!p) return;
      const ranked = this.ranked();
      const rank = ranked.indexOf(p) + 1;
      const a = p.answers.get(this.qIndex);
      Object.assign(base, {
        role: 'player',
        me: { id: p.id, name: p.name, score: p.score, streak: p.streak, rank, of: ranked.length },
        myAnswer: a ? { choice: a.choice, ...(revealed || this.phase === 'leaderboard' || this.phase === 'ended' ? { correct: a.correct, points: a.correct ? a.points : 0 } : {}) } : null,
        ahead: rank > 1 ? { name: ranked[rank - 2].name, gap: ranked[rank - 2].score - p.score } : null,
      });
    }
    if (['leaderboard', 'ended'].includes(this.phase)) {
      base.leaderboard = this.ranked().slice(0, 5).map((p) => ({ name: p.name, score: p.score, streak: p.streak }));
    }
    send(ws, base);
  }

  destroy() {
    clearTimeout(this.timer);
    send(this.hostSocket, { t: 'error', code: 'room_closed', message: 'Room closed.' });
    for (const p of this.players.values()) send(p.socket, { t: 'error', code: 'room_closed', message: 'Room closed.' });
    rooms.delete(this.pin);
  }
}

export function getRoom(pin) {
  return rooms.get(String(pin ?? '').trim());
}

// Periodic cleanup: drop players who left the lobby, and abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    if (room.phase === 'lobby') {
      for (const p of room.players.values()) {
        if (!p.socket && p.disconnectedAt && now - p.disconnectedAt > LOBBY_DISCONNECT_DROP_MS) {
          room.players.delete(p.id);
          changed = true;
        }
      }
    }
    if (changed) room.broadcast();
    const empty = room.connectionCount() === 0 && now - room.emptySince > ROOM_EMPTY_MS;
    if (empty || now - room.lastActivity > ROOM_IDLE_MS) {
      console.log(`[room ${room.pin}] collected`);
      room.destroy();
    }
  }
}, 30_000).unref();
