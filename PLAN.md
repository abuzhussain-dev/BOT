# BOTC — Detailed Build Plan (from RESEARCH.md)

Status date: 2026-08-13 · Current baseline = working JS grinder

> **Standing rule (user-mandated):** when the AI layer is added (Phase E onward —
> model adapter, agent core, planning, context manager, LLM brain), follow
> `/root/plan.md` (the 1.0 spec) as the authoritative design: §11 Model Adapter,
> §12–13 Planning/Replanning, §7–8 Capability Registry/Self-Awareness,
> §10 Context Manager, §39 Verification Boundary, §44 Core Design Rules.
> "AI decides; Mineflayer executes." Where BOT/PLAN.md shorthand conflicts with
> plan.md, plan.md wins.
(`/root/BOT/src/`, mineflayer 4.37 + pathfinder + hitbox fix).

The plan turns RESEARCH.md §9 patterns into concrete, verifiable slices —
each slice stays runnable on the live Aternos server (`RUIN_SMPS1.aternos.me:56892`).

---

## Guiding principles (from research, ranked)

1. **Batch, don't per-tick.** One LLM turn ≈ 8–25 tool calls. Our brain loop is
   currently 1 skill per cycle → must learn to run *sequences*.
2. **Typed feedback after every action.** `{stateDelta, inventoryDelta,
   failureType, progress, stagnation}`. Inventory deltas are the highest-value
   signal.
3. **Bounded 5-layer memory.** Never append transcripts. L1 prompt pointers,
   L2 current-state schema, L3 game knowledge (wiki), L4 episodic summary (≤K
   tokens), L5 triggered skills.
4. **Persistent goal tree** with checkpoints + blocked state, survives restarts.
5. **Skills as file pairs** (`name.json` schema/metadata + `name.md` notes) with
   success counters.
6. **Auto-observe-after-action** so the LLM never needs a separate observation
   turn.
7. **Environment profile persisted** after every login.
8. **Suffix plan repair**: on failure freeze the working prefix, re-plan only the
   tail — no full replan.

---

## Target architecture

```
src/
├── index.js               # entrypoint + shutdown (unchanged)
├── config.js              # .env config (unchanged)
├── bot.js                 # mineflayer client, reconnect, chat cmds
├── auth.js                # register/login (unchanged)
├── motion.js              # pathfinder glue + 1.21.11 hitbox fix (done)
│
├── perception/            # [Phase A]  L2 typed state + auto-observe
│   ├── state.js           #   getBotState() → typed schema (not freeform)
│   └── observe.js         #   observe-after-action: (result, state) → snapshot
│
├── memory/                # [Phase B]  L4 episodic + env profile
│   ├── episodic.js        #   ring-buffer session log, compact ≤ K tokens
│   ├── envProfile.js      #   memory/env.json (spawn, base, day length)
│   └── goals.js           #   goal tree w/ checkpoints + blocked (Phase E)
│
├── context/               # [Phase C]  assemble L1–L5 into the LLM prompt
│   └── builder.js
│
├── exec/                  # [Phase D]  action adapter + feedback
│   ├── feedback.js        #   typed feedback contract
│   └── run.js             #   batch executor (N tool calls / turn)
│
├── skills/
│   ├── index.js           # registry loads from skills/*.json + *.js
│   ├── foundation.js      # existing v0 skills (goto, dig, mineType, …)
│   ├── collect.js         # NEW: mineflayer-collectblock gather pipeline
│   ├── craft.js           # NEW: bot.craft + recipesFor delta check
│   ├── storage.js         # NEW: openContainer deposit/withdraw
│   ├── social.js          # NEW: chat reply / whisper
│   └── meta.js            # NEW: plan/status introspection
│
├── brain/                 # [Phase E]  planner + goal tree
│   ├── planner.js         #   LLM plan (JSON) + heuristic fallback
│   ├── repair.js          #   suffix plan repair
│   └── dispatcher.js      #   routes decisions (fast/strategic) — later
│
└── utils/
```

Plugins wiring order (load order matters): `pathfinder → tool →
collectblock`.

---

## Phase A — Perception (L2 typed state)

**Goal:** deterministic, typed snapshot of the world/self for every decision.

- `perception/state.js`:
  ```
  realm: 'overworld'|'nether'|'end'
  position: {x,y,z}
  health, food, saturation, air
  dimensionLight, timeOfDay, dayCount
  inventory: { itemName: count, … }      // top N
  equipment: {hand, head, torso, legs, feet}
  nearbyBlocks: [{name, dist, dir}]      // top N (e.g. ores, trees, chests)
  nearbyEntities: [{kind, name, dist, hostile|neutral}]   // mobs + items
  targetBlock: {name, harvestable, hardness}
  lastEvent: {type, detail}               // e.g. damage, chat, blockUpdate
  ```
- `perception/observe.js`: `observeAfterAction(bot, actionResult)` →
  returns the re-derived state PLUS the action's typed feedback, so skills can
  return `{result, invDelta, progress}` and observation appends to it.
- **Verify:** a `--once` debug mode prints the typed state for the live world;
  manual spot-check against `/bot status` output.

---

## Phase B — Memory (L4 episodic + env profile) — DONE 2026-08-13

Implemented via swarm (planner→builder→tester→verifier). Files:
`src/memory/episodic.js` (ring buffer, atomic NDJSON, summarize() w/ budget),
`src/memory/envProfile.js` (env.json, observe/saveIfDirty), wired into
bot.js (login/death/end) + brain.js (enqueue/cycle). 23 asserts pass in
`memory_test.js`. Verifier left 3 minor bugs (single HH:MM per fold batch,
>400-backlog drop at load, null-stations edge) — all acceptable for a
grinder. **Open item:** `summarize()` has no auto-trigger — wire it into the
Phase C context builder.

