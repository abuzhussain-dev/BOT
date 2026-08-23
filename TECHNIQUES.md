# BOTC Phase E — Next Techniques (State-of-the-Art for Minecraft LLM Agents)

## 1. Hierarchical Planning + Skill Libraries (DEPS / Voyager / STEVE-1 style)

**What it is:** A two-tier architecture where a high-level LLM planner selects which skill/module to invoke, and each skill encapsulates a low-level mineflayer action (mine, craft, place, explore). Voyager uses automatically generated skills via Codex; DEPS learns skill hierarchy from demonstration; STEVE-1 conditions VLM on egocentric images + task text.

**How it works (2-3 lines):** High-level planner outputs `skill_name + skill_args` each turn. Skill library dispatches to the named mineflayer module, executes it (often with pathfinder/auto-eat), returns `{ok, result, feedback}` without requiring a new LLM call. Skills are cached and their success rates inform future selection.

**Fit into brain/planner/skills:** Designer complements the existing `brain/planner.js` — instead of raw JSON actions, planner outputs `skill_id` from the registry. `skills/index.js` routes to the named skill, which returns typed feedback. The `dispatcher.js` (Phase F) would decouple fast path (skill execution) from strategic path (new planner call).

**Implementation cost:** **M** (~2-3 days). Existing `skills/foundation.js` provides the pattern. Add `skills/library.js` with a skill map + success-rate tracker. Planner change in `planner.js` to output `skill_id` + minimal args. No new dependencies needed.

---

## 2. Token-Cheap Self-Critique / Reflection Loops

**What it is:** Reflexion-style improvement after failure — the LLM reflects on its own action's outcome and produces a corrected version. Token-cheap variant avoids a full LLM call by using a lightweight critic (small model or heuristic) that proposes a fix, which the main LLM only validates/accepts.

**How it works (2-3 lines):** After action fails (stagnation/error), extract `stateDelta + invDelta + failureType`. Pass through a cheap critic (e.g., rule-based heuristics + embedding similarity to successful past actions). If critic proposes a fix, append it as a `!correction` prompt suffix to the next LLM call; otherwise, fall back to normal planning.

**Fit into brain/planner/skills:** Hook into `exec/run.js` batch executor. After each step with `stagnation: true` or `errorType`, compute a critic signal and store it in `memory/episodic.js`. On the next `buildPrompt`, inject a `$REFLECTION` snippet summarizing the last failure + proposed fix. The main LLM can then decide to retry with the correction or pivot.

**Implementation cost:** **S** (~0.5 day). The `episodic.js` already records per-action feedback. Add a `critic.js` module with rule-based heuristics (e.g., "if inventory full and no chest near → drop item"). No LLM API change needed; the reflection snippet is just text injection.

---

## 3. Curiosity / Novelty Signals for Idle Task Selection

**What it is:** When the bot has completed its current goal and is standing idle, a novelty signal prompts the selection of a new task based on under-explored world regions or undone actions, rather than waiting for chat commands.

**How it works (2-3 lines):** Maintain a `novelty_score(world_region, action)` matrix. Regions recently visited or actions frequently attempted get lower scores. When idle > N ticks, compute top-1 novel region + novel action (e.g., "try fishing", "explore cave"), inject as a low-priority `$CURIOUSITY` system snippet. Mindcraft's task auto-starter and Voyager's "autofetch" use similar ideas.

**Fit into brain/planner/skills:** Extend `memory/envProfile.js` with a `noveltyMap` (set of recently visited chunk coords + action counters). In `brain/planner.js`, add an idle-detection branch: if `!current_goal && ticks_idle > 60`, query novelty map and append a `$CURIOUSITY` prompt line like `"You are idle — consider: explore unvisited chunk at X,Y, try an unfamiliar action."` The planner then either pursues this or returns to chat.

**Implementation cost:** **M** (~3-4 days). Needs novelty map persisted in `memory/envProfile.js` + idle-detection in `brain/planner.js` + `$CURIOUSITY` prompt injection. Leverages existing `bot.time.ticks` and `bot.entity.position`.

---

## Impact/Cost Ranking & Top-3 Actionables

| Rank | Technique | Impact | Cost | Action Now? |
|------|-----------|--------|------|-------------|
| 1 | **Token-cheap self-critique** | High (fixes stagnation loops) | S | ✅ **Immediate** — 0.5 day, reuses existing feedback |
| 2 | **Hierarchical skill selection** | High (enables multi-skill turns) | M | ✅ **This sprint** — planner routes to skill_id |
| 3 | **Curiosity signals for idle bot** | Medium (prevents stuck) | M | ✅ **This sprint** — novelty map + idle hook |

**Top-3 one-liners for implementer:**
1. Add `!correction` heuristic critic after stagnation → inject as prompt suffix (self-critique, S-cost).
2. Change planner output from JSON actions to `skill_id + args` → dispatch via `skills/index.js` (hierarchical planning, M-cost).
3. Track novelty map in `envProfile.js`; when idle > 60 ticks, append `$CURIOUSITY` prompt line (idle task selection, M-cost).