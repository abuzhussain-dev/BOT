// Phase C integration harness — integration_test.js (BOTC).
// Validates that src/agents/planner.js is WIRED to src/context/builder.js
// (the INTEGRATION.md wiring being applied by a teammate in parallel).
//
// Tolerates both states of the repo:
//   - UNWIRED (planner.js does not require ../context/builder yet)  -> print
//     "SKIP: ..." and exit 0, no crash.
//   - WIRED (planner.js requires the builder)                       -> run full
//     static + behavioral + fallback assertions.
//
// Plain node asserts with named sections, mirroring memory_test.js. No real
// mineflayer connection; llm.complete is monkeypatched to capture the messages
// passed by the planner so we can inspect the rendered prompt.

process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1' // ensure cfg.llm.enabled

const B = '/root/BOT'
const fs = require('fs')
const path = require('path')

const plannerPath = path.join(B, 'src', 'agents', 'planner.js')
const llmPath = path.join(B, 'src', 'llm')
const builderPath = path.join(B, 'src', 'context', 'builder.js')
const skillsPath = path.join(B, 'src', 'skills')

// ---- SKIP gate: read planner source, detect the builder require ----------
const plannerSrc = fs.readFileSync(plannerPath, 'utf8')
const REQUIRES_BUILDER = /require\(\s*['"]\.\.\/context\/builder['"]\s*\)/.test(plannerSrc)

function skip(msg) { console.log('SKIP: ' + msg); process.exit(0) }

if (!REQUIRES_BUILDER) {
  skip('planner.js not yet wired to context/builder (no require)')
}

// ---- install llm.complete mock, then load planner fresh -------------------
// capture holder so we can reset between calls without losing the closure
const cap = { calls: [] }
let llm, planner, skillsApi
try {
  llm = require(llmPath)
  llm.complete = (messages) => {
    cap.calls.push(messages)
    return Promise.resolve('{"task":"mineType","args":{"type":"stone"},"reason":"ok"}')
  }
  planner = require(plannerPath)
  skillsApi = require(skillsPath)
} catch (e) {
  skip('planner.js failed to load: ' + e.message)
}

// ---- helpers --------------------------------------------------------------
function makeBot() {
  return {
    entity: {
      position: { x: 10, y: 64, z: -5, distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) } },
      health: 18,
      equipment: [],
    },
    inventory: { items: () => [] },
  }
}
const logger = { warn() {}, info() {}, error() {} }

async function main() {
  let pass = 0, fail = 0
  const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ok', label) }
    else { fail++; console.log('  FAIL', label) }
  }

  // ---- T1: static wiring checks (run only when wired) ----
  console.log('T1 static wiring checks')
  ok(REQUIRES_BUILDER, 'planner.js requires ../context/builder')
  ok(!/state\.lastResult/.test(plannerSrc), 'planner.js no longer references state.lastResult in prompt template')

  // ---- T2: behavioral — lastFeedback from opts flows into the prompt ----
  console.log('T2 behavioral: lastFeedback flows into prompt')
  cap.calls.length = 0
  const marker = 'FEEDBACK_MARKER_xyz789'
  const lastFeedback = { skill: 'mineType', ok: true, errorType: null, result: marker, invDelta: true, stagnation: false }
  const state = { health: 18, food: 20, position: { x: 10, y: 64, z: -5 } }
  const ctx = { bot: makeBot(), logger, state, lastFeedback }

  let task, threw = false
  try { task = await planner.plan(state, ctx) } catch (e) { threw = true; console.log('    threw:', e && e.message) }
  ok(!threw, 'plan() does not throw with wired builder')
  ok(cap.calls.length >= 1, 'llm.complete was invoked (builder path used)')
  if (cap.calls.length) {
    const msgs = cap.calls[0]
    const user = msgs.find((m) => m.role === 'user')
    ok(!!user && typeof user.content === 'string', 'builder produced a user message')
    ok(user && user.content.includes(marker), 'user message contains lastFeedback content from opts')
    ok(user && !user.content.includes("Previous action's result"), 'user message has no legacy state.lastResult template')
  }
  ok(task && typeof task.task === 'string', 'plan() returned a task object')
  ok(task && skillsApi.has(task.task), 'returned task is a registered skill')

  // ---- T3: fallback — builder throws or returns ok:false must not crash ----
  console.log('T3 fallback when builder unavailable')
  const builder = require(builderPath)
  const origBuildPrompt = builder.buildPrompt

  // 3a: builder throws
  cap.calls.length = 0
  builder.buildPrompt = async () => { throw new Error('builder boom') }
  let tA, threwA = false
  try { tA = await planner.plan(state, { ...ctx, bot: makeBot() }) } catch (e) { threwA = true; console.log('    threw:', e && e.message) }
  ok(!threwA, 'plan() does not crash when builder throws')
  ok(tA && typeof tA.task === 'string', 'plan() still returns a task when builder throws')

  // 3b: builder returns ok:false (bot not spawned / no entity)
  cap.calls.length = 0
  builder.buildPrompt = origBuildPrompt
  const unspawnedCtx = { bot: { inventory: { items: () => [] } }, logger, state, lastFeedback }
  let tB, threwB = false
  try { tB = await planner.plan(state, unspawnedCtx) } catch (e) { threwB = true; console.log('    threw:', e && e.message) }
  ok(!threwB, 'plan() does not crash when builder returns ok:false')
  ok(tB && typeof tB.task === 'string', 'plan() still returns a task when builder ok:false')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
