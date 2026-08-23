const fs = require('fs')
const path = require('path')
const { logger } = require('../utils/helpers')
const { getTypedState } = require('../perception/state')

const DIR = __dirname
const FILE = path.join(DIR, 'env.json')

const DEFAULT = () => ({
  server: null, version: null, lastLogin: null,
  spawn: null, base: null,
  chests: [], stations: { crafting_table: [], furnace: [] },
  dayLengthTicks: null,
  oreSightings: [],
})

let profile = DEFAULT()
let dirty = false
let lastSaved = 0
let lastDay = null
let maxTod = 0

const ROUND = (v) => Math.round(v)
const keyOf = (p) => `${ROUND(p.x)},${ROUND(p.y)},${ROUND(p.z)}`

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    profile = Object.assign(DEFAULT(), raw)
    profile.stations = Object.assign({ crafting_table: [], furnace: [] }, raw.stations)
  } catch { /* no profile yet — defaults */ }
  return profile
}

function get() {
  return profile
}

function updateFromLogin(bot, cfg) {
  profile.server = `${cfg.serverHost}:${cfg.serverPort}`
  profile.version = cfg.version || bot.version || profile.version
  profile.lastLogin = new Date().toISOString()
  if (bot.spawnPoint) profile.spawn = { x: ROUND(bot.spawnPoint.x), y: ROUND(bot.spawnPoint.y), z: ROUND(bot.spawnPoint.z) }
  profile.dayLengthTicks = null
  dirty = true
}

function setBase(pos) {
  profile.base = { x: ROUND(pos.x), y: ROUND(pos.y), z: ROUND(pos.z) }
  dirty = true
}

function dedupeArr(arr, keyFn, cap) {
  const seen = new Set()
  const out = []
  for (const item of arr) {
    const k = keyFn(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
    if (out.length >= cap) break
  }
  return out
}

function observe(bot) {
  if (!bot?.entity) return
  const me = bot.entity.position
  const wanted = ['chest', 'crafting_table', 'furnace', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore', 'lapis_ore']

  const hits = {}
  for (const name of wanted) {
    try {
      const found = bot.findBlocks({ matching: (b) => b.name === name, maxDistance: 32, count: 50 })
      if (found && found.length) hits[name] = found
    } catch { /* chunk not loaded */ }
  }

  const chests = (hits.chest || []).map((p) => ({ x: ROUND(p.x), y: ROUND(p.y), z: ROUND(p.z) }))
  profile.chests = dedupeArr(profile.chests.concat(chests), (c) => `${c.x},${c.y},${c.z}`, 20)

  for (const st of ['crafting_table', 'furnace']) {
    const found = (hits[st] || []).map((p) => ({ x: ROUND(p.x), y: ROUND(p.y), z: ROUND(p.z) }))
    profile.stations[st] = dedupeArr(profile.stations[st].concat(found), (c) => `${c.x},${c.y},${c.z}`, 20)
  }

  const ores = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore', 'lapis_ore']
  const sightings = []
  for (const name of ores) {
    for (const p of hits[name] || []) {
      sightings.push({ name, x: ROUND(p.x), y: ROUND(p.y), z: ROUND(p.z), ts: Date.now(), confidence: 'low' })
    }
  }
  profile.oreSightings = dedupeArr(profile.oreSightings.concat(sightings), (o) => `${o.name}|${o.x},${o.y},${o.z}`, 100)

  const state = getTypedState(bot)
  if (state) {
    const day = state.dayCount
    const tod = state.timeOfDay
    if (typeof day === 'number' && typeof tod === 'number') {
      if (lastDay == null) lastDay = day
      if (day > lastDay) {
        if (maxTod > 0) profile.dayLengthTicks = maxTod
        lastDay = day
        maxTod = 0
      }
      if (tod > maxTod) maxTod = tod
    }
  }

  dirty = true
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function save() {
  if (!dirty) return
  try {
    atomicWrite(FILE, JSON.stringify(profile, null, 2))
    dirty = false
    lastSaved = Date.now()
  } catch (e) {
    logger.warn(`[envProfile] save failed: ${e.message}`)
  }
}

function saveIfDirty() {
  if (!dirty) return
  if (Date.now() - lastSaved < 30000) return
  save()
}

module.exports = { load, get, updateFromLogin, setBase, observe, save, saveIfDirty }