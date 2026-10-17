import { ReliableSocket, shapeSVG, esc, statusBadge } from './net.js';
import { createScene } from './scene3d.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'quiz-host';
const scene3d = createScene($('bg3d'));

let session = load();
let pendingCreate = null;
let state = null;
let sceneKey = '';

const net = new ReliableSocket({
  onOpen() {
    // Re-attach to our room after any reconnect; the server replies with a snapshot.
    if (session) net.send({ t: 'host:resume', pin: session.pin, hostToken: session.hostToken });
    else if (pendingCreate) net.send(pendingCreate);
  },
  onMessage,
  onStatus: statusBadge($('status')),
});
net.connect();

function load() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function save(s) {
  session = s;
  try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch {}
}

$('setup').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  pendingCreate = { t: 'host:create', topic: f.topic.value, count: Number(f.count.value), difficulty: f.difficulty.value, language: f.language.value };
  $('createBtn').disabled = true;
  if (net.isOpen()) net.send(pendingCreate); // otherwise onOpen sends it
});

function onMessage(msg) {
  if (msg.t === 'host:created') {
    pendingCreate = null;
    return save({ pin: msg.pin, hostToken: msg.hostToken });
  }
  if (msg.t === 'error') {
    if (msg.code === 'unknown_session' || msg.code === 'room_closed') {
      save(null);
      state = null;
      show('setup');
      $('createBtn').disabled = false;
      scene3d.setMode('lobby');
      sceneKey = '';
    }
    return toast(msg.message);
  }
  if (msg.t === 'state') {
    state = msg;
    render();
  }
}

// Every host command carries the phase it was issued from, so a double
// click (or a stale button after reconnect) can't skip ahead twice.
function command(cmd, extra = {}) {
  $('primaryBtn').disabled = true;
  net.send({ t: `host:${cmd}`, expect: `${state.phase}:${state.qIndex}`, ...extra });
}

$('primaryBtn').addEventListener('click', () => {
  const action = $('primaryBtn').dataset.action;
  if (action === 'new') {
    save(null);
    location.reload();
    return;
  }
  command(action);
});
$('endBtn').addEventListener('click', () => {
  if (confirm('End the game now and show the podium?')) command('end');
});

function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.dataset.screen === name);
}

function primary(label, action, enabled = true) {
  const b = $('primaryBtn');
  b.hidden = !label;
  b.textContent = label || '';
  b.dataset.action = action || '';
  b.disabled = !enabled;
}

function render() {
  const s = state;
  const key = `${s.phase}:${s.qIndex}`;
  const phaseChanged = key !== sceneKey;
  sceneKey = key;
  $('endBtn').hidden = ['lobby', 'ended'].includes(s.phase);

  if (s.phase === 'lobby') {
    show('lobby');
    const url = `${location.origin}/play?pin=${s.pin}`;
    $('joinUrl').textContent = `${location.host}/play`;
    $('joinUrl').title = url;
    $('pin').textContent = s.pin;
    $('topicPill').textContent = `Topic: ${s.topic}`;
    $('genStatus').style.display = s.ready ? 'none' : 'flex';
    $('genNote').hidden = !s.genNote;
    $('genNote').textContent = s.genNote || '';
    $('playerCount').textContent = s.players.length ? `${s.players.length} player${s.players.length > 1 ? 's' : ''}` : 'Waiting for players…';
    $('players').innerHTML = s.players.map((p) => `<span class="chip ${p.online ? '' : 'offline'}" data-id="${esc(p.id)}">${esc(p.name)}</span>`).join('');
    primary(s.ready ? 'Start' : 'Generating…', 'start', s.ready && s.players.length > 0);
    if (phaseChanged) scene3d.setMode('lobby');
    return;
  }

  if (['preview', 'question', 'reveal'].includes(s.phase)) {
    show('question');
    const q = s.question;
    $('qCounter').textContent = `${s.qIndex + 1} of ${s.total}`;
    $('qText').textContent = q.text;
    $('timer').hidden = s.phase === 'reveal';
    $('answeredPill').hidden = s.phase !== 'question';
    $('answeredPill').textContent = `${s.answered} / ${s.players.filter((p) => p.online).length} answered`;

    const answers = $('answers');
    answers.hidden = !q.choices;
    answers.classList.toggle('revealed', s.phase === 'reveal');
    if (q.choices) {
      answers.innerHTML = q.choices.map((c, i) => `
        <div class="answer a${i} ${q.correctIndex === i ? 'correct' : ''}">
          ${shapeSVG(i, 34)}<span>${esc(c)}</span>
          ${s.counts ? `<span class="count">${s.counts[i]}</span>` : ''}
        </div>`).join('');
    }

    const bars = $('bars');
    bars.hidden = s.phase !== 'reveal';
    if (s.phase === 'reveal') {
      const max = Math.max(1, ...s.counts);
      bars.innerHTML = s.counts.map((n, i) => `
        <div class="bar"><span>${n}${i === q.correctIndex ? ' ✓' : ''}</span><i class="a${i}" style="height:0%" data-h="${(n / max) * 100}"></i></div>`).join('');
      requestAnimationFrame(() => bars.querySelectorAll('i').forEach((el) => { el.style.height = `${el.dataset.h}%`; }));
    }

    if (s.phase === 'preview') primary(null);
    if (s.phase === 'question') primary('Skip', 'skip');
    if (s.phase === 'reveal') primary(s.qIndex >= s.total - 1 ? 'Show podium' : 'Next', 'next');
    if (phaseChanged) scene3d.setMode(s.phase, { correctIndex: q.correctIndex });
    return;
  }

  if (s.phase === 'leaderboard') {
    show('leaderboard');
    $('board').innerHTML = s.leaderboard.map((p, i) => `
      <div class="board-row" style="animation-delay:${i * 80}ms">
        <span>${i + 1}. ${esc(p.name)}${p.streak >= 2 ? ` 🔥${p.streak}` : ''}</span><span>${p.score.toLocaleString()}</span>
      </div>`).join('');
    primary('Next question', 'next');
    if (phaseChanged) scene3d.setMode('leaderboard');
    return;
  }

  if (s.phase === 'ended') {
    show('ended');
    primary('New game', 'new');
    if (phaseChanged) scene3d.setMode('podium', { top: s.leaderboard.slice(0, 3) });
  }
}

$('players').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip && confirm(`Remove ${chip.textContent}?`)) net.send({ t: 'host:kick', playerId: chip.dataset.id });
});

// Countdown is drawn locally from the server's deadline, corrected for clock offset.
function tick() {
  requestAnimationFrame(tick);
  if (!state || !['preview', 'question'].includes(state.phase)) return;
  const total = state.phase === 'preview' ? 3000 : state.question.timeLimit * 1000;
  const left = Math.max(0, state.endsAt - net.serverNow());
  const el = $('timer');
  el.dataset.s = Math.ceil(left / 1000);
  el.style.setProperty('--p', `${(left / total) * 100}%`);
  if (state.phase === 'question') scene3d.setUrgency(1 - left / total);
}
tick();

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  $('primaryBtn').disabled = false;
}
