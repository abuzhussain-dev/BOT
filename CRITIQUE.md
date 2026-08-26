# BOTC Hostile Design Review — 2026-08-26

## Executive verdict

This is a well-instrumented corpse: genuinely good perception plumbing (typed state, inv-delta feedback, bounded prompts) wrapped around a decision core that cannot finish its own tech tree, wipes its own memory on every restart, and keeps executing stale task chains straight through its own deaths. It does not need a smarter LLM; it needs the signals it already computes to be wired to anything at all.

## Deep flaws

### 1. [CRITICAL] Tech-tree bootstrap is impossible in non-oak biomes (variant deadlock)
- Evidence: planner.js:244,255 enqueues `craftItem {name:'oak_planks'}` unconditionally; foundation.js:133-139 chopTree grabs nearest of 7 species. Log: acacia_log chopped 10:52:48 → `craftItem oak_planks: missing ingredient` 10:53:46 → stick fails 10:54:19 → `craftItem wooden_pickaxe: TypeError: Cannot read properties of null (reading 'id')` 10:54:37, twice.
- Why: the entire wood→pickaxe chain deadlocks whenever the nearest tree isn't oak. Bot then grinds stone bare-handed forever (observed 10:55-10:56) because the gate demands a pickaxe it can never craft. This is the "impossible goal loop," and it's structural.
- Fix: derive plank name from held log (`acacia_log`→`acacia_planks`), or search all `*_planks` recipes for one whose delta matches inventory. Validate each chain step against live inventory at execution time, not at enqueue time.

### 2. [CRITICAL] Memory is never loaded and never folded — the memory subsystem is dead code in production
- Evidence: `episodic.load()`, `episodic.summarize()`, `envProfile.load()` have zero production callers (grep: only memory_test.js). No summary.json exists. bot.js login path saves a DEFAULT()-based profile.
- Why: (a) env.json (ores/chests/stations) is wiped on every reconnect — 7 restarts today, 7 knowledge resets; (b) the HISTORY prompt slice is permanently empty, so "long-term memory" contributes nothing; (c) episodes.ndjson is append-only and `entries[]` grows unbounded (EPISODE_CAP only applies inside the never-called load) → slow RAM+disk leak, a 7-day killer; (d) restart amnesia makes "learning" marketing fiction.
- Fix: call both loads at boot; run summarize() on a timer or every KEEP_RECENT episodes; cap entries[] inline in record().

### 3. [CRITICAL] Death resets nothing and the manual queue persists through respawns
- Evidence: bot.js:124-131 death handler only writes an episode. brain.js:13 `queue` is module-scoped: the 12-step bootstrap chain queued 10:51:50 kept executing across deaths at 10:52:19 and 10:53:03, producing guaranteed `missing ingredient` failures (10:53:46, 10:54:19, 10:56:32). Server literally announces death coordinates via SimpleTpa; nobody listens.
- Why: on a real SMP this is a death loop: die → respawn with empty inventory → resume a chain premised on items that no longer exist. Also lastCycle feedback from the pre-death action seeds the next plan.
- Fix: on death: clear queue, invalidate lastCycle, record death position, and force a fresh ladder evaluation (which will correctly see empty inventory).

### 4. [CRITICAL] Zero defensive behavior: hostile flags computed, consumed by no one
- Evidence: state.js:75-80 HOSTILE_MOBS set feeds `nearbyEntities[].hostile`; grep shows no consumer in planner, skills, or prompt builder. Skill list (skills/index.js) contains 9 verbs, none defensive: no flee, no block-off, no fight, no night awareness, no shelter.
- Why: low-health heuristic literally returns null ("resting", planner.js:125) — i.e., stand still at <16 HP. On a real SMP that is a free kill at night; a creeper walk-up is unaddressed (Movements avoids creepers when pathing TO something, but nothing paths AWAY). Spawn-camping is unsurvivable: respawn → resume chain → die.
- Fix: pre-plan reflex: hostile within 8m && (night || hp<safeHealth) → run/goto away from threat vector toward lit shelter; treat as higher priority than any queue task.

