const mb = require('minecraft-data')
const { goto, approachBlock, stopMoving } = require('../motion')
const { withTimeout, sleep, clamp } = require('../utils/helpers')

/**
 * Finds the closest block of a given type that is actually loaded and
 * reachable. `maxDistance` limits the scan radius (default 32 blocks).
 */
function findNearestBlock(bot, name, maxDistance = 32) {
  let matches
  try {
    matches = bot.findBlocks({
      matching: (block) => block.name === name,
      maxDistance,
      count: 16,
    })
  } catch (e) {
    return null
  }
  if (!matches || matches.length === 0) return null
  const me = bot.entity.position
  let best = null
  for (const p of matches) {
    if (!best || p.distanceTo(me) < best.distanceTo(me)) best = p
  }
  return best
}

const skills = [
  {
    name: 'goto',
    description: 'Walk to a coordinate (x y z are integers). Useful to relocate or go to a saved spot.',
    args: { x: 'number', y: 'number', z: 'number' },
    async run(ctx, { x, y, z }) {
      await goto(ctx.bot, x, y, z, 1.5, 45000, 'goto')
      return `arrived at ${x} ${y} ${z}`
    },
  },

  {
    name: 'digBlock',
    description: 'Dig a single block at integer coordinates. May be any block type.',
    args: { x: 'number', y: 'number', z: 'number' },
    async run(ctx, { x, y, z }) {
      const pos = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
      const block = ctx.bot.blockAt(pos)
      if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
        return `nothing diggable at ${pos.x} ${pos.y} ${pos.z}`
      }
      await approachBlock(ctx.bot, block.position)
      await withTimeout(ctx.bot.dig(block), 30000, 'dig')
      return `dug ${block.name} at ${pos.x} ${pos.y} ${pos.z}`
    },
  },

  {
    name: 'mineType',
    description: 'Find and mine the nearest block of a given name (e.g. "stone", "coal_ore"). One block per call.',
    args: { type: 'string' },
    async run(ctx, { type }) {
      const name = String(type).toLowerCase().replace(/^minecraft:/, '')
      const p = findNearestBlock(ctx.bot, name, 48)
      if (!p) return `no ${name} found nearby (scanned 48 blocks)`
      await approachBlock(ctx.bot, p)
      const block = ctx.bot.blockAt(p)
      await withTimeout(ctx.bot.dig(block), 30000, 'mine')
      return `mined ${block.name} at ${p.x} ${p.y} ${p.z}`
    },
  },

  {
    name: 'chopTree',
    description: 'Chop a nearby tree: find a trunk log and dig it (repeats once).',
    args: {},
    async run(ctx) {
      const p = findNearestBlock(ctx.bot, 'oak_log', 24)
        || findNearestBlock(ctx.bot, 'spruce_log', 24)
        || findNearestBlock(ctx.bot, 'birch_log', 24)
        || findNearestBlock(ctx.bot, 'jungle_log', 24)
        || findNearestBlock(ctx.bot, 'acacia_log', 24)
        || findNearestBlock(ctx.bot, 'dark_oak_log', 24)
        || findNearestBlock(ctx.bot, 'mangrove_log', 24)
      if (!p) return 'no tree nearby'
      await approachBlock(ctx.bot, p)
      const block = ctx.bot.blockAt(p)
      await withTimeout(ctx.bot.dig(block), 30000, 'chop')
      return `chopped ${block.name}`
    },
  },

  {
    name: 'collectNearby',
    description: 'Walk to the nearest dropped item that is within 8 blocks and pick it up.',
    args: {},
    async run(ctx) {
      const drops = Object.values(ctx.bot.entities)
        .filter((e) => e.name === 'item' && e.position && e.position.distanceTo(ctx.bot.entity.position) <= 8)
        .sort((a, b) => a.position.distanceTo(ctx.bot.entity.position) - b.position.distanceTo(ctx.bot.entity.position))
      if (drops.length === 0) return 'no drops nearby'
      const drop = drops[0]
      await goto(ctx.bot, drop.position.x, drop.position.y, drop.position.z, 1, 20000, 'collect')
      await sleep(400)
      return `moved to pick up item near ${drop.position.floored().toString()}`
    },
  },

  {
    name: 'eat',
    description: 'Eat the best food from the inventory to restore hunger.',
    args: {},
    async run(ctx) {
      try {
        const foods = mb(ctx.bot.version)
        const foodsArray = foods.foodsArray || []
        if (!foodsArray.length) return 'no food data for this version'
        const byName = {}
        for (const f of foodsArray) byName[f.id] = { name: f.name, foodPoints: f.foodPoints }
        const items = ctx.bot.inventory.items().sort((a, b) => {
          const fa = byName[a.type]?.foodPoints || 0
          const fb = byName[b.type]?.foodPoints || 0
          return fb - fa
        })
        const best = items.find((i) => byName[i.type])
        if (!best) return 'no food in inventory'
        await ctx.bot.equip(best, 'hand')
        if (typeof ctx.bot.eat === 'function') {
          await withTimeout(ctx.bot.eat(), 15000, 'eat')
        } else if (typeof ctx.bot.activateItem === 'function') {
          await ctx.bot.activateItem()
          await sleep(4000)
        } else {
          await ctx.bot.useOn(ctx.bot.entity.position)
          await sleep(4000)
        }
        return `ate ${best.name}`
      } catch (e) {
        return `eat failed: ${e.message}`
      }
    },
  },

  {
    name: 'dropJunk',
    description: 'Drop a stack of junk items by name (optional count). Keeps inventory clean.',
    args: { name: 'string', count: 'number?', max: 'number?' },
    async run(ctx, { name, count, max }) {
      const wanted = String(name || '').toLowerCase().replace(/^minecraft:/, '')
      const limit = count ? parseInt(count, 10) : 1
      const dropMax = max ? parseInt(max, 10) : 64
      const items = ctx.bot.inventory.items().filter((i) => i.name === wanted)
      let dropped = 0
      for (const item of items) {
        const n = clamp(Math.min(item.count, dropMax), 1, limit)
        try {
          await ctx.bot.tossStack(item, n)
          dropped += n
        } catch (e) {
          ctx.logger.warn(`toss failed: ${e.message}`)
        }
        if (dropped >= limit) break
      }
      return dropped > 0 ? `dropped ${dropped} ${wanted}` : `no ${wanted} to drop`
    },
  },
]

module.exports = { skills, findNearestBlock }