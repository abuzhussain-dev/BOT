# AUDIT — Planning Intelligence & Memory (/root/BOT)

Scope: planner.js, brain.js, context/builder.js, episodic.js, envProfile.js, llm.js,
observe.js, state.js, skills/foundation.js. Evidence: live logs/2026-08-26.log,
memory/episodes.ndjson (30 mineType rows, 16 ok=false-ish patterns).

## 1. One full think loop, traced

```
brain.cycle()
 ├─ state = getBotState()
 ├─ plan(state, {bot, logger, state, skillGot, lastFeedback: lastCycle?.feedback})
 │   ├─ PATH A (LLM, if cfg.llm.enabled)
 │   │    context.buildPrompt(bot,{lastFeedback})
 │   │      slices: L1_SYSTEM | HISTORY(episodic summary bullets) | RECENT(episodic n=12)
 │   │              | LAST ACTION(skill,ok,err,invDelta,stagnation) | STATE(typed JSON,
 │   │              |   incl. equipment.hand, targetBlock.harvestable) | ENV digest | SKILLS
 │   │      budget trims: summary→recent→env→skills→state→lastAction
 │   │    → complete(reasoning_effort=none,~2s) → extractJson → skillsApi.has check
 │   └─ PATH B (planHeuristic): health<16? food<12? → probe dropNames IN FIXED ORDER
 │        [diamond…iron_ore,copper…] via findNearestBlock(24) → FIRST VISIBLE WINS
 │        → mineType{type}. *** lastFeedback arrives in ctx but is NEVER READ ***
 ├─ observeAfterAction: run skill → makeFeedback(ok, invDelta, stagnation=ok&&!invDelta)
 ├─ lastCycle={feedback,state}; episodic.record; envProfile.observe/saveIfDirty
 └─ next cycle: feedback flows ONLY as (a) one text line to LLM, (b) nothing to heuristics
```

Gaps found:
- Path B is blind: `ctx.lastFeedback`, episodic, envProfile are all ignored by planHeuristic.
- Path A sees stagnation as prose ("invDelta:no, stagnation:yes") but system prompt says
  "prefer keeping the bot busy: mine ores", so the bias survives; no enforcement layer.
- Under token pressure the env trim keeps only first 5 lines (spawn/server/version/day),
  cutting chests/ores — drops the most decision-useful lines first.
- brain logs omit task.reason and planner mode ⇒ cannot attribute a cycle to LLM vs
  heuristic from logs; live log shows identical "mineType iron_ore" every ~15s either way.
- Minor: dropNames lists iron_ore twice (planner.js:110-111).

## 2. Does ANYTHING penalize repeating a failed action?

No. stagnation/errorType are computed (observe.js:34) and recorded (episodic), but zero
consumer gates goal selection. Confirmed live: "mined iron_ore … (no inv change)" x4 then
Timeout errors x4, same skill+args, back-to-back cycles. Root physics: bare hands dig
iron_ore (diggable) but drop nothing ⇒ invDelta=false forever; the vein regenerates as
a target because findNearestBlock keeps finding neighbors.

Proposed minimal stagnation detector (effort S):
- brain.js: keep `failCount` map keyed by `skill|JSON(args)`; increment when
  `feedback.stagnation || !feedback.ok`; reset on success. At ≥2, push key into
  `cooldownUntil[key] = Date.now()+N*planIntervalSec` and pass `ctx.cooldowns`.
- planHeuristic: skip candidate ores whose key is in cooldown (one-line filter).
- planner.planWithLLM: append `AVOID RECENTLY (failed 2x): mineType iron_ore — reason`
  line to the user message so the LLM path honors the same signal.
- Optional: log `[brain] stagnation cooldown: <key>` for observability.

## 3. Is episodic memory ever consulted by heuristics?

No. episodic.recent/getSummary feed ONLY buildPrompt (LLM path). planHeuristic reads
state.health/food + vision probes exclusively. envProfile likewise reaches only the LLM
digest (and gets truncated first under budget). Heuristic = amnesiac.

## 4. Inventory-awareness: where tool-tier checks should gate goals

Typed state already carries what's needed: `equipment.hand`, `inventory`,
`targetBlock.harvestable` (state.js). Missing piece: nobody compares held item vs
block.harvestTools. Two gate points:
1. planner.planHeuristic (before returning mineType for an ore): require a pickaxe of
   sufficient tier in inventory (wood→stone/coal, stone→iron+, etc.; tiny static map or
   mc-data harvestTools). If absent, prefer chopTree/mineType stone (hand-harvestable).
2. skills/foundation.js mineType.run (defense in depth): after locating block p, check
   `block.harvestTools` vs held item; bail early with "need stone pickaxe for X" instead
   of digging a no-drop block and burning a cycle. This converts silent stagnation into a
   typed errorType the detector above can act on.

## 5. Rating: 4/10 overall

Heuristic path alone: 2/10 (fixed-priority, memoryless, repeats provably futile actions).
LLM path: 5.5/10 (rich bounded context incl. lastFeedback + recent history, fast after
reasoning_effort fix, but advice is unenforced and biased by the "mine ores" rule;
cycle-to-cycle behavior change is not verified anywhere).

## Ranked fixes

| # | Fix | Target (file/function) | Effort |
|---|-----|------------------------|--------|
| 1 | Tool-tier gate: refuse ore mining without adequate pickaxe | planner.js planHeuristic + skills/foundation.js mineType | S |
| 2 | Stagnation detector: failCount≥2 → cooldown key, honored by both planners | brain.js cycle + planner.js plan/planHeuristic/planWithLLM | S |
| 3 | Read lastFeedback in heuristic: skip ore type that just returned stagnation/error | planner.js planHeuristic | S |
| 4 | Log planner mode + task.reason each cycle (`[brain] chose(llm|heur) ...`) | brain.js cycle, planner.js plan | S |
| 5 | Feed harvestability into typed state per nearbyBlock (canHarvest flag) | perception/state.js nearbyBlocks | M |
| 6 | Reorder env-digest trim to drop static lines (server/version) before chests/ores | context/builder.js buildMessages P6 trim | S |
| 7 | Dedupe iron_ore in dropNames; derive ore priority from envProfile.oreSightings | planner.js planHeuristic | S |
| 8 | Post-decision validator: reject LLM task equal to cooled-down key, re-ask once | planner.js planWithLLM | M |

Fixes 1+2 together eliminate the observed iron_ore loop end-to-end (heuristic stops
proposing it; LLM proposals get vetoed; skill refuses to dig no-drop blocks).
