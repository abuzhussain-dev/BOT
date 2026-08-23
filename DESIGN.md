# BOTC Phase C — Context Builder Design (`src/context/builder.js`)

Author: architect agent, 2026-08-23. Design only — no source modified.
Spec source: `PLAN.md` §Phase C (L1–L5 → single prompt), bounded-memory hard rule
(never append raw transcripts; episodic summary is the ONLY history).

---

## 0. Role in the system

`builder.js` is a pure-ish assembly module: it takes the live mineflayer bot plus
the last action's typed feedback and produces ONE bounded prompt object
`{ messages, tokens }` ready for `llm.complete(messages)`. It owns no state of
its own except a small cache; all facts come from existing modules:

| Layer | Source module | Call |
|---|---|---|
| L2 self/world state | `perception/state.js` | `getTypedState(bot)` |
| L4 recent episodes | `memory/episodic.js` | `recent(n)`, `getSummary()` |
| Env profile | `memory/envProfile.js` | `get()` |
| L5 skills list | `skills/index.js` | `describeForLLM()`, `has(name)` |
| Manual queue | `agents/brain.js` | passed in by caller (see §4) |

**Known bug designed around:** `planner.js:38` reads `state.lastResult`, but
`getTypedState()` never sets that field, so the planner always sends `"—"`.
Fix pattern (adopted here): the last action result comes from
`episodic.recent(1)[0]` (fields `action`, `ok`, `result`). DESIGN.md recommends
planner pass its own `lastResult` (it already has it in `brain.lastResult`)
OR read `episodic.recent(1)`; builder does not fabricate `state.lastResult`.

---

## 1. Module spec — exported functions

```js
// src/context/builder.js
module.exports = { buildPrompt, buildMessages, estimateTokens, DEFAULT_BUDGET }
```

### 1.1 `buildPrompt(bot, opts) → { ok, messages, tokens, meta } | { ok:false, reason }`

```js
/**
 * @param {object} bot   mineflayer bot instance (may be mid-reconnect)
 * @param {object} [opts]
 * @param {string}  [opts.taskHint]      manual task line from brain queue, if any
 * @param {object}  [opts.lastFeedback]  typed feedback row from observeAfterAction;
 *                                       when omitted builder falls back to episodic.recent(1)
 * @param {number}  [opts.budget]        token ceiling, default DEFAULT_BUDGET (8000)
 * @param {boolean} [opts.includeSkills] default true
 * @returns {{ok:true, messages:Array<{role,content}>, tokens:number,
 *           meta:{ dropped:string[], truncated:Object }}} on success
 *         {ok:false, reason:'not_spawned'} when bot?.entity?.position is absent
 */
async function buildPrompt(bot, opts = {})
```

Async only for symmetry with future L3 retrieval (`wikiLookup`) — today it
contains no awaits. Returns `ok:false` instead of throwing for all edge cases
(§5); callers check `ok` first.

### 1.2 `buildMessages(slices, budget) → { messages, tokens, dropped, truncated }`

Internal workhorse, exported for unit testing with synthetic slices. Takes an
already-gathered slice object:

```js
slices = {
  system,        // string  — L1 rules (static text)
  state,         // object  — L2 getTypedState(bot) output or null
  env,           // object  — envProfile.get() output
  summaryBullets,// string[]— episodic.getSummary().bullets
  recent,        // Array   — episodic.recent(N) entries
  lastFeedback,  // object|null — observeAfterAction feedback row
  skillsText,    // string  — skillsApi.describeForLLM()
  taskHint,      // string|null — manual queue item
}
```

It renders each slice to compact text, measures with `episodic.estimateTokens`
(len/4 heuristic), then trims in priority order (§3) until under budget.
Pure function: same input → same output. No fs/network access.

### 1.3 `estimateTokens(text) → number`

Re-exported passthrough to `episodic.estimateTokens(text)` so tests and callers
use one consistent estimator. Do not reimplement.

### 1.4 Constants

```js
const DEFAULT_BUDGET = parseInt(process.env.CONTEXT_BUDGET, 10) || 8000
```

No other constants exported. Slice budgets are internal but documented in §3.

---

## 2. Context slices assembled

Rendered into exactly two chat messages: one `system` (L1 + L3 pointer + L5),
one `user` (manual task + L4 + last action result + L2). JSON bodies are
minified via `JSON.stringify(obj)` with no spaces; arrays are pre-truncated at
the source (state.js already caps inventory at 16, blocks at 6, entities at 8).

### 2.1 L1 — system role + rules (static, ~250 tok)

Fixed string constant inside builder. Content: identity ("You are BOTC…"),
output contract (`{"task","args","reason"}` JSON only), safety rules (never
dig straight down, keep health > safeHealth), and "coordinates are absolute".