## Phase B — Memory (L4 episodic + env profile)

- `memory/episodic.js`: append-only ring buffer (e.g. last 200 entries) persisted
  to `memory/episodes.ndjson`; `summarize()` folds old entries into bullet points
  under a rolling token budget (K, default 4000) using the LLM, cheapest model.
- `memory/envProfile.js`: writes `memory/env.json` after each login:
  spawn point, base/made-bed, known chests/stations, observed day length,
  ore sighting coordinates (low-confidence list).
- Both plain JSON/NDJSON (survive restarts; no DB dependency).
- **Verify:** login → `memory/env.json` updated; 2 simulated sessions compact to
  a readable summary.

---

## Phase C — Context builder (L1–L5 → prompt)

`context/builder.js` assembles the single prompt per decision:

```
L1  system role + rules (static)
L2  current typed state    (from Phase A, always fresh)
L3  game knowledge         (wiki snippets, recipes via MCP, only on demand)
L4  episodic summary       (from Phase B)          ← the compacted history
L5  triggered skills       (snippets for skills the plan is about to call)
+   manual priority queue (chat /bot mine …)       ← always first
```

- **Hard rule:** never append the previous raw transcript; L4 is the only history
  and it is summarised. (RESEARCH §3 / AgenticSTS bounded-memory contract.)
- **Verify:** unit test asserts prompt size is bounded (< configurable ceiling)
  after 100 simulated actions.

---

## Phase D — Executor + feedback (batch adapter)

- `exec/feedback.js` implements the typed contract:
  ```
  { skill, args, ok, errorType?, stateDelta, invDelta,
    progress, stagnation, durationMs }
  ```
  Inventory delta computed from before/after inventory hashes.
- `exec/run.js`: `runBatch(ctx, steps[])` executes up to N skills per LLM turn,
  each with the existing 60s timeout, collecting per-step feedback. Auto-observation
  between steps (Phase A). Stops early on `stagnation` or a failed critical step.
- Skills migration: each skill returns `{result?, feedback?}` instead of a string
  (default feedback is synthesised from inv/state deltas).
- **Verify:** log a batch, assert each step produced a feedback row; simulate a
  `stagnation` step → executor halts the batch.

---

## Phase E — Planner + goal tree

- `memory/goals.js`: JSON goal tree
  ```
  { goal, status: active|blocked|done, checkpoints:[{label, done}],
    parent?, children:[], createdAt, lastRunAt }
  ```
  persisted to `memory/goals.json`. On restart, resume active goals instead of
  asking anew (Voyager-style). Mark branches `blocked` with a reason so the
  planner stops re-attempting (e.g. "need crafting_table").
- `repair.js`: given a failed step at index i, freeze steps 0..i-1 ("done
  prefix"), ask LLM to re-plan only steps i..end.
- `planner.js` (upgrade): output becomes multiple steps per turn
  `[{task,args} *≤ N]` + `goal` + `adjustedGoal`, consumed by `exec/run.js`.
- **Verify:** kill bot mid-goal, restart → resumes from last checkpoint (not L1).

---

## Phase F — Plugin upgrade (collect/tool/craft/storage)

One `npm i` of `mineflayer-tool mineflayer-collectblock`, then new skills:

- `skills/collect.js`: `bot.collectBlock.collect(findFromVein(block), { chestLocations, ignoreNoPath })` — replaces hand-rolled dig+pickup for bulk.
- `skills/craft.js`: `bot.craft(recipe, count, table)`; use `recipe.delta` to
  detect missing ingredients; `recipesFor` only-craftable filtering.
- `skills/storage.js`: `openContainer → deposit/withdraw → close`; used for
  bases and auto-deposit overflow.
- Keep `mineflayer-auto-eat` OUT (ESM-only, GPL dep) — custom eat skill stays.
- **Verify:** on-live run: collect 16× stone, craft sticks+torches, deposit to
  chest. `ponytail` note if collectblock fights the custom dig logic (either
  drop ours or bridge).

---

## Phase G — Dispatcher / model tiers (later, optional)

Route decision classes to model tiers: fast/simple (heuristics) vs strategic
(LLM) vs analytics (episodic summariser). RESEARCH §9 AgenticSTS. Deferred —
single-model is fine for the current scale.

---

## Rollout order & definition of done per session

1. **[A]** state smoke test on live server (rerun today)
2. **A→B** persist env profile + episodes; verify restart resume
3. **B→C** bounded prompt builder; verify ≤ K tokens under load
4. **C→D** executor + feedback; verify batches, stagnation halts
5. **E** goal tree + suffix repair; verify restart resume, blocked sticky
6. **F** plugin install + 3 new skills; verify gather→craft→deposit live

Each phase = one session slice, kept small and independently verifiable.

---

## Files this plan will touch (new, unless noted)

- `src/perception/{state,observe}.js`  (new)
- `src/memory/{episodic,envProfile,goals}.js` (new)
- `src/context/builder.js` (new)
- `src/exec/{feedback,run}.js` (new)
- `src/skills/{collect,craft,storage,social,meta}.js` (new)
- `src/brain/{planner,repair,dispatcher}.js` (rewrite/extend)
- `package.json` (+mineflayer-tool, +mineflayer-collectblock)
- `memory/` dir (+env.json, episodes.ndjson, goals.json — gitignored)

Sources: RESEARCH.md (`mcp/wiki/` corpus for the implementer).