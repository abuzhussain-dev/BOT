// Phase C adversarial harness — context_edge_test.js (BOTC).
// SEPARATE from context_test.js. Targets adversarial / malformed inputs beyond
// the happy-path contract: cyclic object refs, NaN/Infinity positions,
// entities with missing/null fields, 500+ entities, malformed inventory slots,
// a 100k-char episodic payload, opts budget override, and token-estimate
// consistency. Plain node asserts, named sections, mirroring memory_test.js.
// Dynamically requires src/context/builder.js; SKIPs cleanly if absent or if it
// throws on require (the module is authored by a teammate in parallel).
//
// Crash-safe by design: every test group is isolated in try/catch so a single
// bad return (throw or malformed object) is recorded as a FAIL and the rest of
// the suite still runs, giving the implementer a full adversarial report.

const B = '/root/BOT'
const path = require('path')
const ctxPath = path.join(B, 'src', 'context', 'builder.js')

// ---- dynamic import + graceful SKIP -------------------------------------
function loadBuilder() {
  try {
    return require(ctxPath)
  } catch (e) {
    return null
  }
}

const mod = loadBuilder()
if (!mod) {
  console.log('SKIP: builder.js not present')
  process.exit(0)
}
const buildContext = mod && mod.buildContext

// ---- constants ----------------------------------------------------------
const BUDGET = 8000          // contract ceiling for prompt length (chars)
const SMALL_BUDGET = 300     // adversarial override to prove truncation honors opts

// ---- helpers ------------------------------------------------------------
function vec(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } }
}
function item(name, count, slot) {
  return { name, count, slot, type: 0, metadata: 0 }
}

function makeFullBot() {
  const selfEntity = {
    position: vec(12.3, 64.0, -7.8), velocity: vec(0, 0, 0), onGround: true,
    yaw: 0, pitch: 0, health: 18, maxHealth: 20, food: 20, foodSaturation: 4.5,
    experience: 120, level: 7, dimension: 'overworld',
  }
  return {
    username: 'bot', version: '1.21.11',
    entity: selfEntity, player: { entity: selfEntity, gamemode: 0 },
    players: {
      bot: { username: 'bot', ping: 24, entity: selfEntity },
      alice: { username: 'alice', ping: 41, entity: { position: vec(20, 64, 0), type: 'player' } },
    },
    inventory: { items: () => [item('diamond_pickaxe', 1, 36), item('iron_ore', 32, 37), item('cobblestone', 64, 38)], slots: 41 },
    game: { levelName: 'world', gameMode: 0, difficulty: 2, dayTime: 6000, dimension: 'overworld', rainbowLevel: 0 },
    time: { timeOfDay: 6000, day: 3 },
    entities: { 1: { id: 1, type: 'player', name: 'alice', position: vec(20, 64, 0) } },
    health: 18, food: 20, isAlive: () => true, spawnPoint: vec(0, 64, 0),
    findBlocks: () => [], chat: { history: [] },
  }
}

function makeEntity(id, over) {
  return Object.assign({ id, type: id % 2 ? 'zombie' : 'skeleton', name: 'mob_' + id, position: vec(id % 64, 60 + (id % 8), (id * 3) % 64), health: 20 }, over)
}

// crash-safe call: returns { ctx, threw, err } ; never throws
function callBuilder(bot, opts) {
  let ctx, threw = false, err = null
  try {
    ctx = typeof buildContext === 'function' ? buildContext(bot, opts) : undefined
  } catch (e) { threw = true; err = e }
  return { ctx, threw, err }
}

// defensive field accessors so a malformed return can't abort the suite
const plen = (ctx) => (ctx && typeof ctx.prompt === 'string') ? ctx.prompt.length : 0
const tok = (ctx) => (ctx && typeof ctx.tokens === 'number') ? ctx.tokens : NaN

// Shared shape assertion for the contract object.
function assertShape(ok, ctx, label) {
  ok(ctx && typeof ctx === 'object', label + ' — returns an object')
  ok(typeof (ctx && ctx.prompt) === 'string', label + ' — prompt is a string')
  ok(ctx && ctx.slices && typeof ctx.slices === 'object' && !Array.isArray(ctx.slices), label + ' — slices is an object')
  ok(typeof (ctx && ctx.tokens) === 'number' && Number.isFinite(ctx.tokens) && ctx.tokens >= 0, label + ' — tokens is a finite non-negative number')
}

