# BOTC Phase C Integration Plan — builder.js → brain.js / planner.js

Author: architect agent, 2026-08-23. Wiring plan only — no source modified.
Companion to DESIGN.md. Aligned against in-flight `src/context/builder.js`
(exports `buildPrompt(bot, opts)`, `buildMessages`, `buildContext`,
`DEFAULT_BUDGET`; returns `{ok,messages,tokens,meta}` or
`{ok:false,reason:'not_spawned'}`). Baseline hashes verified unchanged:
brain `ab87e69b…`, planner `fedfd045…`, state `afe0e445…`.

## 1. Where buildPrompt() is called in the think loop

One call site: **inside `planner.planWithLLM()`**, reached from the existing
`plan()` entry that brain.cycle calls once per tick (`brain.js:67`). Keeps
brain thin and `planHeuristic()` untouched.

```
brain.run (8s) ─ cycle()
 ├─ getBotState()                    // unchanged
 ├─ plan(state, ctx)                 // ctx gains lastFeedback (§2)
 │   └─ llm.enabled? planWithLLM(state, ctx)
 │       └─ context.buildPrompt(ctx.bot, { lastFeedback: ctx.lastFeedback })
 │           → {ok, messages:[system,user], tokens, meta} | {ok:false,…}
 └─ observeAfterAction(...)          // unchanged; feeds NEXT cycle's lastFeedback
```

Guards: `ok:false` → warn once, fall through to heuristic; any throw caught
inside planWithLLM → legacy prompt path (§4). brain's entity check stays.

## 2. lastResult flow (fixes planner.js:38 `state.lastResult` bug)

Bug recap: planner interpolates `state.lastResult`, but `getTypedState()`
(state.js:95–115) never defines it → always `"—"`.

Three hops, no schema changes:
1. **brain→planner**: brain already holds the typed feedback row from the
   previous cycle in `lastCycle.feedback` (`skill/ok/errorType/result/
   invDelta/stagnation`). Add it to the ctx it already builds.
2. **planner→builder**: pass straight through as `opts.lastFeedback`.
3. **builder**: prefers `opts.lastFeedback`; episodic fallback;
   `(first turn)` when neither. Delete the `state.lastResult` interpolation.

Why not rely on episodic fallback alone: manual chat tasks record
`{action:'chat', result:'manual queue'}` episodes that would surface as a
misleading LAST ACTION line; explicit feedback is ground truth.

## 3. Exact diff-style change list (smallest possible)

### File 1: `src/agents/planner.js` (+9/−2)

```diff
@@ requires @@
+const context = require('../context/builder')

@@ plan(): pass ctx through @@
-      const task = await planWithLLM(state)
+      const task = await planWithLLM(state, ctx)

@@ planWithLLM @@
-function planWithLLM(state) {
+async function planWithLLM(state, ctx) {
   const system = `You are the planning brain…`            // UNCHANGED
-  const user = `BOT STATE (JSON):\n…\n\nPrevious action's result …:\n${state.lastResult || '—'}\n\nDecide the next task now.`
+  let user = null
+  if (process.env.CONTEXT_BUILDER !== 'off') {
+    try {
+      const built = await context.buildPrompt(ctx.bot, { lastFeedback: ctx.lastFeedback })
+      if (!built.ok) throw new Error(built.reason)
+      user = built.messages[1].content + `\n\nDecide the next task now. Reply with ONLY the JSON object.`
+    } catch (e) { logger.warn(`[planner] context unavailable (${e.message}); legacy prompt`) }
+  }
+  user = user || `BOT STATE (JSON):\n${JSON.stringify(state)}\n\nAVAILABLE SKILLS:\n${skillsApi.describeForLLM()}\n\nPrevious action's result:\n—\n\nDecide the next task now.`
   return complete([{ role:'system', content:system },{ role:'user', content:user }], …
```

Using builder's user content only keeps the diff minimal; adopting its system
message too is optional. `state` param stays for heuristic + legacy paths.

### File 2: `src/agents/brain.js` (+1)

```diff
@@ cycle(), line 72 @@
-    const ctx = { bot: bot(), logger, state }
+    const ctx = { bot: bot(), logger, state, lastFeedback: lastCycle?.feedback || null }
```

Entire brain change. No new requires, exports untouched.

### Files NOT touched
perception/*, memory/*, bot.js, skills/index.js, context/builder.js
(implementer owns it).

## 4. Rollback plan if context building throws at runtime

1. **Kill switch**: `CONTEXT_BUILDER=off` in `.env`, restart → legacy prompt
   path, zero code change.
2. **Per-decision fallback**: try/catch in planWithLLM degrades one cycle to
   legacy `JSON.stringify(state)` prompt; next cycle retries builder.
   Heuristic planner remains the final net (existing behavior).
3. **Full revert**: 2 files, ~10 lines, no shared-state mutations →
   `git checkout ab87e69b -- src/agents/brain.js && git checkout fedfd045 -- src/agents/planner.js`.
   builder.js can remain deployed unused (leaf module).

| Symptom | Ring | Effect |
|---|---|---|
| builder throws | 2 | one legacy-prompt cycle, warn logged |
| ok:false (respawn window) | 2 | heuristic plans that cycle |
| builder regression | 1 | env flip |

## 5. Notes for builder implementer (defects found during wiring review)

Fix before Phase D, do not block integration:
1. **BUG renderLastAction (builder.js:107)**: fallback reads
   `recentEntries[0]`, but `episodic.recent(n)` returns oldest-first
   (slice(-n)) — `[0]` is the OLDEST of the 12-window. Use
   `recentEntries[recentEntries.length - 1]`. Undermines §2 whenever
   lastFeedback is absent (first cycle after restart).
2. **taskHint contract**: builder renders taskHint verbatim while buildContext
   expects a literal `MANUAL TASK QUEUED:` prefix. If/when wired (Phase E),
   brain must format: `` `MANUAL TASK QUEUED: ${t.task} ${JSON.stringify(t.args)} (${t.reason}) — execute FIRST.` ``
3. Minor: L1_SYSTEM says "health above 6" but config.safeHealth defaults 16 — align text with config.

## 6. Verification checklist

- [ ] Live cycle: captured complete() messages equal buildPrompt output; tokens < 8000.
- [ ] LAST ACTION matches brain.lastResult semantics (same skill, ok/ERR).
- [ ] Fresh boot shows `(first turn)`, no crash.
- [ ] CONTEXT_BUILDER=off produces byte-identical legacy prompts.
- [ ] Monkeypatched builder throw → cycle completes via legacy/heuristic, warn once.