### 5. [HIGH] Brain tick and skill execution race with no single-flight guard
- Evidence: controller.js:71-79 `run` executes any skill concurrently with brain.cycle(), sharing one pathfinder and toolbelt; motion.js goto() begins with `mv.stop()`, cancelling the other task's path mid-flight. Connection 'end' mid-skill lets the cycle keep driving a corpse → EPIPE storm (log 10:47:05-10:47:33), one of 3 crashes today. No uncaughtException handler exists to catch escapees.
- Fix: one executor owns all skill runs (brain and ctl submit to it); generation counter aborts work when `bot` instance changes; add uncaughtException logger.

### 6. [HIGH] The feedback layer lies in both directions
- Evidence: observe.js marks ok=true for skills that catch their own failures and return strings: eat returns `'no food in inventory'` (foundation.js:182), collectNearby `'no drops nearby'` (:157) — both "successes" with stagnation=false. Conversely invSignature uses countInventory's top-16 truncation (state.js:17-20), so changes outside rank-16 are invisible. Live contradiction: stone mined 10:55:57 (inventory changed) yet collectNearby 15s later reports zero drops within 8m — pickup and inventory-delta disagree, so one is structurally broken (suspect the `e.name === 'item'` filter at foundation.js:155).
- Why: every downstream learner (stagnation detection, LLM's LAST ACTION line, future habit scores) inherits fabricated ground truth.
- Fix: skills throw typed errors instead of returning failure prose; drop the top-16 truncation for signature purposes; log raw nearby-item entities once per collectNearby to diagnose the filter.

### 7. [HIGH] Drop collection ignores despawn timers and its own cadence
- Evidence: foundation.js:150-163 scans 8 blocks, walks with a 20s timeout, sorts nearest-first (not oldest-first), tracks no age. mineType mines exactly one block per ~15s cycle; 3 cobblestone = 45s+ minimum exposure. Pathfinder timeouts (33+ today) abandon drops to the 5-minute despawn clock.
- Why: in a grind where every resource comes from ground drops, a collector that neither widens range nor prioritizes aging drops silently voids the bot's income.
- Fix: record entity metadata timestamp on sight, sort by age, scan 16-24 blocks, and run collectNearby immediately after each successful dig within the same cycle.

### 8. [HIGH] Token economics are inverted: paying for navigation, not for learning
- Evidence: every 8s cycle ships a ~2-4k-token prompt (DEFAULT_BUDGET 8000, builder.js:12) to choose among 9 skills the heuristic already ranks; llm.timeoutSec=60 (config.js:33) means one stalled call blocks the whole brain for ~7 nominal cycles; the free endpoint already 503'd (log 10:51:50). Meanwhile the highest-value LLM job — episodic summarization (episodic.js:80) — is never called (flaw 2).
- Why: maximum spend on minimum-leverage decision, zero spend on actual intelligence accumulation. Random-picker parity follows directly: the LLM's only edge (memory, reflection) is disconnected.
- Fix: invoke the LLM only on novelty: stagnation, conflicting signals, gate transitions, or every Nth idle cycle; spend the savings on periodic summarize().

### 9. [MED] The prompt provides data, not decision support, and its safety rules are unenforceable
- Evidence: builder renders chest coordinates but not contents, ore coordinates but not depth/exposure; L1_SYSTEM says "Never dig straight down. Keep health above 6." (builder.js:50-53) yet nothing validates the parsed task against those rules — `digBlock{x,y,z}` straight down parses fine (planner.js:82-97 has no validator beyond skill existence).
- Why: instructions the architecture cannot enforce are noise the model learns to ignore; a compliant-but-dangerous reply is executed verbatim.
- Fix: post-parse validator: reject tasks violating hard rules (vertical dig under feet, mineType with hostile within N m, digBlock below y=11 without torch), re-ask once, then fall back.

### 10. [MED] extractJson is single-shot with no repair and JSON mode deliberately off
- Evidence: llm.js:57-87 returns null on trailing commas or prose containing braces; planner.js:81 calls with `{json:false}` (comment says Ollama compat) so the provider-side JSON guarantee is unused where it matters most; failure logs only 120 chars (planner.js:85) and silently degrades to heuristics.
- Why: intermittent malformation is indistinguishable from "LLM down" in logs; you lose the free reliability feature for a compatibility case that could be opt-in.
- Fix: request json mode with fallback to plain; on parse failure retry once with "reply with only the JSON object"; log full raw on failure.

### 11. [MED] Three competing version identities for game data
- Evidence: foundation.js:13 and planner.js:169 fall back to mcData('1.20.4'); state.js:120 defaults '1.21.11'; live registry is a third source. Recipe/item IDs resolved from a 1.20.4 dataset drive a 1.21.11 server (prime suspect for the null-'id' craft crash, flaw 1's cascade).
- Fix: one `getDataForBot(bot)` helper resolving once from bot.registry and memoizing; delete all literal fallbacks.

### 12. [MED] Auth can silently fail open, and the brain cannot tell
- Evidence: auth.js:92 `waitForSpawnAndLogin` timeout logs "continuing anyway" and returns false; bot.js:73 proceeds to "[bot] ready" regardless. brain.run() gates only on `bot()?.entity` (brain.js:124) — planning begins while still unauthenticated, when LoginSecurity freezes movement (explains clusters of instant pathfinder Timeouts post-reconnect).
- Fix: expose auth.done; hold cycle() until done or 3 consecutive timeouts, then reconnect rather than play crippled.

### 13. [MED] Operational rot is pre-wired for day 7
- Evidence: logger.js:18 writes logs/YYYY-MM-DD.log with no pruning; start-bot.sh appends to /tmp/bot-boot.log forever; episodes.ndjson + entries[] unbounded (flaw 2); controller.js:102-115 never destroys client sockets, has no conn error handler, and buffers unboundedly for newline-less senders; server.close() in stop() waits on live sockets.
- Fix: daily log prune, size-capped ring buffer for episodes, `conn` error/destroy handling + max buffer, `closeAllConnections()` on stop.

### 14. [LOW] Duplicated domain knowledge is already drifting
- Evidence: PICKAXE_TIERS (planner.js:174-181: netherite=5) vs equipBestTool regex tiers (foundation.js:44-48: netherite=diamond=4); GATED_ORES re-encodes what mcData.harvestTools already answers. Two tables, one truth source ignored.
- Fix: wrap mcData harvestTools in one module; delete hand-rolled tables.

### 15. [LOW] Failure taxonomy is too coarse to learn from
- Evidence: observe.js:57 records errorType = exception constructor name (`Error`, `Timeout`) — the same string for "path unreachable," "server lag," and "wrong tool." result strings carry the nuance but planners key decisions off ok/errorType/stagnation only.
- Fix: normalize to an enum (PATH_UNREACHABLE, NO_DROPS, MISSING_INGREDIENT, NEED_TOOL_TIER, NET_DOWN, TIMEOUT) thrown by skills; make cooldown keys per-error-type, so a NET_DOWN pause doesn't blacklist a perfectly good iron vein.

## What would kill this bot first (ranked)

1. **Bootstrap deadlock** (flaw 1): in any acacia/spruce/birch biome it can never obtain a pickaxe; it punches stone until hunger ends it. Happening right now.
2. **Death loop via persistent state** (flaw 3): first night death empties inventory; surviving queue + untouched ladder re-run doomed crafts; on a populated server, someone notices the pattern and farms it.
3. **Night/mob exposure** (flaw 4): no threat perception wired to action; standing at low HP is a standing invitation to every zombie and every griefer.
4. **Disconnect-storm crash class** (flaw 5 + no supervisor): mid-skill EPIPE escapes as uncaught exception; start-bot.sh launches once; process stays dead until a human notices.
5. **Memory amnesia compounding all of the above** (flaw 2): every restart erases ore knowledge and episode history, so the bot can never accumulate the one asset (map of safe resources) that would let it recover from 1-4.

## If you had 1 hour

Fix the two provable deadlocks first: (1) derive `*_planks` from held log variant and re-validate each bootstrap step against live inventory at execution time instead of enqueueing 12 steps upfront (20 min) — this alone converts the current infinite grind into a working tech tree; (2) wire `episodic.load()` + `envProfile.load()` at boot and a summarize() timer (10 min) so memory survives restarts and the LLM's HISTORY slice stops being permanently empty. Then add a death handler that clears the queue, invalidates lastCycle, and snapshots the death position (10 min), and two pre-plan reflexes — eat below food 15, retreat from hostiles within 8m at night or low HP (15 min). Spend the last 5 minutes adding an uncaughtException handler and a `while true` supervisor loop to start-bot.sh. You would leave with a bot that can actually craft its tools, remember its world, survive its own deaths, and stay up unattended — more progress than any prompt engineering would deliver in a week.
