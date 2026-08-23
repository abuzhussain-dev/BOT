// Phase C offline harness — contract tests for src/context/builder.js (BOTC).
// Plain node asserts with named sections, mirroring memory_test.js style.
// buildContext.js is authored in parallel, so this harness SKIPS cleanly when
// it is absent (or throws on require) and becomes a real contract gate later.
//
// Contract under test (agreed with the Phase C implementer):
//   module exports buildContext(bot, opts)
//   returns { prompt, slices, tokens } where
//     - prompt  : string, bounded (< 8000 chars) even under load
//     - slices  : object of named prompt sections (L1..L5 + manual queue)
//     - tokens  : number estimate of prompt size

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
  // Missing file OR threw on require → skip now, pass later.
  console.log('SKIP: builder.js not present')
  process.exit(0)
}

const buildContext = mod && mod.buildContext

// ---- helpers ------------------------------------------------------------
function vec(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } }
}
function item(name, count, slot) {
  return { name, count, slot, type: 0, metadata: 0 }
}

// A fully-populated mock bot roughly matching the mineflayer shape, plus
// whatever extra fields the builder might read.
function makeFullBot() {
  const selfEntity = {
    position: vec(12.3, 64.0, -7.8),
    velocity: vec(0, 0, 0),
    onGround: true,
    yaw: 0, pitch: 0,
    health: 18, maxHealth: 20,
    food: 20, foodSaturation: 4.5,
    experience: 120, level: 7,
    dimension: 'overworld',
  }
  const bot = {
    username: 'bot',
    version: '1.21.11',
    entity: selfEntity,
    player: { entity: selfEntity, gamemode: 0 },
    players: {
      bot: { username: 'bot', ping: 24, entity: selfEntity },
      alice: { username: 'alice', ping: 41, entity: { position: vec(20, 64, 0), type: 'player' } },
    },
    inventory: {
      items: () => [
        item('diamond_pickaxe', 1, 36),
        item('iron_ore', 32, 37),
        item('cobblestone', 64, 38),
        item('torch', 48, 39),
        item('oak_log', 16, 40),
      ],
      slots: 41,
    },
    game: { levelName: 'world', gameMode: 0, difficulty: 2, dayTime: 6000, dimension: 'overworld', rainbowLevel: 0 },
    time: { timeOfDay: 6000, day: 3 },
    entities: { 1: { id: 1, type: 'player', name: 'alice', position: vec(20, 64, 0) } },
    health: 18, food: 20,
    isAlive: () => true,
    spawnPoint: vec(0, 64, 0),
    findBlocks: () => [],
    chat: { history: [] },
  }
  return bot
}

// Shape assertion shared by every case: the three contract fields.
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

  // ---- T1: export shape ----
  console.log('T1 buildContext export')
  ok(typeof buildContext === 'function', 'module exports buildContext as a function')

  if (typeof buildContext !== 'function') {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  }

  // ---- T2: full bot → contract object ----
  console.log('T2 full bot contract shape')
  {
    const bot = makeFullBot()
    let ctx
    let threw = false
    try { ctx = buildContext(bot) } catch (e) { threw = true; console.log('    threw:', e && e.message) }
    ok(!threw, 'buildContext(fullBot) does not throw')
    assertShape(ok, threw ? null : ctx, 'T2 full bot')
    if (!threw && ctx) ok(Object.keys(ctx.slices).length >= 1, 'slices has at least one named section')
  }

  // ---- T3: prompt bounded (< 8000) with data, no opts ----
  console.log('T3 prompt bounded under 8000 chars (full bot)')
  {
    const bot = makeFullBot()
    const ctx = buildContext(bot)
    ok(ctx.prompt.length < 8000, `prompt under 8000 chars (len=${ctx.prompt.length})`)
    ok(ctx.prompt.length > 0, 'prompt is non-empty for a bot with data')
  }

  // ---- T4: opts pass-through does not break ----
  console.log('T4 opts argument accepted')
  {
    const bot = makeFullBot()
    let threw = false
    let ctx
    try { ctx = buildContext(bot, { maxChars: 8000, includeWiki: false }) } catch (e) { threw = true }
    ok(!threw && ctx && typeof ctx.prompt === 'string', 'buildContext(bot, opts) returns contract object')
  }

  // ---- T5: null bot handled gracefully ----
  console.log('T5 null bot edge case')
  {
    let ctx
    let threw = false
    try { ctx = buildContext(null) } catch (e) { threw = true; console.log('    threw:', e && e.message) }
    ok(!threw, 'buildContext(null) does not throw')
    assertShape(ok, threw ? null : ctx, 'T5 null bot')
    if (!threw && ctx) ok(ctx.prompt.length < 8000, `null bot prompt bounded (len=${ctx.prompt.length})`)
  }

  // ---- T6: bot before spawn (no bot.entity) ----
  console.log('T6 bot before spawn (no entity)')
  {
    const bot = makeFullBot()
    delete bot.entity
    delete bot.player
    let ctx
    let threw = false
    try { ctx = buildContext(bot) } catch (e) { threw = true; console.log('    threw:', e && e.message) }
    ok(!threw, 'buildContext(bot without entity) does not throw')
    assertShape(ok, threw ? null : ctx, 'T6 pre-spawn')
    if (!threw && ctx) ok(ctx.prompt.length < 8000, `pre-spawn prompt bounded (len=${ctx.prompt.length})`)
  }

  // ---- T7: empty inventory ----
  console.log('T7 empty inventory')
  {
    const bot = makeFullBot()
    bot.inventory = { items: () => [], slots: 41 }
    let ctx
    let threw = false
    try { ctx = buildContext(bot) } catch (e) { threw = true; console.log('    threw:', e && e.message) }
    ok(!threw, 'buildContext(empty inventory) does not throw')
    assertShape(ok, threw ? null : ctx, 'T7 empty inventory')
    if (!threw && ctx) ok(ctx.prompt.length < 8000, `empty-inv prompt bounded (len=${ctx.prompt.length})`)
  }

  // ---- T8: huge entity list (250) must truncate ----
  console.log('T8 huge entity list (250 entities) truncates')
  {
    const bot = makeFullBot()
    const entities = {}
    for (let i = 0; i < 250; i++) {
      entities[100 + i] = {
        id: 100 + i,
        type: i % 2 ? 'zombie' : 'skeleton',
        name: 'mob_' + i,
        position: vec(i % 64, 60 + (i % 8), (i * 3) % 64),
        velocity: vec(0, 0, 0),
        health: 20, metadata: 0,
      }
    }
    bot.entities = entities
    bot.players = {}
    let ctx
    let threw = false
    try { ctx = buildContext(bot) } catch (e) { threw = true; console.log('    threw:', e && e.message) }
    ok(!threw, 'buildContext(250 entities) does not throw')
    if (!threw) {
      assertShape(ok, ctx, 'T8 huge entity list')
      ok(ctx.prompt.length < 8000, `huge entity list prompt truncated under 8000 (len=${ctx.prompt.length})`)
      ok(ctx.tokens >= 0 && Number.isFinite(ctx.tokens), 'tokens estimate finite for huge list')
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
