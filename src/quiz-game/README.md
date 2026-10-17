# Quiz Blitz

A Kahoot-style live quiz game:

- **Three.js** host screen: floating answer shapes that speed up and redden as time runs out, react to the correct answer, and a 3D podium with confetti at the end.
- **Qwen** (Alibaba Cloud Model Studio / DashScope) writes the questions from any topic, difficulty and language.
- **WebSocket** realtime with a server-authoritative game loop built for unreliable mobile networks.

## Run

```bash
cp .env.example .env   # put your QWEN_API_KEY in it
npm install
npm start              # http://localhost:3000
```

- Big screen: open `http://<your-ip>:3000/host`, enter a topic, then **Start**.
- Phones: open `http://<your-ip>:3000/play` and enter the PIN.

### Show players' LINE photo and name (optional)

1. In the [LINE Developers console](https://developers.line.biz/console/), add a LIFF app to a LINE Login channel with **Endpoint URL** `https://<your-host>/play` and the `profile` scope.
2. Put its ID in `.env` as `LIFF_ID=...` and restart.
3. Share the LIFF URL (`https://liff.line.me/<LIFF_ID>?pin=123456`). Players who open it in LINE get their display name filled in (they can still edit it), and their profile photo appears in the lobby, on the scoreboard and on their phone. In an external browser they see a **Use my LINE profile** button; without a `LIFF_ID` the game works with nicknames only.

The server only accepts picture URLs on LINE's CDN (`profile.line-scdn.net`), so a player can't push an arbitrary image to every screen.

If no `QWEN_API_KEY` is set, or Qwen fails, the game falls back to built-in sample questions so it still runs.

## How reliability works

| Problem | What handles it |
| --- | --- |
| Socket drops (Wi-Fi to 4G, phone locked) | Client auto-reconnects with exponential backoff and jitter, and also retries right away on `online` / tab visible |
| Half-open TCP (looks connected, but nothing arrives) | App-level ping every 5 s; no traffic for 12 s forces a reconnect. Server sends a protocol ping every 15 s and terminates sockets that miss it |
| Lost game progress on reconnect | Player and host get resume tokens (`localStorage` / `sessionStorage`). The server keeps score and streak, and the new socket replaces the old one |
| Lost or duplicated answers | Answers go through an outbox and are retried until **acked** by message id. The server stores one answer per player per question (idempotent) |
| Missed or out-of-order events | The server sends a **full state snapshot** on every change, so the client always just renders the latest truth |
| Double-clicking "Next" | Host commands carry the phase they were clicked in (`expect`), and stale commands are ignored |
| Different clocks on each device | Countdowns use the server deadline plus an RTT-corrected clock offset. Scoring is timed on the server, with a 400 ms grace window for in-flight answers |
| Cheating via devtools | The correct answer is never sent before the reveal |
| Abuse | 16 KB max message size, a 20 msg/s rate limit per socket, input validation, and garbage collection of idle rooms |

## Layout

```
server/index.js   HTTP static server + WebSocket routing + heartbeat
server/game.js    Room state machine: lobby → preview → question → reveal → leaderboard → … → ended
server/qwen.js    Qwen prompt, JSON validation, choice shuffling, fallback questions
public/js/net.js  ReliableSocket (reconnect, ping, ack outbox, clock sync)
public/js/scene3d.js  Three.js scene
public/js/host.js / play.js   Host screen and phone controller
```

Scoring follows Kahoot: up to 1000 points for an instant correct answer, down to 500 at the buzzer, plus a streak bonus of +100 per streak (max +500).
