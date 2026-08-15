// Phase B offline harness — episodic.js + envProfile.js (no game server).
// Style mirrors /tmp/phaseA_test.js: fake bots, ok/pass/fail counters,
// process.exit(fail?1:0). Data files are backed up + restored.
process.env.LLM_BASE_URL = 'http://127.0.0.1:1/v1' // ensure cfg.llm.enabled; llm.complete is stubbed so never hit

const B = '/root/BOT'
const fs = require('fs')
const path = require('path')

const MEM_DIR = path.join(B, 'src', 'memory')
const DATA_FILES = ['episodes.ndjson', 'summary.json', 'env.json']

function vec(x, y, z) { return { x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } } }

function backup() {
  const bak = {}
  for (const f of DATA_FILES) {
    const p = path.join(MEM_DIR, f)
    bak[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  return bak
}
function restore(bak) {
  for (const f of DATA_FILES) {
    const p = path.join(MEM_DIR, f)
    if (bak[f] === null) { try { fs.unlinkSync(p) } catch { /* absent */ } }
    else fs.writeFileSync(p, bak[f])
  }
  for (const f of fs.readdirSync(MEM_DIR)) if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(MEM_DIR, f)) } catch { /* ignore */ } }
}

// episodic destructures { complete } from src/llm at require time, so we patch
// llm.complete (returns a STRING) before each fresh episodic require.
let llm
function stubLLM(fn) {
  delete require.cache[require.resolve(path.join(B, 'src', 'llm'))]
  llm = require(path.join(B, 'src', 'llm'))
  llm.complete = fn
}
function freshEpisodic() {
  delete require.cache[require.resolve(path.join(B, 'src', 'memory', 'episodic'))]
  return require(path.join(B, 'src', 'memory', 'episodic'))
}
function freshEnv() {
  delete require.cache[require.resolve(path.join(B, 'src', 'memory', 'envProfile'))]
  return require(path.join(B, 'src', 'memory', 'envProfile'))
}

function fileLines(f) {
  const p = path.join(MEM_DIR, f)
  if (!fs.existsSync(p)) return 0
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length
}

// fake bot that serves envProfile.observe() + getTypedState()
const WORLD = [
  { name: 'iron_ore', x: 3, y: 4, z: 3 },
  { name: 'chest', x: 10, y: 4, z: 10 },
  { name: 'crafting_table', x: 12, y: 4, z: 12 },
]
function makeObserveBot() {
  return {
    version: '1.21.11',
    entity: { position: vec(0, 5, 0), dimension: 'overworld', air: 300, equipment: [] },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000, day: 3 },
    entities: {},
    blockAtCursor: () => null,
    findBlocks: ({ matching }) => WORLD.filter((b) => matching({ name: b.name })).map((b) => vec(b.x, b.y, b.z)),
  }
}

