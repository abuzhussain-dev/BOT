const cfg = require('../config')
const mcData = require('minecraft-data')
const skillsApi = require('../skills')
const { complete, extractJson } = require('../llm')
const { logger } = require('../utils/helpers')
const context = require('../context/builder')

// Auto-eat at this food level even when not yet critical (cfg.foodThreshold
// is 12; 14 gives a safe margin so hunger never stalls health regen).
const AUTO_EAT_FOOD = 14

// Ore blocks whose drops require a pickaxe tier above wooden (mcData
// harvestTools ground truth; stone-tier or better for iron/gold/diamond).
const GATED_ORES = new Set([
  'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'emerald_ore',
  'lapis_ore', 'copper_ore', 'deepslate_diamond_ore', 'coal_ore',
])

/**
 * The planner decides the next single task. Two modes:
 *   1. LLM mode  — asks the configured model for structured JSON.
 *   2. Heuristic mode — simple rule-based grinding (always available).
 *
 * Returns { task, args, reason } or null when nothing sensible to do.
 */
async function plan(state, ctx) {
  if (cfg.llm.enabled) {
    try {
      const task = await planWithLLM(state, ctx)
      // Same tool-tier guard as the heuristic path: an LLM (or a stale
      // habit) picking ore mining bare-handed just grinds air for no drops.
      if (task
        && task.task === 'mineType'
        && GATED_ORES.has(String(task.args?.type || '').toLowerCase())
        && ctx.bot
        && !hasAdequatePickaxe(ctx.bot, String(task.args.type).toLowerCase())) {
        logger.warn('LLM chose ore mining without an adequate pickaxe; diverting to tool bootstrap')
        return nextBootstrapStep(ctx)
      }
      return task
    } catch (e) {
      logger.warn(`LLM planning failed (${e.message}); falling back to heuristics`)
    }
  }
  return planHeuristic(state, ctx)
}

async function planWithLLM(state, ctx = {}) {
  const system = `You are the planning brain of an autonomous Minecraft bot.
You are given the bot's current state and the list of available skills.
Decide the ONE most useful next action to help it grind and progress.
Reply with ONLY a JSON object, no prose, no markdown, shaped exactly as:
{"task":"<skill name>","args":{...},"reason":"<short why>"}
Rules:
- Only use skills from the list. Never invent ones.
- Prefer keeping the bot busy: mine ores, chop trees, collect drops, eat when hungry.
- Healthy priority: only forage/eat when food is low.
- Coordinates are absolute world coordinates.
- args must match the skill's declared arg names. Omit optional args.`

  let user = null
  // Phase C: bounded context prompt from src/context/builder.js.
  // Ground truth for the previous action is ctx.lastFeedback (typed row from
  // brain's lastCycle); getTypedState never populates any such field on state.
  if (process.env.CONTEXT_BUILDER !== 'off') {
    try {
      const built = await context.buildPrompt(ctx.bot, { lastFeedback: ctx.lastFeedback })
      if (!built.ok) throw new Error(built.reason || 'buildPrompt failed')
      user = `${built.messages[1].content}\n\nDecide the next task now. Reply with ONLY the JSON object.`
    } catch (e) {
      logger.warn(`context unavailable (${e.message}); falling back to heuristics`)
      throw e
    }
  }
  if (!user) {
    user = `BOT STATE (JSON):\n${JSON.stringify(state)}\n\nAVAILABLE SKILLS:\n${skillsApi.describeForLLM()}\n\nDecide the next task now.`
  }

  return complete(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { json: false },
  ).then((content) => {
    const parsed = extractJson(content)
    if (!parsed || !parsed.task) {
      logger.warn(`LLM returned unusable JSON, raw: ${content.slice(0, 120)}`)
      return null
    }
    if (!skillsApi.has(parsed.task)) {
      logger.warn(`LLM chose unknown skill "${parsed.task}"`)
      return null
    }
    return {
      task: parsed.task,
      args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
      reason: parsed.reason || 'llm',
    }
  })
}

/**
 * Simple no-API-key fallback so the bot grinds on its own.
 * Order of priority:
 *   1. low health -> eat / wait
 *   2. drops nearby -> collect
 *   3. ores -> mine (but only with an adequate pickaxe tier; otherwise
 *      enqueue the wood -> table -> wooden_pickaxe -> stone_pickaxe chain)
 *   4. flowers/crops -> chop or mine stone as filler
 */
function planHeuristic(state, ctx = {}) {
  const health = state.health
  const food = state.food

  // Vision probe may be absent (degraded ctx, test harness). Never crash on it.
  const probe = typeof ctx.skillGot === 'function'
    ? (name) => {
        try { return !!ctx.skillGot(name) } catch { return false }
      }
    : null

  if (typeof health === 'number' && health < cfg.safeHealth) {
    if (food < cfg.foodThreshold) {
      if (hasFood(ctx)) return { task: 'eat', args: {}, reason: 'low health and hunger' }
      return { task: 'collectNearby', args: {}, reason: 'low health, seek food drops' }
    }
    return null // resting; brain will re-check next cycle
  }

  // Drop collection is cheap and always useful in a grind.
  if (food < cfg.foodThreshold) {
    if (hasFood(ctx)) return { task: 'eat', args: {}, reason: 'hungry' }
  }

  // Pre-food auto-eat at a softer threshold so hunger never gets critical.
  if (food < AUTO_EAT_FOOD && hasFood(ctx)) {
    return { task: 'eat', args: {}, reason: `food ${food} below auto-eat ${AUTO_EAT_FOOD}` }
  }

  const dropNames = ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'copper_ore',
    'coal_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore', 'iron_ore']

  // Tool-tier gate: mining ore bare-handed or with too-low a tier yields no
  // drops, so bootstrap tools first instead of grinding air.
  const oreTarget = probe ? dropNames.find((ore) => probe(ore)) : null
  if (oreTarget && !hasAdequatePickaxe(ctx.bot, oreTarget)) {
    return nextBootstrapStep(ctx)
  }

  if (probe) {
    for (const ore of dropNames) {
      if (probe(ore)) return { task: 'mineType', args: { type: ore }, reason: `grind ${ore}` }
    }

    if (probe('oak_log')) return { task: 'chopTree', args: {}, reason: 'gather wood' }

    if (probe('stone')) return { task: 'mineType', args: { type: 'stone' }, reason: 'grind stone' }

    return null
  }

  // No world vision available: fall back to a safe, argument-free filler task
  // instead of idling or crashing on missing probes.
  return { task: 'collectNearby', args: {}, reason: 'no world vision; collecting nearby drops' }
}

/** mcData handle matching the bot's server version (safe fallback). */
function botMcData(bot) {
  try {
    return mcData(bot?.version || '1.20.4')
  } catch {
    return mcData('1.20.4')
  }
}

const PICKAXE_TIERS = {
  wooden_pickaxe: 1,
  golden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
  netherite_pickaxe: 5,
}

/**
 * Does the inventory hold a pickaxe of the minimum tier required to actually
 * harvest `blockName`? Uses mcData harvestTools as ground truth; blocks with
 * no entry are hand-harvestable.
 */
function hasAdequatePickaxe(bot, blockName) {
  try {
    const block = botMcData(bot).blocksByName[blockName]
    if (!block || !block.harvestTools) return true // hand-harvestable or unknown
    const needIds = Object.keys(block.harvestTools).map(Number)
    const items = bot.inventory?.items() || []
    for (const item of items) {
      const tier = PICKAXE_TIERS[item.name]
      if (tier && needIds.includes(item.type)) return true
    }
    return false
  } catch {
    return true // never let the gate wedge the whole planner
  }
}

/**
 * Next step of the tool-bootstrap chain. The planner returns ONE step per
 * cycle and enqueues the rest via ctx.ctxEnqueue, mirroring brain's manual
 * queue contract ({task, args, reason}). Without an enqueuer (tests, degraded
 * ctx) only the current step is returned, which still makes forward progress.
 */
function nextBootstrapStep(ctx) {
  const bot = ctx.bot
  const inv = () => {
    try { return bot.inventory.items() } catch { return [] }
  }
  const count = (pred) => inv().filter(pred).reduce((n, i) => n + i.count, 0)

  // Any log variant counts toward the 3-log goal (oak_log etc).
  const logs = count((i) => /_log$/.test(i.name))
  const planks = count((i) => /_planks$/.test(i.name))
  const sticks = count((i) => /^stick$/.test(i.name))
  // A table either in inventory or already placed nearby unblocks 3x3 recipes.
  const tables = count((i) => /^crafting_table$/.test(i.name))
    + (probeNearby(ctx, 'crafting_table') ? 1 : 0)
  const hasWoodenPick = count((i) => /(wooden|golden)_pickaxe/.test(i.name)) > 0
  const hasStonePick = count((i) => /_stone_pickaxe$/.test(i.name)) > 0
  const cobble = count((i) => /(^cobblestone$)|(_cobblestone$)/.test(i.name))
  const stone = count((i) => /^stone$/.test(i.name))

  const enqueue = typeof ctx.ctxEnqueue === 'function'
    ? (task, args = {}, reason = '') => {
        try { ctx.ctxEnqueue({ task, args, reason }) } catch { /* best effort */ }
      }
    : null
  const chain = []
  function planStep(task, args, reason, followUps) {
    const rest = Array.isArray(followUps) && followUps.length ? followUps : chain
    if (enqueue && rest.length) {
      for (const t of rest) enqueue(t.task, t.args, t.reason)
    }
    chain.length = 0
    return { task, args, reason }
  }

  if (!hasStonePick) {
    if (!hasWoodenPick && planks === 0 && logs < 3) {
      // Fresh spawn (empty or nearly empty inventory): enqueue the full
      // chain so the queue keeps the bot moving without re-planning.
      const fullChain = [
        { task: 'chopTree', args: {}, reason: 'bootstrap: gather logs' },
        { task: 'collectNearby', args: {}, reason: 'bootstrap: pick up drops' },
        { task: 'craftItem', args: { name: 'oak_planks' }, reason: 'bootstrap: planks' },
        { task: 'craftTable', args: {}, reason: 'bootstrap: table' },
        { task: 'craftItem', args: { name: 'stick' }, reason: 'bootstrap: sticks' },
        { task: 'craftItem', args: { name: 'wooden_pickaxe' }, reason: 'bootstrap: wooden pickaxe' },
        { task: 'mineType', args: { type: 'stone' }, reason: 'bootstrap: cobblestone x3' },
        { task: 'mineType', args: { type: 'stone' }, reason: 'bootstrap: cobblestone x3' },
        { task: 'mineType', args: { type: 'stone' }, reason: 'bootstrap: cobblestone x3' },
        { task: 'collectNearby', args: {}, reason: 'bootstrap: pick up stone' },
        { task: 'craftItem', args: { name: 'stick' }, reason: 'bootstrap: stick for stone pickaxe' },
        { task: 'craftItem', args: { name: 'stone_pickaxe' }, reason: 'bootstrap: stone pickaxe' },
      ]
      const [first, ...rest] = fullChain
      return planStep(first.task, first.args, first.reason, rest)
    }
    if (!hasWoodenPick) {
      // Wood budget in plank terms: pick(3) + table(4 if still needed)
      // + sticks(one craft: 2 planks -> 4 sticks). Top up before spending
      // so no craft step can fail on missing ingredients (livelock guard).
      const needPlanks = 3 + (tables === 0 ? 4 : 0) + (sticks === 0 ? 2 : 0)
      const woodBudget = planks + logs * 4
      if (woodBudget < needPlanks) {
        if (logs > 0) return planStep('craftItem', { name: 'oak_planks' }, 'bootstrap: convert logs to planks')
        return planStep('chopTree', {}, 'bootstrap: need more wood')
      }
      if (planks === 0) return planStep('craftItem', { name: 'oak_planks' }, 'bootstrap: planks from logs')
      if (sticks === 0) return planStep('craftItem', { name: 'stick' }, 'bootstrap: sticks')
      if (tables === 0) {
        return planks >= 4
          ? planStep('craftTable', {}, 'bootstrap: crafting table')
          : planStep('craftItem', { name: 'oak_planks' }, 'bootstrap: planks for table')
      }
      return planStep('craftItem', { name: 'wooden_pickaxe' }, 'bootstrap: wooden pickaxe')
    }
    if (cobble + stone >= 3) {
      if (sticks === 0) {
        if (planks >= 2) return planStep('craftItem', { name: 'stick' }, 'bootstrap: sticks')
        if (logs > 0 || planks > 0) return planStep('craftItem', { name: 'oak_planks' }, 'bootstrap: planks for sticks')
        return planStep('chopTree', {}, 'bootstrap: need wood for sticks')
      }
      return planStep('craftItem', { name: 'stone_pickaxe' }, 'bootstrap: stone pickaxe')
    }
    if (probeNearby(ctx, 'stone')) {
      return planStep('mineType', { type: 'stone' }, 'bootstrap: mine stone')
    }
    return planStep('mineType', { type: 'stone' }, 'bootstrap: seek stone')
  }

  // Stone pickaxe secured; ores are now worth mining.
  return { task: 'mineType', args: { type: 'iron_ore' }, reason: 'tooling complete; grind iron_ore' }
}

/** Local probe helper that tolerates missing vision (mirrors planHeuristic). */
function probeNearby(ctx, name) {
  if (typeof ctx.skillGot !== 'function') return false
  try { return !!ctx.skillGot(name) } catch { return false }
}

function hasFood(ctx) {
  try {
    return !!ctx.bot?.inventory?.items()?.some((i) => i.foodPoints)
  } catch {
    return false
  }
}

module.exports = { plan, hasAdequatePickaxe, nextBootstrapStep, AUTO_EAT_FOOD }