### 2.2 L2 — current typed state (~400–700 tok)

`getTypedState(bot)` verbatim as minified JSON. Already bounded:
realm, position, health, food, air, timeOfDay, dayCount, inventory[≤16],
equipment{}, nearbyBlocks[≤6], nearbyEntities[≤8], targetBlock|null.

### 2.3 Nearby world detail — env profile digest (~150–300 tok)

NOT the full `envProfile.get()` (oreSightings can hold 100 entries ≈ 3k tok).
Builder renders a digest:
- `spawn`, `base`, `server`, `version`, `dayLengthTicks` as-is.
- `chests`: nearest 5 to current position (computed from `state.position`).
- `stations.crafting_table` / `stations.furnace`: nearest 2 each.
- `oreSightings`: grouped counts per ore name within 48 blocks + single
  nearest example coordinate per ore type, e.g. `iron_ore x14 (nearest -120,34,88)`.

### 2.4 L4 — episodic recall (~600–1600 tok)

Two sub-slices, both capped:
1. **Long-term bullets**: `episodic.getSummary().bullets`, newest last, kept
   while under `Math.floor(budget * 0.15)` tokens (drop OLDEST first — they
   were folded oldest-first so newest bullets carry most signal).
2. **Recent actions**: `episodic.recent(n)` where n starts at 12; rendered as
   `[HH:MM] action ok|ERR short-result`. Each entry truncated to 80 chars of
   `result` (entries already cap at 200 on write; we trim harder here).

### 2.5 Last action result (~40–100 tok)

Preferred source: `opts.lastFeedback` → one line
`LAST ACTION: <skill> → ok|ERROR(<errorType>) <result> (invDelta:yes/no, stagnation:yes/no)`.
Fallback (bug workaround): `const last = episodic.recent(1)[0]` →
`LAST ACTION: ${last.action} → ${last.ok ? 'ok' : 'ERR'} ${last.result}`.
If neither exists (fresh boot): omit the section entirely and add `(first turn)`
so the model doesn't hallucinate a history.

### 2.6 L5 — triggered skills / available skills (~200–500 tok)

`skillsApi.describeForLLM()` once, cached by registry size (cache invalidated
if `skillsApi.registry.size` changes). L3 game knowledge stays out of scope
per spec ("only on demand") — the system message carries a fixed note that the
model may ask for recipe/wiki info via a future `explain` task.

### 2.7 Manual priority queue hint (~20–60 tok)

`opts.taskHint` from brain: `MANUAL TASK QUEUED: mine stone (from chat) —
execute or decompose this FIRST.` Rendered at the TOP of the user message,
matching PLAN.md "always first".

---

## 3. Token budget strategy (target < 8k)

Total ceiling: `DEFAULT_BUDGET = 8000` tokens (`CONTEXT_BUDGET` env override),
measured with the len/4 heuristic — deliberately conservative since real
tokenizers usually produce FEWER tokens than chars/4 for JSON-heavy text.

Priority order (trim lower priority first, whole sections at a time):

| P | Section | Soft cap (% of budget) | Trim action when over |
|---|---|---|---|
| 1 | L1 system + rules | 5% | never trimmed (static, tiny) |
| 2 | Manual task hint | 1% | never trimmed |
| 3 | Last action result | 2% | truncate result to 60 chars, then drop |
| 4 | L2 typed state JSON | 12% | drop `nearbyBlocks`, then `nearbyEntities`, then halve `inventory` |
| 5 | L5 skills list | 8% | drop arg lists, then descriptions (names only) |
| 6 | Env profile digest | 5% | chests 5→3→1, ores nearest-only → name-counts only |
| 7 | Episodic recent (n=12) | 10% | n 12→6→3→1, then drop |
| 8 | Episodic summary bullets | 15% | drop oldest until fits |

Algorithm (`buildMessages`):
1. Render every slice to text, measure each.
2. If total ≤ budget: done.
3. Walk priorities 8→3 (lowest first): apply that section's trim step,
   re-measure, stop as soon as under budget.
4. If STILL over after all trims (pathological, e.g. 200-item skill registry):
   hard-slice the user message body to `budget*4` characters, append
   `\n…[truncated]`, record what was dropped in `meta.dropped`.

Guarantees: prompt NEVER exceeds budget; the decision-critical trio
(system+rules, manual hint, typed state) survives every trim path. Typical
steady-state composition lands around 1.5–3k tokens, well under 8k, leaving
headroom for the response.

Verification hook (from PLAN.md): a test feeds 100 fake `episodic.record()`
entries + full state and asserts `tokens < CONTEXT_BUDGET` and
`meta.dropped.length >= 0` with stable schema.

---

## 4. Integration into brain.js / planner.js (no breaking changes)

Both files keep their current exports (`brain: run/enqueue/queue/lastCycle`;
`planner: plan`). Integration is additive, three touch points:

