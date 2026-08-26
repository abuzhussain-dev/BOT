const mb = require('minecraft-data')
const { goto, approachBlock, stopMoving } = require('../motion')
const { withTimeout, sleep, clamp } = require('../utils/helpers')

/**
 * mcData handle for the connected server version (falls back to a recent
 * release when version detection has not completed yet).
 */
function mc(bot) {
  try {
    return mb(bot.version || '1.20.4')
  } catch {
    return mb('1.20.4')
  }
}

/** Count inventory items whose name matches `name` (any plank/log variant). */
function countItem(ctx, name) {
  return ctx.bot.inventory.items()
    .filter((i) => i.name === name || i.name.endsWith(`_${name}`))
    .reduce((n, i) => n + i.count, 0)
}

/** First inventory item matching `name`, allowing variant suffixes. */
function findItem(ctx, name) {
  return ctx.bot.inventory.items().find((i) => i.name === name || i.name.endsWith(`_${name}`))
}

/** True when a shaped recipe physically fits the 2x2 inventory grid. */
function fits2x2(recipe) {
  if (!Array.isArray(recipe.inShape)) return true // shapeless
  return recipe.inShape.length <= 2
    && recipe.inShape.every((row) => !Array.isArray(row) || row.length <= 2)
}

/**
 * Equip the best inventory tool for `blockName` using mcData harvestTools
 * (which maps the minimum tool tier that drops the block). Without this the
 * bot punches ore bare-handed and gets zero drops.
 */
async function equipBestTool(ctx, blockName) {
  const data = mc(ctx.bot)
  const block = data.blocksByName[blockName]
  if (!block) return false
  const needIds = block.harvestTools ? Object.keys(block.harvestTools).map(Number) : null
  let best = null
  let bestTier = -1
  for (const item of ctx.bot.inventory.items()) {
    if (!item.id && item.type === undefined) continue
    if (needIds && !needIds.includes(item.type)) continue
    const tier = /(_gold|_wooden)_pickaxe/.test(item.name) ? 1
      : /_stone_pickaxe/.test(item.name) ? 2
        : /_iron_pickaxe/.test(item.name) ? 3
          : /_(diamond|netherite)_pickaxe/.test(item.name) ? 4
            : 0
    if (tier > bestTier) {
      best = item
      bestTier = tier
    }
  }
  if (!best) return false
  await ctx.bot.equip(best, 'hand')
  return true
}

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
      await equipBestTool(ctx, block.name)
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
      if (!block) return `no ${name} found nearby (scanned 48 blocks)`
      await equipBestTool(ctx, name)
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
      await equipBestTool(ctx, block.name)
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
    name: 'craftItem',
    description: 'Craft an item by name (e.g. "oak_planks", "stick", "wooden_pickaxe"). Uses a nearby crafting table when the recipe needs one.',
    args: { name: 'string', count: 'number?' },
    async run(ctx, { name, count }) {
      const wanted = String(name || '').toLowerCase().replace(/^minecraft:/, '')
      const times = Math.max(1, parseInt(count, 10) || 1)
      const data = mc(ctx.bot)
      const target = data.itemsByName[wanted]
      if (!target) return `unknown item: ${wanted}`
      const allRecipes = data.recipes[String(target.id)] || []
      if (allRecipes.length === 0) return `no recipe for ${wanted}`

      const tableBlock = findNearestBlock(ctx.bot, 'crafting_table', 16)
      let tablePos = null
      if (tableBlock) {
        await approachBlock(ctx.bot, tableBlock)
        tablePos = tableBlock.position
      }

      // Pick a recipe we actually have the ingredients for. bot.recipesFor
      // already filters by what is craftable right now (table-aware); the
      // fallback picks any mcData recipe whose shape fits the grid we have
      // AND whose ingredient ids we own (handles spruce vs oak variants).
      let recipe = null
      try {
        recipe = ctx.bot.recipesFor(target.id, null, 1, tablePos)[0] || null
      } catch { /* degraded bot mock or registry */ }
      if (!recipe && !tablePos) {
        const ownedTypes = new Set(ctx.bot.inventory.items().map((i) => i.type))
        const usesOwned = (r) => {
          const ids = Array.isArray(r.inShape) ? r.inShape.flat() : r.ingredients
          return Array.isArray(ids) && ids.length > 0
            && ids.every((id) => id === null || ownedTypes.has(id))
        }
        recipe = allRecipes.find((r) => fits2x2(r) && usesOwned(r))
          || allRecipes.find(fits2x2)
          || null
      }
      if (!recipe) {
        return tablePos
          ? `no craftable recipe for ${wanted} with current inventory`
          : `no craftable ${wanted} recipe: need ingredients${fits2x2(allRecipes[0] || {}) ? '' : ' or a crafting table'}`
      }
      if (typeof ctx.bot.craft !== 'function') return 'crafting unavailable on this bot'
      for (let i = 0; i < times; i++) {
        await withTimeout(ctx.bot.craft(recipe, 1, tablePos), 20000, `craft ${wanted}`)
        await sleep(200)
      }
      return `crafted ${times}x ${wanted}`
    },
  },

  {
    name: 'craftTable',
    description: 'Craft a crafting_table from 4 planks and place it adjacent if none is within 16 blocks.',
    args: {},
    async run(ctx) {
      if (findNearestBlock(ctx.bot, 'crafting_table', 16)) {
        return 'crafting table already nearby'
      }
      const planks = findItem(ctx, 'planks')
      if (!planks || planks.count < 4) return `need 4 planks (have ${planks ? planks.count : 0})`

      const data = mc(ctx.bot)
      const table = data.itemsByName['crafting_table']
      const recipes = data.recipes[String(table.id)] || []
      // Prefer a variant whose plank ids the bot actually holds so bot.craft
      // finds every ingredient; fall back to any 2x2-fitting shape.
      const owned = new Set(ctx.bot.inventory.items().map((i) => i.type))
      const recipe = recipes.find((r) => fits2x2(r)
        && r.inShape.flat().every((id) => id === null || owned.has(id)))
        || recipes.find(fits2x2)
      if (!recipe) return 'no crafting_table recipe found in mcData'
      if (typeof ctx.bot.craft !== 'function') return 'crafting unavailable on this bot'
      await withTimeout(ctx.bot.craft(recipe, 1, null), 20000, 'craft table')
      await sleep(200)

      if (typeof ctx.bot.placeBlock !== 'function') return 'crafted crafting_table (no placement available)'
      // A solid reference block adjacent to the bot's feet to place against.
      const me = ctx.bot.entity.position.floored()
      const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      for (const [dx, dz] of dirs) {
        const ref = ctx.bot.blockAt({ x: me.x + dx, y: me.y, z: me.z + dz })
        if (!ref || ref.name === 'air' || ref.name === 'cave_air' || ref.name === 'void_air') continue
        const target = ctx.bot.blockAt({ x: me.x + dx * 2, y: me.y, z: me.z + dz * 2 })
        if (target && ['air', 'cave_air', 'void_air'].includes(target.name)) {
          await withTimeout(ctx.bot.placeBlock(ref, { x: dx, y: 0, z: dz }), 15000, 'place table')
          return 'crafted and placed crafting_table'
        }
      }
      return 'crafted crafting_table (no adjacent air to place it)'
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

module.exports = { skills, findNearestBlock, countItem, findItem, equipBestTool }