async function main() {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log('  ok', label) } else { fail++; console.log('  FAIL', label) } }

  const bak = backup()
  try {
    // ---- T1: record + load round-trip, fields preserved, NDJSON count ----
    console.log('T1 record+load round-trip')
    stubLLM(async () => '')
    {
      const a = freshEpisodic()
      for (let i = 0; i < 3; i++) a.record({ ts: 1700000000000 + i, type: 'mine', action: 'mine iron_ore', ok: true, position: { x: 1 + i, y: 2, z: 3 }, result: 'got 1 iron' })
      await a.flush()
      const b = freshEpisodic()
      const { entries } = await b.load()
      ok(entries.length === 3, 'load() returns 3 recorded entries')
      const e = entries[0]
      ok(typeof e.ts === 'number' && e.type === 'mine' && e.action === 'mine iron_ore' && e.ok === true && e.position && e.position.x === 1, 'entry fields (ts,type,action,ok,position) preserved')
      ok(fileLines('episodes.ndjson') === 3, 'episodes.ndjson has 3 NDJSON lines')
    }

    // ---- T2: cap behavior — 220 entries, oldest beyond newest-50 folded, newest 50 kept ----
    console.log('T2 cap behavior')
    stubLLM(async () => '') // empty reply still folds
    {
      const a = freshEpisodic()
      for (let i = 0; i < 220; i++) a.record({ ts: 1700000000000 + i, type: 'mine', action: 'mine ' + i, ok: true })
      await a.flush()
      const r = await a.summarize()
      ok(r.ok === true && r.folded === 60, `over-cap fold: folded=${r.folded} (oldest beyond newest-50 available)`)
      const kept = a.recent(50)
      ok(kept.length === 50 && kept[0].ts === 1700000000000 + 170, 'newest 50 excluded from fold and retained (first kept = entry #171)')
    }

    // ---- T3: summarize happy path with fake llm ----
    console.log('T3 summarize happy path')
    stubLLM(async () => 'mined 2 iron\nfound cave')
    {
      const a = freshEpisodic()
      for (let i = 0; i < 100; i++) a.record({ ts: 1700000000000 + i, type: 'mine', action: 'mine ' + i, ok: true })
      await a.flush()
      const r = await a.summarize()
      ok(r.ok === true && r.folded === 50, 'summarize ok, folded 50 of 100')
      const s = JSON.parse(fs.readFileSync(path.join(MEM_DIR, 'summary.json'), 'utf8'))
      ok(Array.isArray(s.bullets) && s.bullets.length === 2 && s.bullets[0].startsWith('[') && s.bullets[0].includes('mined 2 iron') && s.bullets[1].includes('found cave'), 'summary.json written with [HH:MM]-prefixed bullets')
      ok(fileLines('episodes.ndjson') === 50, 'episodes.ndjson rewritten to KEEP_RECENT(50) lines')
    }

    // ---- T4: summarize fallback — llm throws, file unchanged, no summary ----
    console.log('T4 summarize fallback')
    stubLLM(async () => { throw new Error('llm boom') })
    try { fs.unlinkSync(path.join(MEM_DIR, 'summary.json')) } catch { /* absent */ }
    {
      const a = freshEpisodic()
      for (let i = 0; i < 60; i++) a.record({ ts: 1700000000000 + i, type: 'mine', action: 'mine ' + i, ok: true })
      await a.flush()
      const before = fs.readFileSync(path.join(MEM_DIR, 'episodes.ndjson'))
      const r = await a.summarize()
      ok(r.ok === false, 'summarize returns ok:false when llm throws')
      ok(fs.readFileSync(path.join(MEM_DIR, 'episodes.ndjson')).equals(before), 'episodes.ndjson byte-identical after failed summarize')
      ok(!fs.existsSync(path.join(MEM_DIR, 'summary.json')), 'no summary.json written on failure')
    }

    // ---- T5: budget enforcement — seeded bullets over TOKEN_BUDGET get oldest dropped ----
    console.log('T5 budget enforcement')
    stubLLM(async () => 'newest memory bullet')
    {
      const seeded = Array.from({ length: 120 }, (_, i) => `bullet ${i} ` + 'x'.repeat(140))
      fs.writeFileSync(path.join(MEM_DIR, 'summary.json'), JSON.stringify({ ts: 1, updated: 1, bullets: seeded }))
      const a = freshEpisodic()
      await a.load()
      for (let i = 0; i < 60; i++) a.record({ ts: 1700000000000 + i, type: 'mine', action: 'mine ' + i, ok: true })
      await a.flush()
      const r = await a.summarize()
      const s = a.getSummary()
      ok(r.ok === true && a.estimateTokens(s.bullets.join('\n')) <= a.TOKEN_BUDGET, `bullets under TOKEN_BUDGET (${a.estimateTokens(s.bullets.join('\n'))} <= ${a.TOKEN_BUDGET})`)
      ok(s.bullets[s.bullets.length - 1].includes('newest memory bullet'), 'newest bullet retained after budget trim')
      ok(s.bullets.length < seeded.length && !s.bullets.includes(seeded[0]), 'oldest seeded bullets dropped')
    }

    // ---- T6: envProfile.updateFromLogin + save ----
    console.log('T6 updateFromLogin + save')
    {
      const p = freshEnv()
      const bot = { version: '1.21.11', spawnPoint: { x: 100.4, y: 64.7, z: -5.2 } }
      p.updateFromLogin(bot, { serverHost: 'mc.example.net', serverPort: 56892, version: false })
      const prof = p.get()
      ok(prof.server === 'mc.example.net:56892' && prof.version === '1.21.11', 'server/version set from cfg+bot')
      ok(prof.spawn && prof.spawn.x === 100 && prof.spawn.y === 65 && prof.spawn.z === -5, 'spawn rounded from bot.spawnPoint')
      ok(typeof prof.lastLogin === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(prof.lastLogin), 'lastLogin is ISO timestamp')
      p.save()
      const disk = JSON.parse(fs.readFileSync(path.join(MEM_DIR, 'env.json'), 'utf8'))
      ok(disk.server === 'mc.example.net:56892' && disk.version === '1.21.11' && disk.spawn.y === 65, 'env.json persisted with correct fields')
    }

    // ---- T7: envProfile.observe ----
    console.log('T7 observe')
    {
      const p = freshEnv()
      p.observe(makeObserveBot())
      const prof = p.get()
      const o = prof.oreSightings
      ok(o.length === 1 && o[0].name === 'iron_ore' && o[0].x === 3 && o[0].y === 4 && o[0].z === 3 && o[0].confidence === 'low', 'oreSightings[0] iron_ore@(3,4,3) confidence low')
      ok(prof.chests.some((c) => c.x === 10 && c.y === 4 && c.z === 10), 'chests populated from findBlocks')
      ok(prof.stations.crafting_table.some((c) => c.x === 12 && c.y === 4 && c.z === 12), 'crafting_table station populated')
    }

    // ---- T8: setBase + saveIfDirty throttle ----
    console.log('T8 setBase + saveIfDirty throttle')
    {
      const p = freshEnv()
      p.setBase({ x: 1.2, y: 64, z: 3.9 })
      p.saveIfDirty()
      const disk1 = JSON.parse(fs.readFileSync(path.join(MEM_DIR, 'env.json'), 'utf8'))
      ok(disk1.base && disk1.base.x === 1 && disk1.base.y === 64 && disk1.base.z === 4, 'first saveIfDirty persists rounded base')
      p.setBase({ x: 50, y: 64, z: 50 })
      p.saveIfDirty() // <30s since lastSaved → throttled no-op
      const disk2 = JSON.parse(fs.readFileSync(path.join(MEM_DIR, 'env.json'), 'utf8'))
      ok(disk2.base.x === 1 && JSON.stringify(disk2) === JSON.stringify(disk1), 'second saveIfDirty throttled — env.json unchanged & valid')
    }
  } finally {
    restore(bak)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })