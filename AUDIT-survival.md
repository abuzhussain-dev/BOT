# SURVIVAL & SKILLS AUDIT — BOT (mineflayer, CommonJS)

Date: 2026-08-26. Evidence: /tmp/bot-boot.log tail (14x "no inv change", 33x path
Timeout, 0x `[skill] eat`, death earlier, empty inventory, food dropping, one hard
process crash `TypeError ... bot.js:79`). Files read: foundation.js, index.js,
planner.js, brain.js, episodic.js, observe.js, state.js, builder.js, motion.js,
config.js. No source files modified.

## Findings table

| # | Area | Symptom (live) | Root cause | Sev |
|---|------|----------------|-----------|-----|
| F1 | planner.js `planHeuristic` | Re-picks iron_ore every cycle despite stagnation | Heuristic branch NEVER reads `ctx.lastFeedback`; only health/food/probe. `stagnation` from observe.js reaches brain but is ignored here | C |
| F2 | foundation.js `mineType`,`digBlock` | "mined iron_ore (no inv change)" | No `block.canHarvest(heldItem)` check. Bare hands break ore, server drops nothing; dig() resolves ok | C |
| F3 | planner.js `hasFood` (L129) | eat never auto-triggers, food 17→starving | Tests `i.foodPoints` on inventory items; mineflayer items lack that field (it's in minecraft-data keyed by `type`). Always false → both eat branches are dead code | C |
| F4 | skills/index.js registry | Cannot progress past punching | No craft/smelt/place skills at all: wood→planks→table→pickaxe chain impossible with these 7 skills | C |
| F5 | brain.js `cycle` | Death → respawn → resumes ore grind | No death/respawn listener; no priority-ladder reset on empty inventory; queue/lastCycle survive reconnect | H |
| F6 | motion.js `approachBlock` | ~50% goto Timeout | Fallback `chosen = pos` paths INTO the solid target; candidates picked blind (`slice(0,3)` then take first); no blacklist of unreachable targets after Timeout | H |
| F7 | foundation.js `eat`,`collectNearby` | feedback.ok can lie | Skills catch their own errors and RETURN failure strings; observe.js marks ok=true, stagnation wrong | H |
| F8 | brain.js L16,107 | dead code | `lastTaskUsedOre` written, never read — an anti-repeat mechanism that was never wired | M |
| F9 | config.js | late + passive eating | foodThreshold=12 (regen stops below 17); low-health branch returns `null` ("resting") instead of eat/flee | M |
| F10 | state.js/builder.js | LLM branch is better fed than heuristic | LLM path gets LAST ACTION + RECENT + summary; heuristic gets none of it. When LLM hiccups, all memory learning is bypassed | M |
| F11 | bot.js:79 | process exit mid-run | Uncaught `bot._client` null in timer after disconnect kills whole agent | M |

Q2 answered directly: the heuristic branch does NOT consult lastFeedback at all
(planner.js L86-127 references only `state.health/food` and probes). Only the LLM
branch passes `ctx.lastFeedback` into context.buildPrompt (L45).

## Root causes ranked

1. Feedback loop is built but not consumed by the fallback brain (F1+F8): the exact
   signal that says "this isn't working" exists in lastCycle and is discarded.
2. No capability model of the self (F2+F3+F4): planner never asks "can I harvest
   this with what I hold / can I craft the tool / is the food check real".
3. No survival reflexes (F3+F9): eating is a planned task behind a broken predicate,
   not an event-driven guard; hunger death is deterministic given the log.
4. No failure adaptation in motion (F6): same unreachable target retried forever.
5. Death resets nothing (F5): progress model assumes monotonic inventory.

## Correct early-game priority ladder for THIS skill set

Gate order evaluated each cycle, highest first:
1. Reflex: food < 15 AND edible present → eat (pre-plan, bypasses planner).
2. Reflex: health < safeHealth → eat if possible, else retreat/idle away from mobs.
3. Dead-flag or inventory empty → chopTree (logs are hand-harvestable) until >=3 logs.
4. Has logs, no pickaxe → [NEW craft skill] planks → sticks → crafting_table → wooden_pickaxe.
5. Has wooden pickaxe, needs stone → mineType stone (canHarvest true) → craft stone_pickaxe + furnace (+ stone_sword).
6. Only now: coal_ore / iron_ore (harvestable with stone pick). Before step 5 they
   are forbidden targets, not merely preferred ones.
7. Food < 15 and no food → collectNearby / chopTree (apples) over mining.
Rule: every mineType/digBlock choice must pass `block.canHarvest(equippedItem)`,
else escalate one rung down the ladder toward wood.

## Auto-eat trigger placement

Primary (S effort): top of brain.js `cycle()`, BEFORE `plan()` and before manual
queue execution: if `bot.food < cfg.eatAtFood (suggest 15)` and an edible exists
(fix F3 predicate) → run eat skill inline, record episode, continue. This covers
manual tasks too. Secondary (M): event-driven `bot.on('health')` /
food-change watcher for instant response during combat/mining. Keep planner-level
eat as third layer. Do NOT rely on the LLM choosing eat (current de facto design).

## Fix list (file + function, effort S/M/L)

| Fix | Target | Change | Effort |
|-----|--------|--------|--------|
| 1 | planner.js `planHeuristic` | Read `ctx.lastFeedback`: if same task+args stagnated/errorTimeout >=2 consecutive, forbid that target (in-memory blacklist passed via ctx) and drop a ladder rung | S |
| 2 | planner.js `hasFood` | Match inventory `item.type` against minecraft-data foodsArray ids (same mapping eat skill already builds) | S |
| 3 | brain.js `cycle` | Insert maybeEat reflex guard before planning; add `eatAtFood` cfg (default 15) | S |
| 4 | foundation.js `mineType`,`digBlock`,`chopTree` | Pre-dig `block.canHarvest(bot.entity.equipment[0]||null)` check; on fail return typed `not_harvestable` error (throw, not string) | M |
| 5 | foundation.js `eat`,`collectNearby` | Throw on real failure so observe.js feedback.ok is truthful | S |
| 6 | motion.js `approachBlock` | Never fall back to `chosen=pos`; validate candidate with quick reachability; halve approach timeout; feed Timeout'd positions into shared blacklist consumed by `findNearestBlock` | M |
| 7 | NEW src/skills/crafting.js + register in index.js | Minimal: craftPlanks, craftSticks, craftTable, craftWoodenPickaxe, craftStonePickaxe using `bot.recipesFor` + table requirement; later smelt/furnace | L |
| 8 | brain.js `run`/`cycle` + bot.js | death listener: set deadFlag, clear queue, force ladder rung 3 on next cycles; fix bot.js:79 null guard | M |
| 9 | config.js + planner.js | foodThreshold 12→15; replace low-health `return null` with flee/eat decision | S |
| 10 | brain.js | Delete or wire up `lastTaskUsedOre` (currently dead) | S |
| 11 | planner.js `planWithLLM` fallback path | On LLM failure, inject lastFeedback-derived facts into heuristic ctx (already plumbed; ensure CONTEXT_BUILDER=off case still passes it) | S |

## Survival intelligence score: 2/10

Justification: perception/memory layers are genuinely good (typed state, invDelta
feedback, env profile, bounded context = would be 7-8/10 alone), but the acting
brain wastes them: the always-on fallback planner ignores feedback entirely, the
eat trigger is provably dead code (broken predicate), mining has no tool-tier
model so the bot burns cycles on unharvestable ore forever, there is no crafting
capability so early-game progression is impossible by construction, and death
resets nothing. Net observed behavior: starve → die → respawn → mine iron with
bare fists → repeat. A 2 reflects working plumbing with no survival reasoning
using it. Fixes 1-5 (all S/M) would raise this to ~5/10; adding 7 (crafting)
unlocks real early-game progression (~7/10).
