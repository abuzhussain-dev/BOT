# BOTC Pre-Flight Audit — 2026-08-23

Read-only audit by architect agent. Scope: full codebase at /root/BOT.
Method: `node --check` per file, isolated `require()` per module, env/config
review, log-pollution grep, script verification. Test files executed once each
with timeouts (stray node PIDs seen belong to other agents' harnesses — left alone).

## 1. Syntax check (`node --check`)

| File | Loads? | Notes |
|---|---|---|
| src/index.js | PASS | |
| src/config.js | PASS | |
| src/bot.js | PASS | |
| src/auth.js | PASS | |
| src/llm.js | PASS | |
| src/motion.js | PASS | |
| src/utils/helpers.js | PASS | |
| src/utils/logger.js | PASS | |
| src/perception/state.js | PASS | |
| src/perception/observe.js | PASS | |
| src/memory/episodic.js | PASS | |
| src/memory/envProfile.js | PASS | |
| src/agents/planner.js | PASS | |
| src/agents/brain.js | PASS | |
| src/context/builder.js | PASS | shipped by team, compiles clean |
| src/skills/foundation.js | PASS | |
| src/skills/index.js | PASS | |
| mcp/server.js | PASS | |
| context_test.js / context_edge_test.js / memory_test.js | PASS | |
| diag.js / rawdiag.js | PASS | |
| .opencode/plugins/graphify.js | **FAIL** | ESM `import` syntax but CJS context (no `"type":"module"`, `.js` ext). NOT runtime code (opencode editor plugin) — non-blocker |

## 2. Isolated `require()` sweep

| File | Loads? | Notes |
|---|---|---|
| config, llm, motion, auth, helpers, logger | CLEAN | no deps demanded |
| bot.js | CLEAN | **no mocks needed** — connects only when `start()` called; safe to require in tests |
| perception/state, observe | CLEAN | state needs minecraft-data at top level (installed) |
| memory/episodic, envProfile | CLEAN | tolerate missing ndjson/env files |
| agents/planner, brain | CLEAN | brain requires bot.js lazily inside `bot()` fn — good |
| context/builder | CLEAN | exports buildPrompt, buildMessages, buildContext, estimateTokens, DEFAULT_BUDGET |
| skills/foundation, index | CLEAN | registry populated at load |
| **src/index.js** | **BOOTS LIVE BOT** | require() triggers banner logs + real connect to RUIN_SMPS1.aternos.me:56892. Entrypoint-only; NEVER require() it in tests/harnesses |

## 3. Env vars (config.js vs .env.example vs live .env)

| Check | Result |
|---|---|
| .env exists with all 17 keys | YES — incl. SERVER_HOST/PORT, AUTH_MODE=offline, BOT_USERNAME/PASSWORD, RECONNECT*, CHAT_PREFIX, PLAN_INTERVAL_SEC, SAFE_HEALTH, FOOD_THRESHOLD, MINECRAFT_VERSION, LLM_BASE_URL/API_KEY/MODEL/TEMPERATURE/TIMEOUT_SEC |
| Missing vars that would crash startup | NONE — every config key has a default or is present |
| LLM enabled | YES (LLM_BASE_URL set → planner uses deepseek-v4-flash-free @ opencode.ai/zen/v1) |
| Gaps (cosmetic) | `CONTEXT_BUDGET` read by builder.js but not documented in .env.example (safe default 8000); typo "microsooft" in .env.example comment; example version 1.21.1 vs live 1.21.11 |

## 4. Log pollution scan

| Pattern | Hits in src/ |
|---|---|
| TODO / FIXME / XXX / HACK | **0** |
| console.debug | **0** |
| console.log/warn/error | Only inside utils/logger.js (sanctioned logging layer, mirrors to file) — correct pattern, no strays |

## 5. package.json scripts

| Script | Command | Verdict |
|---|---|---|
| start | node src/index.js | CORRECT (main also = src/index.js) |
| mcp | node mcp/server.js | CORRECT (file exists, syntax OK) |
| check | node --check | CORRECT (usage: needs file arg) |
| deps | mineflayer ^4.37.1, pathfinder, minecraft-data, dotenv, MCP SDK, zod | all installed, versions match plan |

## 6. Test executions (this audit)

| File | Result |
|---|---|
| context_test.js | 35 passed, 0 failed |
| context_edge_test.js | 63 passed, 0 failed |
| memory_test.js | 23 passed, 0 failed |
| diag.js / rawdiag.js | ECONNRESET against unreachable Aternos server — expected for live-diag tools, not runtime code |

---

## VERDICT: READY_FOR_LIVE_BOOT — YES

**Hard blockers: none.**

Non-blocking warnings:
1. graphify.js ESM/CJS mismatch (editor plugin only; rename to .mjs if ever loaded).
2. src/index.js boots the live bot on require() — keep out of test paths.
3. Document `CONTEXT_BUDGET` in .env.example before Phase D tuning.
4. diag.js/rawdiag.js need the Aternos server online to be useful.
