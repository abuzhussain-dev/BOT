const cfg = require('../config')
const skillsApi = require('../skills')
const { complete, extractJson } = require('../llm')
const { logger } = require('../utils/helpers')
const context = require('../context/builder')

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
 *   3. ores -> mine
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

  const dropNames = ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'copper_ore',
    'coal_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore', 'iron_ore']
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

function hasFood(ctx) {
  try {
    return !!ctx.bot?.inventory?.items()?.some((i) => i.foodPoints)
  } catch {
    return false
  }
}

module.exports = { plan }