**brain.js cycle() — replace the raw `plan(state, ctx)` call:**

```js
const built = await context.buildPrompt(bot(), {
  taskHint: queue.length ? describeQueued(queue[0]) : null,
  // NOTE: do NOT rely on state.lastResult (never populated by getTypedState);
  // builder falls back to episodic.recent(1) itself.
})
if (!built.ok) return            // not spawned etc. — skip this cycle quietly
const task = queue.length ? queue.shift() : await plan(built.messages, ctx)
```

Minimal-change alternative (if we don't want to change plan()'s signature yet):
keep `plan(state, ctx)` and let the planner pull the prompt itself:

```js
// planner.planWithLLM(state):
const built = await context.buildPrompt(ctx.bot)
if (!built.ok) throw new Error('context unavailable')
return complete(built.messages, { json: false }).then(/* unchanged parsing */)
```

Either way the LLM user-message stops being `JSON.stringify(state)` +
`state.lastResult` and becomes the assembled bounded prompt. The heuristic
fallback `planHeuristic(state, ctx)` is untouched — it needs no prompt.

**Recommended (design choice for implementer):** change `plan(promptOrState, ctx)`
to accept EITHER the old state object (heuristic path uses `.health/.food`
unchanged) OR `{messages}` from builder. Concretely: brain calls
`plan(built.messages, ctx)` and planner detects `Array.isArray(firstArg)`.
This keeps `planHeuristic` reading typed state via `ctx.state` which brain
already passes today (`ctx = { bot, logger, state }`).

**planner.js lastResult fix:** delete the `state.lastResult` reference; the
builder injects LAST ACTION (§2.5). If planner keeps building its own fallback
prompt when context fails, use `episodic.recent(1)[0]?.result ?? '—'` instead
of `state.lastResult || '—'`.

**What must NOT change:** `bot.js` wiring, `observeAfterAction` contract,
`episodic.record()` calls in brain.cycle, exports listed above. The builder is
a leaf dependency (`context/builder.js` requires perception/memory/skills
modules; nothing requires it back except brain/planner).

---

## 5. Edge cases

| Case | Detection | Behavior |
|---|---|---|
| Bot not spawned / reconnecting | `!bot \|\| !bot.entity \|\| !bot.entity.position` | Return `{ok:false, reason:'not_spawned'}`. Caller skips cycle (brain already guards `bot()?.entity` but builder re-checks defensively — double-spawn races exist). |
| World/chunks unloaded | `getTypedState` internals swallow findBlocks errors; `nearbyBlocks` may be empty array | Fine — render as-is. Env-profile digest likewise. No special case needed beyond never crashing: wrap `envProfile.get()` in try/catch → `{}`. |
| Empty memory (fresh install) | `recent(0).length===0 && !summary.bullets.length` | Omit L4 section; include `(no history yet)` marker. Never emit empty headers. |
| No last action yet | `recent(1)` empty AND no `lastFeedback` | Emit `(first turn)` line, see §2.5. This also sidesteps the `state.lastResult` undefined bug. |
| LLM disabled | `cfg.llm.enabled === false` | Builder still works (pure assembly); planner simply won't call it. No gating inside builder — keeps it testable offline. |
| Oversized state (crowded area, 8 hostile mobs + full inventory) | measurement step | Priority trimming §3 drops entities/blocks before anything decision-critical. |
| Corrupt/partial memory files | episodic.load already try/catches; envProfile.load too | Builder treats missing fields with defaults (`bullets ?? []`, `chests ?? []`). No new failure surface. |
| Registry mutated between calls | cache key = `skillsApi.registry.size` | Re-render skills list when size differs. Cheap, correct enough. |
| Budget env var nonsense (`CONTEXT_BUDGET=banana`) | `parseInt` NaN → `\|\| 8000` | Same pattern as existing config. |
| Death screen / respawn window | `bot.health === 0` | State still builds (health:0 is valid input for the planner to decide respawn handling); no special casing in C. |

---

## 6. Test checklist for the builder phase (implementer)

1. `buildMessages` pure-function tests: synthetic slices, assert trim order
   matches §3 table and output ≤ budget for budgets [8000, 3000, 500].
2. `buildPrompt(null)` / `buildPrompt({})` → `{ok:false, reason:'not_spawned'}`, no throw.
3. 100 recorded episodes + realistic state → `tokens < 8000`, LAST ACTION line
   equals `episodic.recent(1)` content (proves the `state.lastResult` workaround).
4. Schema snapshot: message roles are exactly `[system, user]`; user message
   contains section markers in order MANUAL → HISTORY → LAST → STATE.
5. Integration smoke: stub `llm.complete`, run one `cycle()` with context
   wired, assert the captured messages match builder output byte-for-byte.
