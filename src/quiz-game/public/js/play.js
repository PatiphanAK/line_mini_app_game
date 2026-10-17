import { ReliableSocket, shapeSVG, esc, statusBadge } from './net.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'quiz-player';
const urlPin = new URLSearchParams(location.search).get('pin') || '';

let session = load();
if (session && urlPin && session.pin !== urlPin) session = null; // different game
let pendingJoin = null;
let state = null;
// What this phone picked, shown immediately before the server confirms.
let local = { qIndex: -1, choice: null, acked: false };

$('join').pin.value = urlPin || session?.pin || '';
if (urlPin) $('join').name.focus();

const net = new ReliableSocket({
  onOpen() {
    if (session) net.send({ t: 'player:resume', pin: session.pin, token: session.token });
    else if (pendingJoin) net.send(pendingJoin);
  },
  onMessage,
  onStatus: statusBadge($('status')),
});
net.connect();

function load() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function save(s) {
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
}

$('join').addEventListener('submit', (e) => {
  e.preventDefault();
  pendingJoin = { t: 'player:join', pin: e.target.pin.value.trim(), name: e.target.name.value.trim() };
  $('joinBtn').disabled = true;
  if (net.isOpen()) net.send(pendingJoin);
});

function onMessage(msg) {
  if (msg.t === 'joined') {
    pendingJoin = null;
    save({ pin: msg.pin, token: msg.token });
    history.replaceState(null, '', `/play?pin=${msg.pin}`);
    net.markReady(); // now it's safe to resend any unacked answer
    return;
  }
  if (msg.t === 'error') return onError(msg);
  if (msg.t === 'state') {
    state = msg;
    render();
  }
}

function onError(msg) {
  $('joinBtn').disabled = false;
  pendingJoin = null;
  if (['kicked', 'room_closed', 'ended'].includes(msg.code)) {
    save(null);
    net.stop();
    $('msgTitle').textContent = msg.message;
    $('strip').hidden = true;
    return show('message');
  }
  if (msg.code === 'unknown_session' || msg.code === 'no_session') {
    save(null);
    state = null;
    show('join');
  }
  toast(msg.message);
}

function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.dataset.screen === name);
}

function render() {
  const s = state;
  document.body.classList.remove('correct', 'wrong');
  $('strip').hidden = false;
  $('stripName').textContent = s.me.name;
  $('stripScore').textContent = s.me.score.toLocaleString();

  if (s.phase === 'lobby') {
    $('lobbyName').textContent = s.me.name;
    return show('lobby');
  }

  if (s.phase === 'preview') {
    $('pvCounter').textContent = `Question ${s.qIndex + 1} of ${s.total}`;
    $('pvText').textContent = s.question.text;
    return show('preview');
  }

  if (s.phase === 'question') {
    // Server state wins; local pick covers the gap until the ack arrives.
    const picked = s.myAnswer?.choice ?? (local.qIndex === s.qIndex ? local.choice : null);
    if (picked !== null && picked !== undefined) {
      $('waitTitle').textContent = s.myAnswer || local.acked ? 'Answer locked in' : 'Sending answer…';
      $('waitSub').innerHTML = `You picked ${shapeSVG(picked, 18)}  Waiting for the others…`;
      return show('waiting');
    }
    $('qCounter').textContent = `${s.qIndex + 1} / ${s.total}`;
    $('qText').textContent = s.question.text;
    $('answers').innerHTML = s.question.choices.map((c, i) => `
      <button class="answer a${i}" data-i="${i}">${shapeSVG(i, 40)}<span>${esc(c)}</span></button>`).join('');
    return show('question');
  }

  if (s.phase === 'reveal') {
    net.clearOutbox(); // anything still unsent is too late now
    const a = s.myAnswer;
    const correct = a?.correct;
    document.body.classList.add(correct ? 'correct' : 'wrong');
    $('resIcon').textContent = correct ? '✓' : '✗';
    $('resTitle').textContent = !a ? "Time's up" : correct ? 'Correct' : 'Incorrect';
    $('resPoints').textContent = correct ? `+${a.points.toLocaleString()}` : '+0';
    $('resPoints').hidden = !a;
    const right = s.question.choices[s.question.correctIndex];
    $('resSub').innerHTML = [
      correct && s.me.streak >= 2 ? `🔥 Answer streak ${s.me.streak}` : '',
      !correct ? `Answer: <b>${esc(right)}</b>` : '',
      `You're in ${ordinal(s.me.rank)} place`,
    ].filter(Boolean).join('<br>');
    return show('result');
  }

  if (s.phase === 'leaderboard') {
    $('rankTitle').textContent = `${ordinal(s.me.rank)} place`;
    $('rankSub').innerHTML = s.ahead
      ? `${s.ahead.gap.toLocaleString()} pts behind <b>${esc(s.ahead.name)}</b>`
      : "You're in the lead! 🏆";
    return show('rank');
  }

  if (s.phase === 'ended') {
    const medal = ['🥇', '🥈', '🥉'][s.me.rank - 1] || '🎉';
    $('rankTitle').textContent = `${medal} ${ordinal(s.me.rank)} of ${s.me.of}`;
    $('rankSub').textContent = `Final score: ${s.me.score.toLocaleString()}`;
    save(null);
    return show('rank');
  }
}

$('answers').addEventListener('click', async (e) => {
  const btn = e.target.closest('.answer');
  if (!btn || !state || state.phase !== 'question') return;
  const qIndex = state.qIndex;
  const choice = Number(btn.dataset.i);
  if (local.qIndex === qIndex) return; // already answered this one
  local = { qIndex, choice, acked: false };
  navigator.vibrate?.(30);
  render();
  const res = await net.sendReliable({ t: 'player:answer', qIndex, choice });
  if (local.qIndex !== qIndex) return;
  if (res.ok) {
    local.acked = true;
  } else if (res.reason !== 'cancelled') {
    toast(res.reason === 'closed' ? 'Too late, time was up!' : 'Answer was not accepted.');
  }
  if (state?.phase === 'question') render();
});

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function tick() {
  requestAnimationFrame(tick);
  if (!state || !['preview', 'question'].includes(state.phase)) return;
  const total = state.phase === 'preview' ? 3000 : state.question.timeLimit * 1000;
  const left = Math.max(0, state.endsAt - net.serverNow());
  const el = $(state.phase === 'preview' ? 'pvTimer' : 'qTimer');
  el.dataset.s = Math.ceil(left / 1000);
  el.style.setProperty('--p', `${(left / total) * 100}%`);
}
tick();

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
