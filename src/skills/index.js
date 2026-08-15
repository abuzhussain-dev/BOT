const { skills: foundation } = require('./foundation')
const { logger, withTimeout } = require('../utils/helpers')

const registry = new Map()

for (const skill of foundation) {
  registry.set(skill.name, skill)
}

/**
 * List of skills in a concise form safe to send to an LLM prompt.
 */
function describeForLLM() {
  return [...registry.values()].map((s) => {
    const args = Object.entries(s.args || {})
      .map(([k, t]) => `${k} (${t})`)
      .join(', ')
    return `- ${s.name}: ${s.description}${args ? ` [args: ${args}]` : ''}`
  }).join('\n')
}

function has(name) {
  return registry.has(name)
}

function get(name) {
  return registry.get(name)
}

/**
 * Run a skill by name with timeout protection. `ctx` carries
 * { bot, logger, state } helpers for skills.
 */
async function run(ctx, name, args = {}) {
  const skill = registry.get(name)
  if (!skill) throw new Error(`unknown skill: ${name}`)

  const argDef = skill.args || {}
  const clean = {}
  for (const [key, type] of Object.entries(argDef)) {
    const raw = args[key]
    if (raw === undefined || raw === null) {
      if (type.endsWith('?')) continue
      throw new Error(`skill ${name} missing required arg: ${key}`)
    }
    if (type.startsWith('number')) {
      const n = Number(raw)
      if (Number.isNaN(n)) throw new Error(`skill ${name} arg ${key} must be a number`)
      clean[key] = n
    } else if (type.startsWith('boolean')) {
      clean[key] = raw === true || raw === 'true' || raw === 1
    } else {
      clean[key] = String(raw)
    }
  }

  logger.info(`[skill] ${name} ${JSON.stringify(clean)}`)

  // A skill must never hang the brain loop.
  return withTimeout(skill.run(ctx, clean), 60000, `skill:${name}`)
}

module.exports = { registry, describeForLLM, has, get, run }