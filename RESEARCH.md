# RUIN BOT — Research Compilation

Compiled: 2026-08-13 · Sources: 3 parallel research subagents (websearch + webfetch, all claims URL-cited), plus verified findings from the live 1.21.11 Aternos server.

Upstream docs live in `mcp/wiki/` (searchable by the MCP server) and a
mirror of the same content in `wiki/plugins/` for human reading.

---

## 1. CRITICAL: pathfinding on Minecraft 1.21.11

### The bug
- **mineflayer-pathfinder has a stuck-jump bug on native 1.21.11 servers**
  (mineflayer issue **#3911**, reported ~May 2026). Bots get stuck ~0.2 blocks
  in the air when jumping or stepping up a block; on Aternos (1.21.11) the bot
  cannot climb, cross water, or traverse stairs reliably.
- Root cause: the client's player hitbox half-width (0.3) combined with the
  1.21.11 physics scaling puts the bot "inside" block boundaries so the
  collision solver can't finish the step-up.

### The client-side fix (no OP needed)
From pathfinder **PR #364** (works with stock `mineflayer-pathfinder@2.4.5`):
```js
bot.physics.playerHalfWidth = 0.302   // instead of 0.3
bot.physics.playerHeight   = 1.80002   // instead of 1.8
```
- **Applied** in `src/motion.js` → `apply12111HitboxFix()`.
- Fixes jumping, 1x1 climbing, water egress, stair traversal.
- Tune the offset (0.301–0.305) if a server reports weird movement; the knob is
  deliberately left exposed in the code.

### PvP is broken on 1.21.11
- mineflayer-pvp knockback/velocity inaccurate on native 1.21.11 (issue
  **#3887**; fix submitted to node-minecraft-protocol PR **#1494**, unshipped).
- **Decision: avoid PvP for now.** Combat with a sword via `bot.attack` is fine
  (no velocity decode involved), just don't rely on pvp knockback combos.

### Online-mode note
- Aternos runs **offline mode**; `AUTH_MODE=offline` is correct. Online-mode
  (Mojang/Microsoft auth) needs real credentials and is not needed here.

---

## 2. Plugin compatibility matrix (verified against npm, 2026)

| Package                  | Latest | CJS/ESM | 1.21.11 status | Notes |
|--------------------------|--------|---------|----------------|-------|
| `mineflayer`             | 4.37.1 | CJS     | ✅ supported   | Supports 1.8 – 1.21.11 |
| `mineflayer-pathfinder`  | 2.4.5  | CJS     | ⚠️ needs fix   | No upstream fix; use hitbox workaround |
| `mineflayer-collectblock`| 1.6.0  | CJS     | ✅ (with fix)  | pathfinder+tool+dig+pickup+chest deposit all-in-one |
| `mineflayer-tool`        | 1.2.0  | CJS     | ⚠️ (w/ fix)   | **`bot.tool.equip()` REMOVED** → `equipForBlock()` |
| `mineflayer-auto-eat`    | 5.0.3  | **ESM only** | ✅ | Breaks our CJS require; **skip**, keep custom eat skill |
| `mineflayer-armor-manager`| 2.0.1 | CJS     | ✅            | Most active PvE plugin; `autoEquipAll()` |
| `mineflayer-pvp`         | 1.3.2  | CJS     | ⚠️ #3887      | Knockback broken on 1.21.11 |
| `mineflayer-statemachine`| 1.7.0  | CJS     | ⚠️ unmaintained | Skip unless we need goal-based FSM |
| `minecraft-mcp-server` (yuniko) | 1.2.0 | — | — | MCP→mineflayer adapter; naming reference only |

### Deps already in use
`@modelcontextprotocol/sdk@1.30.0`, `zod@3.24`, `minecraft-data@3.113+`
(supports 1.21.11 natively: 1069 blocks / 1160 items / full food data),
`dotenv@16`.

---

## 3. Pathfinder deep API

All from `mcp/wiki/pathfinder.md`, `mineflayer-api.md`, `unstable_api.md`.

### Core navigation
- `bot.pathfinder.setGoal(goal, dynamic?)` — dynamic=true recomputes path as you move.
- `bot.pathfinder.goto(goal)` → Promise, resolves when reached.
- `bot.pathfinder.setMovements(new Movements(bot, bot.mcData))`
- Events:
  - `bot.on('path_update', ({ status }) => ...)` where status ∈
    `success | partial | timeout | noPath`
  - `bot.on('path_reset', (reasons) => ...)` reason strings include
    `stuck_...`, `no_scaffolding_blocks`, `movement_unchanged`
  - `bot.on('goal_updated', (goal, dynamic) => ...)` — **when the goal is
    cleared `goal` is `null`** (do not destructure blindly). We already handle
    this in `src/motion.js`.
  - `bot.pathfinder.isMoving()`, `bot.pathfinder.isMining()`

### Movements options (property assignment)
```js
const m = new Movements(bot)
m.allow1by1towers = true
m.canDig = true
m.blocksCantBreak = new Set()            // ids
m.entitiesToAvoid = new Set(['creeper']) // names — added creeper by default in our setup
m.scafoldingBlocks = [blockids…]         // e.g. dirt/cobble for bridging
m.canOpenDoors = true
```

### Goals
- `new goals.GoalNear(x,y,z,r)` / `GoalBlock(x,y,z)`
- `GoalGetToBlock(x,y,z)` — adjacent to the block, **perfect for chests**
- `GoalFollow(entity, range)`
- `GoalCompositeAny([…])` / `GoalCompositeAll([…])`
- `GoalInvert(goal)`
- `GoalLookAtBlock(x,y,z,direction)` — holds position facing a block (replaces
  now-removed `GoalBreakBlock`)

### Best tool
- `bot.pathfinder.bestHarvestTool(block)` → returns the optimal tool item, needs
  `m.tools` set first (run `await m.updateTools()` or set `m.tools`).

---

## 4. collectblock — one-call gather pipeline

From `mcp/wiki/collectblock.md`.

```js
const collectBlock = require('mineflayer-collectblock')
bot.loadPlugin(collectBlock)

// gather a resource (pathfind + tool-equip + dig + pickup + auto-deposit)
const targets = bot.findBlocks({ matching, maxDistance: 32, count: 16 })
await bot.collectBlock.collect(targets, {
  chestLocations: [chestPos],   // deposit overflow into chests
  itemFilter: (item) => true,
  append: false,                // when true, adds to current collect queue
  ignoreNoPath: false,          // when true, skips unreachable instead of erroring
})
// returns after all targets dug & items picked up/deposited

// first, just find one block of a vein:
const vein = bot.collectBlock.findFromVein(block, 100 /*maxBlocks*/, 16 /*maxDistance*/)
```

- Eliminates our hand-rolled dig+pickup loop for bulk harvesting.
- Requires `mineflayer-pathfinder` + `mineflayer-tool` loaded **before** it.

---

## 5. Tool plugin

From `mcp/wiki/tool.md`.

- **`bot.tool.equip()` is gone.** Use:
  ```js
  await bot.tool.equipForBlock(block, {
    requireHarvest: true,          // only tools that can actually harvest
    getFromChest: true,            // go fetch from nearby chests if needed
    maxTools: 5,
  })
  // throws if requireHarvest and nothing can harvest
  ```
- Equip types: `'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'`.

---

## 6. Inventory & containers

From `mineflayer-api.md`.

- `bot.inventory.items()` — all items.
- `bot.inventory.count(itemType, metadata?)`, `bot.inventory.slots`.
- Open a container (chest/furnace/etc.):
  ```js
  const window = await bot.openContainer(block)
  await window.deposit(itemType, metadata, count)
  await window.withdraw(itemType, metadata, count)  // throws if bot inv full
  await window.close()
  ```
- `bot.equip(item, slot)`, `bot.tossStack(item, count)`.
- `bot.findBlocks({ matching })` accepts an **id, array of ids, or predicate**
  `(block) => bool`.

---

## 7. Crafting (& recipe gotcha)

From `mineflayer-api.md` + verification against bot runtime.

- **`bot.craftRecipe()` does NOT exist.** Use:
  ```js
  await bot.craft(recipe, count, craftingTable)   // craftingTable = block, optional
  ```
- `bot.recipesFor(itemType, metadata?, minResultCount?, craftingTable?)` —
  only recipes craftable **with current inventory** (respects materials on hand).
- `bot.recipesAll(itemType)` — ignores material availability; use to plan.
- Missing-material detection:
  ```js
  const missing = recipe.delta.some(d =>
    bot.inventory.count(d.id, d.metadata) + d.count * craftCount < 0)
  ```

---

## 8. Food / auto-eat decision

- `mineflayer-auto-eat@5` is **ESM-only** and drags GPL-licensed
  `@nxg-org/mineflayer-util-plugin` — combining with our CJS module graph is
  fragile (dual-package hazard, licensing).
- **Decision: keep the custom CJS eat skill** (`src/skills/foundation.js`),
  driven by `minecraft-data().foodsArray` (name, foodPoints, saturation).
  Diet ranking: cooked meat > golden carrot > bread/berries.

---

## 9. Agent architecture patterns (from 6 published systems)

Research sources (all investigated via webfetch of repo/docs):
- **Voyager / MineDojo** — automatic curriculum, growing skill library, env feedback.
- **Kevin-Liu-01/minecraft-mcp** — Python MCP + Node mineflayer bridge; 60+ tools,
  skill library, multi-step planner, world memory, autonomous survival cycle
  `inspect → plan → execute (≤25 tool calls) → learn`.
- **win10ogod/mc-multimodal-agent** — mineflayer + Responses API; persistent goal
  trees, LevelDB memory, skill snapshots, environment profile,
  auto-observe-after-actions.
- **Pomilon/MC-CIV** — hybrid Python Brain + Node Body (WebSocket); three-layer
  memory (working/episodic/semantic); interruptible actions; side-conversation forking.
- **MineEvolve (arXiv 2603.13131)** — monitor/inducer/curator/adaptor: converts
  execution feedback into skills + remedies.
- **AgenticSTS (arXiv 2607.02255)** — bounded memory contract: fresh prompt per
  decision built from typed layers L1–L5, no raw transcript appending; dispatcher
  routes decisions across fast/strategic/analysis/evolution model tiers.

### Adopt for BOTC (ranked, with rationale)

1. **Batch N tool calls per LLM turn (N=8–25), never per-tick.**
   LLM round-trips cost real seconds (Aternos + network). `brain.js` already
   queues one skill per cycle but must batch *sequences* when a skill returns
   "still in progress / follow-on required". Saves 5–10x on API spend.

2. **Typed-feedback contract after every action.**
   Record after each skill: `{ stateDelta, inventoryDelta, failureType, progress,
   stagnation }`. **Inventory deltas are the highest-value signal** — a skill that
   didn't change inventory didn't work. Feeds both LLM prompts and the heuristic.

3. **Bounded 5-layer memory — never append transcripts.**
   - L1 operator/system prompt (pointers only)
   - L2 current state schema (JSON shape, always fresh)
   - L3 game knowledge (static facts: recipes, ore y-levels — from our wiki)
   - L4 episodic summary (compacted session log ≤ K tokens)
   - L5 triggered skills (most valuable; used on demand)
   Today: `getBotState()` = L2; wiki = L3. Add L4 summary compaction + L5 skill cache.

4. **Persistent goal tree with checkpoints + blocked state** (win10ogod/Voyager).
   Survives Aternos restarts: when the bot reconnects it resumes a half-done
   "get food → make tools → build base" tree instead of asking again. Format:
   plain JSON file in `memory/goals/`. Mark branches `blocked` (e.g. "need
   crafting table") so the LLM doesn't re-attempt them.

5. **Skills as `name.json` + `name.md` file pairs with success counters.**
   Metadata (name, args schema, description, usage count, success rate) in JSON,
   notes in MD. Enables: validate-as-code from JSON schema, description
   auto-injection into LLM prompt (we already list skills; add counters) and
   runtime success gating.

6. **Auto-observe-after-action.** Every tool result includes the re-derived state
   snippet (`health, food, pos, newest inventory lines`) so the LLM doesn't need
   an extra observation round-trip.

7. **Environment profile persisted after login** (`memory/env.json`): spawn point,
   base coords, day length observation, known structures. Reuse across restarts.

8. **Local suffix plan repair** (MineEvolve). On failure, freeze the working
   prefix of a multi-skill plan and re-plan only the tail — cheaper than full
   replan and more stable than blind retry.

### Plugins wiring order (for the upgraded bot)
```
mineflayer
 └ workers ? (multibot)            → not yet
 ├ pathfinder (with hitbox fix)    → loaded
 ├ tool
 ├ collectblock
 └ ... then our skills
```
`collectblock` must load **after** pathfinder+tool — order matters.

---

## 10. MCP server (already implemented)

`mcp/server.js`, run via `npm run mcp`. 8 tools:
`list_versions, search_blocks, get_block, search_items, get_item, foods,
recipes_for, wiki`. Uses `mcp/wiki/*.md` as the doc corpus.

**SDK landmine (verified against @modelcontextprotocol/sdk@1.30 source):**
`registerTool` signature is
`registerTool(name, { title, description, inputSchema }, handler)`.
The old 4-arg string form (`registerTool(name, title, desc, schema, handler)`)
tricks the SDK into storing the schema *as* the handler → runtime crash
`"typedHandler is not a function"`. All tools here use the object form.

---

## Sources
- mineflayer abi/api: https://raw.githubusercontent.com/PrismarineJS/mineflayer/master/docs/api.md (+ unstable_api.md, FAQ.md)
- pathfinder: https://github.com/PrismarineJS/mineflayer-pathfinder (readme.md) — issue #3911 / PR #364
- pvp #3887: https://github.com/PrismarineJS/mineflayer/issues
- collectblock: https://github.com/PrismarineJS/mineflayer-collectblock
- tool: https://github.com/TheDudeFromCI/mineflayer-tool
- auto-eat: https://github.com/linkle69/mineflayer-auto-eat
- armor-manager: https://github.com/PrismarineJS/MineflayerArmorManager
- agent systems: Voyager (MineDojo/Voyager), minecraft-mcp (Kevin-Liu-01), mc-multimodal-agent (win10ogod), MC-CIV (Pomilon), MineEvolve arXiv 2603.13131, AgenticSTS arXiv 2607.02255
- minecraft-mcp-server (yuniko-software)