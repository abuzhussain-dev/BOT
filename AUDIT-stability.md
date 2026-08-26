# AUDIT — STABILITY & CONNECTION — 2026-08-26

Evidence: /tmp/bot-boot.log (full read). Files: src/bot.js, src/auth.js, src/index.js,
src/motion.js, src/controller.js, src/agents/brain.js, src/llm.js, start-bot.sh.
NO source modified.

## 1. Timers that can outlive a bot instance

| Timer | Location | Cleared? | Risk |
|---|---|---|---|
| 150s spawn timeout | bot.js:47-52 | Only on `spawn` (bot.js:67), never on `end`/`stop` | HIGH: fires against the NEXT bot |
| 5s /spawn-position check | bot.js:78-90 | Fire-and-forget | LOW now: `!bot \|\| bot._client === null` guard at :79 covers null deref |
| reconnectTimer | bot.js:178 | stop() :190 | MED: probe `.then` (:173-184) can create a NEW timer after stop() ran |
| auth poll loop | auth.js:95 | Self-terminates (≤120s) | Holds stale `this.bot` only |

## 2. Teardown sequence vs handler lifetime (smoking gun)
`start()` declares `let spawnHandled` per-call (bot.js:43) but the 150s timer body reads the MODULE-level `bot` (bot.js:48). Sequence proven by log:
- 10:03:37 connect #2 kicked "already online" → never spawns → its 150s timer never cleared.
- 10:06:07 timer fires: own-closure `spawnHandled`=false but module `bot` = healthy session-3 instance → `bot.end('spawn-timeout')` kills a GOOD connection (log 10:06:08).
- Cascade repeats: next stale timer kills the 10:06:19 connect 1s after dialing (log :104-105).
The historic bot.js:79 TypeError (`reading '_client'`) was this same family; the current
`!bot` guard fixes the null-deref but NOT the wrong-instance kill.

Other lifetime leaks:
- `auth = auth || new AuthManager(bot, cfg)` (bot.js:71): AuthManager is a singleton whose
  `message` hook is bound to the FIRST bot only (auth.js:23-27). Sessions 2+ never hear the
  server, and `say()` chats into the dead bot (auth.js:79).
- `_loginAttempts` and `state` are never reset per session (auth.js:21-22,107): after first
  successful login, `state===LOGGED_IN` forever → `login()` returns instantly WITHOUT sending
  `/login` (`_loginAttempts<1` false). Log proof: 10:31:02-10:31:02 session shows NO `[auth]`
  lines at all; 10:27:26 "login took too long"; quadruple `/login` burst 10:25:26-29.
- `bootAttempts` written (bot.js:14,69,181) but never READ — intended backoff escalation absent.

## 3. LoginSecurity ghost session (kick loop)

Drop (ECONNRESET) → server keeps player registered ~30-90s → probe says "online" → fixed 10s
retry (bot.js:175-176) → kicked "already online" (log 10:03:38, 10:03:49, 10:04:28, 10:26:02,
10:26:14, 10:30:37, 10:30:49). `kicked` handler deliberately ignores reason (bot.js:118-122)
and 'end' always re-probes to 10s. Nothing distinguishes ghost-session kicks from real ones.
Prevention: on kick reason matching /already online/i, wait 45-60s before retry.

## 4. Crash safety net

- index.js has SIGINT/SIGTERM/unhandledRejection (:6-8) but NO `uncaughtException` handler.
  Both of today's hard deaths were uncaught exceptions escaping timers/modules:
  bot.js:79 TypeError (log 10:28:33-10:28:35) and llm.js:19 SyntaxError variant (log 10:09).
  Process died and stayed dead: start-bot.sh launches ONCE (nohup, no loop, :6).
- llm.js:19 is already fixed in tree (`?? (... || 'none')` parenthesised) — crash was stale file.

## 5. Ranked root causes

1. Stale 150s spawnTimeout kills the NEXT healthy connection (bot.js:47-52; log 10:06:07).
   [effort S]
2. AuthManager singleton: no per-session reset + hook bound to dead bot (bot.js:71;
   auth.js:21-22,27,107). Explains "session not remembered"/repeated logins. [S/M]
3. Reconnect policy: fixed 10s after ghost-kick loops; fixed 300s offline backoff can miss a
   fast Aternos restart (probe runs once, then blind sleep, bot.js:171-184). [M]
4. No uncaughtException net (index.js) + non-supervising start-bot.sh → any stray throw is a
   dead bot until manual restart. [S]

## 6. Fix list (sketches)

F1 bot.js — instance-safe spawn timer [S]
```js
let spawnTimer = null                       // module scope
// start(): const thisBot = bot ; clearTimeout(spawnTimer)
spawnTimer = setTimeout(() => {
  if (bot !== thisBot) return               // stale timer from a previous instance
  if (!spawnHandled) { ... bot.end('spawn-timeout') }
}, 150000)
// 'end' handler + stop(): clearTimeout(spawnTimer)
```

F2 auth — fresh manager per session [S]
```js
// bot.js:71 → auth = new AuthManager(bot, cfg)   (old ones GC with their bot)
// optional: AuthManager.reset(){ state=PENDING; _loginAttempts=0 } in constructor
```

F3 bot.js — reason-aware reconnect backoff [M]
```js
bot.on('kicked', r => { kickReason = String(r) })
// scheduleReconnect: if /already online/i.test(kickReason) → delay 45
// offline branch: loop { probe; if online break; await sleep(60s) } instead of 300s sleep
// escalate: delay = min(10 * 2**bootAttempts, 120); reset on successful spawn
```

F4 index.js + start-bot.sh — crash safety net [S]
```js
process.on('uncaughtException', e => logger.error(`uncaught: ${e.stack||e}`))
// keep running; bot layer self-heals via 'end'→scheduleReconnect
```
```bash
while true; do node src/index.js >> /tmp/bot-boot.log 2>&1; echo "[supervisor] exit=$? restart in 5s" >> /tmp/bot-boot.log; sleep 5; done
```

F5 bot.js stop() — cancel in-flight probe result: set a `generation` int; ignore `.then`
if generation changed. Prevents post-shutdown timer resurrection. [S]
## Stability score: 4/10
Crash class from null-deref is patched, but stale-timer kill (#1) and silent auth failure (#2) are live; recovery depends on a human noticing a dead process (#4).