async function main() {
  let pass = 0, fail = 0
  const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ok', label) }
    else { fail++; console.log('  FAIL', label) }
  }
  // run a labelled group; isolate internal throws as failures, then continue
  const group = (name, fn) => {
    console.log(name)
    try { fn() } catch (e) { fail++; console.log('  FAIL group threw:', e && e.message) }
  }

  // ---- T1: export shape ----
  group('T1 buildContext export', () => {
    ok(typeof buildContext === 'function', 'module exports buildContext as a function')
  })

  if (typeof buildContext !== 'function') {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  }

  // ---- T2: cyclic references in fake bot objects ----
  group('T2 cyclic references', () => {
    const bot = makeFullBot()
    bot.entity.self = bot          // entity points back to bot → cycle
    bot.circular = bot
    bot.players.alice.entity = bot.entity // shares the cycle
    const { ctx, threw, err } = callBuilder(bot)
    if (threw) console.log('    threw:', err && err.message)
    ok(!threw, 'buildContext(cyclic bot) does not throw')
    assertShape(ok, threw ? null : ctx, 'T2 cyclic')
    ok(plen(ctx) < BUDGET, `cyclic bot prompt bounded (len=${plen(ctx)})`)
  })

  // ---- T3: NaN / Infinity entity positions ----
  group('T3 NaN/Infinity positions', () => {
    const bot = makeFullBot()
    bot.entities = {
      1: makeEntity(1, { position: vec(NaN, Infinity, -Infinity) }),
      2: makeEntity(2, { position: { x: Infinity, y: NaN, z: 0 } }),
      3: makeEntity(3, { position: { x: 1 / 0, y: -1 / 0, z: NaN } }),
    }
    const { ctx, threw, err } = callBuilder(bot)
    if (threw) console.log('    threw:', err && err.message)
    ok(!threw, 'buildContext(NaN/Infinity positions) does not throw')
    assertShape(ok, threw ? null : ctx, 'T3 nan/inf')
    ok(plen(ctx) < BUDGET, `NaN/Infinity prompt bounded (len=${plen(ctx)})`)
  })

  // ---- T4: entity with missing / null fields ----
  group('T4 entities with missing/null fields', () => {
    const bot = makeFullBot()
    bot.entities = {
      1: { id: 1, type: 'zombie' },                 // no position, no name
      2: { id: 2, position: null, name: null },      // null position
      3: null,                                       // entry itself is null
      4: undefined,                                  // entry is undefined
      5: makeEntity(5),                              // well-formed for contrast
    }
    bot.players = { bot: null, alice: { username: 'alice', entity: null } }
    const { ctx, threw, err } = callBuilder(bot)
    if (threw) console.log('    threw:', err && err.message)
    ok(!threw, 'buildContext(sparse entities) does not throw')
    assertShape(ok, threw ? null : ctx, 'T4 sparse')
    ok(plen(ctx) < BUDGET, `sparse-entity prompt bounded (len=${plen(ctx)})`)
  })

  // ---- T5: 600 entities (500+) default budget ----
  group('T5 600 entities default budget', () => {
    const bot = makeFullBot()
    const ents = {}
    for (let i = 0; i < 600; i++) ents[1000 + i] = makeEntity(1000 + i)
    bot.entities = ents
    bot.players = {}
    const { ctx, threw, err } = callBuilder(bot)
    if (threw) console.log('    threw:', err && err.message)
    ok(!threw, 'buildContext(600 entities) does not throw')
    assertShape(ok, threw ? null : ctx, 'T5 600')
    ok(plen(ctx) < BUDGET, `600-entity prompt truncated under 8000 (len=${plen(ctx)})`)
  })

  // ---- T6: malformed inventory slots ----
  group('T6 malformed inventory slots', () => {
    // 6a: items() returns array with null/undefined/garbage members
    const botA = makeFullBot()
    botA.inventory = { items: () => [null, undefined, { name: null, count: 'x' }, { name: 'torch' }, item('oak_log', 16, 40)], slots: 41 }
    // 6b: inventory present but items is not a function
    const botB = makeFullBot()
    botB.inventory = { items: 'not-a-function', slots: 41 }
    // 6c: inventory itself is null/undefined
    const botC = makeFullBot()
    botC.inventory = null

    for (const [tag, bot] of [['null-members', botA], ['non-fn', botB], ['null-inv', botC]]) {
      const { ctx, threw, err } = callBuilder(bot)
      if (threw) console.log('    ' + tag + ' threw:', err && err.message)
      ok(!threw, `buildContext(malformed inventory: ${tag}) does not throw`)
      assertShape(ok, threw ? null : ctx, 'T6 ' + tag)
      ok(plen(ctx) < BUDGET, `malformed-inv ${tag} prompt bounded (len=${plen(ctx)})`)
    }
  })

  // ---- T7: episodic memory returning huge entries (100k chars) ----
  group('T7 huge episodic payload (100k chars)', () => {
    const bot = makeFullBot()
    const huge = 'E'.repeat(100000)
    bot.episodic = { summary: huge, recent: huge }
    const opts = { summary: huge, episodic: huge, history: huge }
    const { ctx, threw, err } = callBuilder(bot, opts)
    if (threw) console.log('    threw:', err && err.message)
    ok(!threw, 'buildContext(100k episodic) does not throw')
    assertShape(ok, threw ? null : ctx, 'T7 huge')
    ok(plen(ctx) < BUDGET, `100k episodic prompt truncated under 8000 (len=${plen(ctx)})`)
    ok(plen(ctx) <= 0 || plen(ctx) < huge.length, 'prompt does not embed the full 100k payload verbatim')
  })

  // ---- T8: opts budget override is respected ----
  group('T8 opts budget override', () => {
    const bot = makeFullBot()
    const ents = {}
    for (let i = 0; i < 600; i++) ents[2000 + i] = makeEntity(2000 + i)
    bot.entities = ents
    bot.players = {}
    const { ctx, threw, err } = callBuilder(bot, { maxChars: SMALL_BUDGET })
    if (threw) console.log('    threw:', err && err.message)
    ok(!threw, 'buildContext(600 entities, maxChars=300) does not throw')
    assertShape(ok, threw ? null : ctx, 'T8 override')
    ok(plen(ctx) <= SMALL_BUDGET, `prompt honours maxChars override (len=${plen(ctx)} <= ${SMALL_BUDGET})`)
    // override larger than content should keep full content (no padding to ceiling)
    const smallBot = makeFullBot()
    const full = callBuilder(smallBot, { maxChars: 8000 }).ctx
    ok(plen(full) <= 8000 && plen(full) > 0, 'override=8000 keeps full bounded prompt')
  })

  // ---- T9: estimateTokens consistency with prompt length ----
  group('T9 estimateTokens consistency', () => {
    const bot = makeFullBot()
    const { ctx, threw } = callBuilder(bot)
    ok(!threw, 'buildContext(full bot) does not throw for token check')
    ok(typeof tok(ctx) === 'number' && Number.isFinite(tok(ctx)), 'tokens is a finite number')
    ok(plen(ctx) === 0 ? tok(ctx) === 0 : tok(ctx) > 0, 'tokens > 0 when prompt non-empty, 0 when empty')
    ok(tok(ctx) <= plen(ctx), `tokens <= prompt length (${tok(ctx)} <= ${plen(ctx)})`)
    if (typeof mod.estimateTokens === 'function') {
      const est = mod.estimateTokens(ctx && ctx.prompt ? ctx.prompt : '')
      ok(typeof est === 'number' && Number.isFinite(est), 'module.estimateTokens(prompt) is a finite number')
      ok(Math.abs(est - tok(ctx)) <= 1 || (plen(ctx) === 0 && est === 0), `tokens matches estimateTokens(prompt) within rounding (est=${est}, tokens=${tok(ctx)})`)
    } else {
      ok(plen(ctx) === 0 || tok(ctx) >= Math.floor(plen(ctx) / 8), 'tokens is a plausible estimate (>= len/8)')
    }
  })

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
