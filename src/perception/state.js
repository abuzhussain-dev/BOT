/**
 * Phase A — L2 typed state.
 * Deterministic snapshot of the world/self for every decision. No freeform
 * strings; every field has a fixed shape so the LLM gets a stable schema.
 */

const mcData = require('minecraft-data')

const DIM_REALM = { overworld: 'overworld', the_nether: 'nether', the_end: 'end' }

function countInventory(bot) {
  const counts = {}
  for (const item of bot.inventory?.items() || []) {
    const key = item.name.replace('minecraft:', '')
    counts[key] = (counts[key] || 0) + item.count
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([name, count]) => ({ name, count }))
}

function equipmentOf(bot) {
  const eq = bot.entity?.equipment || []
  const map = {}
  const slots = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']
  for (let i = 0; i < eq.length && i < slots.length; i++) {
    if (eq[i]) map[slots[i]] = eq[i].name
  }
  return map
}

function nearbyBlocks(bot, maxDist = 24, topN = 6) {
  const me = bot.entity.position
  const wanted = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore',
    'emerald_ore', 'redstone_ore', 'lapis_ore', 'oak_log', 'spruce_log', 'birch_log',
    'chest', 'crafting_table', 'furnace', 'stone', 'dirt']
  const seen = {}
  for (const name of wanted) {
    try {
      const p = bot.findBlocks({ matching: (b) => b.name === name, maxDistance: maxDist, count: 2 })
      if (p && p.length) seen[name] = p.map((pos) => ({
        dist: Math.round(pos.distanceTo(me) * 10) / 10,
        dir: dirFrom(me, pos),
      }))
    } catch { /* chunk not loaded — skip */ }
  }
  return Object.entries(seen)
    .sort((a, b) => a[1][0].dist - b[1][0].dist)
    .slice(0, topN)
    .map(([name, hits]) => ({ name, nearest: hits[0] }))
}

function dirFrom(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  if (Math.abs(dz) > 0) return dz > 0 ? 'south' : 'north'
  return 'same'
}

function nearbyEntities(bot, maxDist = 16, topN = 8) {
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter((e) => e.position && e !== bot.entity && e.position.distanceTo(me) <= maxDist)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    .slice(0, topN)
    .map((e) => ({
      kind: e.type === 'mob' ? 'mob' : e.type === 'player' ? 'player' : e.type || 'other',
      name: e.name,
      dist: Math.round(e.position.distanceTo(me) * 10) / 10,
      hostile: e.type === 'mob' && HOSTILE_MOBS.has(e.name),
    }))
}

const HOSTILE_MOBS = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'spider',
  'cave_spider', 'creeper', 'enderman', 'witch', 'phantom', 'slime', 'magma_cube',
  'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'vindicator', 'pillager',
  'evoker', 'vex', 'ravager', 'warden', 'guardian', 'elder_guardian', 'shulker',
])

function targetBlockOf(bot) {
  const b = bot.blockAtCursor?.(5)
  if (!b) return null
  return {
    name: b.name,
    hardness: b.hardness,
    harvestable: (b.harvestTools && Object.keys(b.harvestTools).length > 0) || b.diggable === true,
  }
}

/**
 * Full typed state. Returns null when not in-world yet.
 */
function getTypedState(bot) {
  if (!bot || !bot.entity) return null

  const realm = DIM_REALM[bot.entity.dimension] || bot.entity.dimension
  const p = bot.entity.position

  return {
    realm,
    position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
    health: bot.health,
    food: bot.food,
    air: bot.entity.air || null,
    timeOfDay: bot.time?.timeOfDay ?? null,
    dayCount: bot.time?.day ?? null,
    inventory: countInventory(bot),
    equipment: equipmentOf(bot),
    nearbyBlocks: nearbyBlocks(bot),
    nearbyEntities: nearbyEntities(bot),
    targetBlock: targetBlockOf(bot),
  }
}

/** Food availability from minecraft-data (L3-ish static, cheap to cache). */
function foods(bot) {
  try {
    const d = mcData(bot.version || '1.21.11')
    return d.foodsArray
      .slice()
      .sort((a, b) => b.saturation - a.saturation)
      .map((f) => `${f.name}(${f.foodPoints}f/${f.saturation}s)`)
      .join(', ')
  } catch {
    return ''
  }
}

module.exports = { getTypedState, foods, countInventory }