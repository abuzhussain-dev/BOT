# RUIN BOT

AI-orchestrated Minecraft **Java 1.21.11** grinding bot for the Aternos server
`RUIN_SMPS1.aternos.me:56892`. Runs on Termux (Android) or any Node.js box.

Built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) with an
optional LLM "brain" (OpenAI-compatible) and a built-in heuristic fallback so
it always grinds, even with no API key.

## Features (v0.1 foundation)

- Connects to the server, logs in automatically with `/register` + `/login`
- Reconnects with backoff after drops/kicks
- Core skills: `goto`, `digBlock`, `mineType`, `chopTree`, `collectNearby`,
  `eat`, `dropJunk`
- AI planner: converts bot state + skill list into the next task (structured
  JSON). Heuristic fallback when the LLM is not reachable
- In-game chat control (`/bot` prefix — configurable):
  - `/bot status`
  - `/bot mine stone`
  - `/bot goto 100 64 -200`
  - `/bot dig 100 64 -200`
  - `/bot eat`
- Daily rotating logs in `logs/`

## Setup (Termux)

```bash
pkg update && pkg install nodejs git
git clone https://github.com/abuzhussain-dev/BOT
cd BOT
npm install
cp .env.example .env
# edit .env: set BOT_PASSWORD (Server password you use on /login), optionally the LLM block
npm start
```

Keep Termux running with the screen on top. If Termux gets killed, run again
with a TSBox/tmux session.

## Config (.env)

| Variable | Default | Meaning |
|---|---|---|
| `BOT_USERNAME` | `BOTC` | In-game name |
| `BOT_PASSWORD` | — | Password for `/register` and `/login` |
| `SERVER_HOST` / `SERVER_PORT` | — | `RUIN_SMPS1.aternos.me` / `56892` |
| `MINECRAFT_VERSION` | `1.21.11` | Must match the server |
| `AUTH_MODE` | `offline` | `offline` for Aternos when online-mode off |
| `LLM_BASE_URL` | — | Any OpenAI-compatible endpoint (set to enable the brain) |
| `LLM_API_KEY` / `LLM_MODEL` | — | Your key and model name |
| `PLAN_INTERVAL_SEC` | `8` | Seconds between plan cycles |
| `SAFE_HEALTH` | `16` | Health → retreat/eat below this |
| `RECONNECT` / `RECONNECT_DELAY_SEC` | `true` / `15` | Auto-reconnect |

> Set `LLM_BASE_URL` (e.g. DeepSeek, OpenAI, Groq, Ollama at
> `http://127.0.0.1:11434/v1`) to turn on the AI planner. No key needed for the
> heuristic mode.

## Architecture

```
src/
├── index.js       # entrypoint + shutdown
├── config.js      # env config
├── bot.js         # mineflayer client, reconnect, chat commands
├── auth.js        # /register + /login state machine
├── motion.js      # pathfinder helpers (goto, approachBlock)
├── llm.js         # OpenAI-compatible client + tolerant JSON parse
├── skills/
│   ├── index.js   # skill registry: run(name, args) with validation + timeout
│   └── foundation.js  # the core skill implementations
└── agents/
    ├── brain.js   # main loop: state → plan → skill → repeat
    └── planner.js # LLM planner (structured JSON) + heuristic fallback
```

### Loop

```
gather state → planner → {task, args} → validate → run skill (60s timeout) → re-plan
                                     └→ heuristic fallback (no key / LLM error)
```

### Adding a skill

1. Add a `{ name, description, args, async run(ctx, args) }` object to
   `src/skills/foundation.js`.
2. It auto-appears in the LLM prompt (name + description + args) so the AI can
   start using it immediately.

`ctx` gives every skill: `ctx.bot` (mineflayer), `ctx.logger`, `ctx.state`.

## Warning

This is a grind automation tool. Use only on servers whose rules allow it, and
keep your bot password somewhere safe — it is stored in `.env` in plaintext.