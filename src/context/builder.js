/**
 * Phase C — Context Builder.
 * Assembles bounded LLM prompt from typed state, episodic memory, env profile, and skills.
 * Exports: buildPrompt, buildMessages, estimateTokens, DEFAULT_BUDGET
 */

const { getTypedState } = require('../perception/state')
const episodic = require('../memory/episodic')
const envProfile = require('../memory/envProfile')
const skillsApi = require('../skills')

const DEFAULT_BUDGET = parseInt(process.env.CONTEXT_BUDGET, 10) || 8000

// Token estimator — re-export from episodic for consistency
function estimateTokens(text) {
  return episodic.estimateTokens(text)
}

// Safe math helpers for adversarial inputs
function safeNum(n, fallback = 0) {
  if (typeof n !== 'number') return fallback
  if (!Number.isFinite(n)) return fallback
  return n
}

function safePosition(pos) {
  if (!pos || typeof pos !== 'object') return { x: 0, y: 0, z: 0 }
  return {
    x: safeNum(pos.x),
    y: safeNum(pos.y),
    z: safeNum(pos.z),
  }
}

function hasValidPosition(entity) {
  return entity && entity.position && 
    typeof entity.position === 'object' &&
    Number.isFinite(entity.position.x) &&
    Number.isFinite(entity.position.y) &&
    Number.isFinite(entity.position.z)
}

function safeDistanceTo(pos1, pos2) {
  const p1 = safePosition(pos1)
  const p2 = safePosition(pos2)
  return Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z)
}

// L1 System prompt (static, ~250 tokens)
const L1_SYSTEM = `You are BOTC, an autonomous Minecraft agent.
Output ONLY valid JSON: {"task": "skill_name", "args": {...}, "reason": "..."}
Never dig straight down. Keep health above 6.
Coordinates are absolute (x,y,z). Time is ticks (0-24000).`

// Skills cache: key = registry.size, value = skillsText
let skillsCache = { size: -1, text: '' }

function getSkillsText() {
  const size = skillsApi.registry.size
  if (skillsCache.size !== size) {
    skillsCache.size = size
    skillsCache.text = skillsApi.describeForLLM()
  }
  return skillsCache.text
}

function renderEnvDigest(profile, position) {
  if (!profile || !position) return ''

  const safePos = safePosition(position)
  const lines = []
  // Spawn, base, server, version, dayLengthTicks
  if (profile.spawn) lines.push(`spawn: ${safeNum(profile.spawn.x)},${safeNum(profile.spawn.y)},${safeNum(profile.spawn.z)}`)
  if (profile.base) lines.push(`base: ${safeNum(profile.base.x)},${safeNum(profile.base.y)},${safeNum(profile.base.z)}`)
  if (profile.server) lines.push(`server: ${profile.server}`)
  if (profile.version) lines.push(`version: ${profile.version}`)
  if (profile.dayLengthTicks) lines.push(`dayLengthTicks: ${profile.dayLengthTicks}`)

  // Nearest 5 chests
  if (profile.chests?.length) {
    const nearest = profile.chests
      .filter(c => c && typeof c === 'object' && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z))
      .map(c => ({ ...c, dist: safeDistanceTo(c, safePos) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map(c => `${safeNum(c.x)},${safeNum(c.y)},${safeNum(c.z)}`)
    if (nearest.length) lines.push(`chests: ${nearest.join('; ')}`)
  }

  // Nearest 2 crafting tables
  if (profile.stations?.crafting_table?.length) {
    const nearest = profile.stations.crafting_table
      .filter(c => c && typeof c === 'object' && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z))
      .map(c => ({ ...c, dist: safeDistanceTo(c, safePos) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2)
      .map(c => `${safeNum(c.x)},${safeNum(c.y)},${safeNum(c.z)}`)
    if (nearest.length) lines.push(`crafting_table: ${nearest.join('; ')}`)
  }

  // Nearest 2 furnaces
  if (profile.stations?.furnace?.length) {
    const nearest = profile.stations.furnace
      .filter(c => c && typeof c === 'object' && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z))
      .map(c => ({ ...c, dist: safeDistanceTo(c, safePos) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2)
      .map(c => `${safeNum(c.x)},${safeNum(c.y)},${safeNum(c.z)}`)
    if (nearest.length) lines.push(`furnace: ${nearest.join('; ')}`)
  }

  // Ore sightings: grouped counts per ore + nearest coordinate
  if (profile.oreSightings?.length) {
    const grouped = {}
    for (const o of profile.oreSightings) {
      if (!o || typeof o !== 'object' || !o.name) continue
      if (!grouped[o.name]) grouped[o.name] = { count: 0, nearest: null, nearestDist: Infinity }
      grouped[o.name].count++
      const d = safeDistanceTo(o, safePos)
      if (d < grouped[o.name].nearestDist) {
        grouped[o.name].nearestDist = d
        grouped[o.name].nearest = `${safeNum(o.x)},${safeNum(o.y)},${safeNum(o.z)}`
      }
    }
    const oreLines = Object.entries(grouped)
      .map(([name, data]) => `${name} x${data.count} (nearest ${data.nearest})`)
    if (oreLines.length) lines.push(`ores: ${oreLines.join('; ')}`)
  }

  return lines.join('\n')
}

function renderLastAction(lastFeedback, recentEntries) {
  if (lastFeedback) {
    const { skill, ok, result, invDelta, stagnation } = lastFeedback
    const status = ok ? 'ok' : `ERROR(${lastFeedback.errorType || 'unknown'})`
    const invStr = invDelta ? 'yes' : 'no'
    const stagStr = stagnation ? 'yes' : 'no'
    return `LAST ACTION: ${skill} → ${status} ${result || ''} (invDelta:${invStr}, stagnation:${stagStr})`
  }
  if (recentEntries?.length) {
    const last = recentEntries[0]
    return `LAST ACTION: ${last.action} → ${last.ok ? 'ok' : 'ERR'} ${last.result || ''}`
  }
  return '(first turn)'
}

function renderRecentEntries(recentEntries, maxChars = 80) {
  if (!recentEntries?.length) return ''
  return recentEntries
    .slice()
    .reverse() // newest last per spec
    .map(e => {
      const time = e.ts ? new Date(e.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '??:??'
      const result = (e.result || '').slice(0, maxChars)
      return `[${time}] ${e.action} ${e.ok ? 'ok' : 'ERR'} ${result}`
    })
    .join('\n')
}

function renderSummaryBullets(bullets) {
  if (!bullets?.length) return ''
  // Newest last, kept while under budget (drop oldest first)
  return bullets.map(b => `- ${b}`).join('\n')
}

function buildMessages(slices, budget, opts = {}) {
  const {
    system = L1_SYSTEM,
    state = null,
    env = '',
    summaryBullets = [],
    recent = [],
    lastFeedback = null,
    skillsText = '',
    taskHint = null,
  } = slices

  // Character budget (hard limit on final prompt length)
  const charBudget = opts.charBudget ?? budget * 4

  // Render each slice to text
  const rendered = {
    system,
    state: state ? JSON.stringify(state) : '',
    env: env || '',
    summary: renderSummaryBullets(summaryBullets),
    recent: renderRecentEntries(recent),
    lastAction: renderLastAction(lastFeedback, recent),
    skills: skillsText || '',
    taskHint: taskHint || '',
  }

  // Measure tokens for each slice
  const tokenCounts = {}
  for (const [key, text] of Object.entries(rendered)) {
    tokenCounts[key] = estimateTokens(text)
  }

  const dropped = []
  const truncated = {}

  // Priority trim order (lowest priority first, per DESIGN.md §3 table)
  // Priority 8: Episodic summary bullets (15%) - drop oldest first
  // Priority 7: Episodic recent n=12 (10%) - n 12→6→3→1 then drop
  // Priority 6: Env profile digest (5%) - chests 5→3→1, ores nearest-only → name-counts only
  // Priority 5: Skills list (8%) - drop arg lists, then descriptions (names only)
  // Priority 4: L2 typed state JSON (12%) - drop nearbyBlocks, then nearbyEntities, then halve inventory
  // Priority 3: Last action result (2%) - truncate result to 60 chars, then drop
  // Priority 2: Manual task hint (1%) - never trimmed
  // Priority 1: L1 system + rules (5%) - never trimmed

  let totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)

  // Helper to rebuild user message from current rendered slices
  function buildUserMessage() {
    const parts = []
    if (rendered.taskHint) parts.push(rendered.taskHint)
    if (rendered.summary) parts.push(`HISTORY:\n${rendered.summary}`)
    if (rendered.recent) parts.push(`RECENT:\n${rendered.recent}`)
    if (rendered.lastAction) parts.push(rendered.lastAction)
    if (rendered.state) parts.push(`STATE:\n${rendered.state}`)
    if (rendered.env) parts.push(`ENV:\n${rendered.env}`)
    if (rendered.skills) parts.push(`SKILLS:\n${rendered.skills}`)
    return parts.join('\n\n')
  }

  // Trim in priority order until under token budget
  // Priority 8: Summary bullets - drop oldest
  while (totalTokens > budget && rendered.summary) {
    const lines = rendered.summary.split('\n').filter(Boolean)
    if (lines.length <= 1) {
      rendered.summary = ''
      dropped.push('summary')
      break
    }
    lines.shift() // drop oldest
    rendered.summary = lines.join('\n')
    tokenCounts.summary = estimateTokens(rendered.summary)
    totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
    truncated.summary = true
  }

  // Priority 7: Recent entries - reduce n 12→6→3→1→0
  const recentSizes = [12, 6, 3, 1, 0]
  let recentSizeIdx = 0
  while (totalTokens > budget && recentSizeIdx < recentSizes.length - 1 && rendered.recent) {
    recentSizeIdx++
    const n = recentSizes[recentSizeIdx]
    if (n === 0) {
      rendered.recent = ''
      dropped.push('recent')
      break
    }
    // Re-render with new n
    rendered.recent = renderRecentEntries(recent.slice(-n))
    tokenCounts.recent = estimateTokens(rendered.recent)
    totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
    truncated.recent = true
  }

  // Priority 6: Env digest - simplify
  if (totalTokens > budget && rendered.env) {
    // First: reduce chests 5→3→1
    // This would require re-rendering env, but we'll just truncate for simplicity
    // Per spec: "chests 5→3→1, ores nearest-only → name-counts only"
    // For now, just truncate the env text
    const lines = rendered.env.split('\n')
    // Keep only first 5 lines (spawn, base, server, version, dayLengthTicks, chests)
    if (lines.length > 5) {
      rendered.env = lines.slice(0, 5).join('\n')
      tokenCounts.env = estimateTokens(rendered.env)
      totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
      truncated.env = true
    }
  }

  // Priority 5: Skills - drop arg lists, then descriptions
  if (totalTokens > budget && rendered.skills) {
    // First: remove arg lists (keep names and descriptions)
    let lines = rendered.skills.split('\n')
    lines = lines.map(l => l.replace(/ \[args: [^\]]+\]/, ''))
    rendered.skills = lines.join('\n')
    tokenCounts.skills = estimateTokens(rendered.skills)
    totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
    truncated.skills = true

    // If still over, drop descriptions (keep names only)
    if (totalTokens > budget) {
      lines = rendered.skills.split('\n')
      lines = lines.map(l => l.replace(/: .*/, ''))
      rendered.skills = lines.join('\n')
      tokenCounts.skills = estimateTokens(rendered.skills)
      totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
    }
  }

  // Priority 4: State JSON - drop nearbyBlocks, nearbyEntities, halve inventory
  if (totalTokens > budget && rendered.state) {
    try {
      const stateObj = JSON.parse(rendered.state)
      if (stateObj.nearbyBlocks) {
        delete stateObj.nearbyBlocks
        rendered.state = JSON.stringify(stateObj)
        tokenCounts.state = estimateTokens(rendered.state)
        totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
        truncated.state = true
      }
    } catch {}
  }
  if (totalTokens > budget && rendered.state) {
    try {
      const stateObj = JSON.parse(rendered.state)
      if (stateObj.nearbyEntities) {
        delete stateObj.nearbyEntities
        rendered.state = JSON.stringify(stateObj)
        tokenCounts.state = estimateTokens(rendered.state)
        totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
        truncated.state = true
      }
    } catch {}
  }
  if (totalTokens > budget && rendered.state) {
    try {
      const stateObj = JSON.parse(rendered.state)
      if (stateObj.inventory && stateObj.inventory.length > 0) {
        stateObj.inventory = stateObj.inventory.slice(0, Math.ceil(stateObj.inventory.length / 2))
        rendered.state = JSON.stringify(stateObj)
        tokenCounts.state = estimateTokens(rendered.state)
        totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
        truncated.state = true
      }
    } catch {}
  }

  // Priority 3: Last action - truncate to 60 chars then drop
  if (totalTokens > budget && rendered.lastAction) {
    if (rendered.lastAction.length > 60) {
      rendered.lastAction = rendered.lastAction.slice(0, 60) + '…'
      tokenCounts.lastAction = estimateTokens(rendered.lastAction)
      totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
      truncated.lastAction = true
    } else {
      rendered.lastAction = ''
      dropped.push('lastAction')
      tokenCounts.lastAction = 0
      totalTokens = Object.values(tokenCounts).reduce((a, b) => a + b, 0)
    }
  }

  // Build user message
  let userMsg = buildUserMessage()

  // If STILL over token budget after all trims (pathological), hard-slice user message
  if (totalTokens > budget) {
    const maxChars = budget * 4
    if (userMsg.length > maxChars) {
      userMsg = userMsg.slice(0, maxChars) + '\n…[truncated]'
      dropped.push('hard_slice')
    }
  }

  // ALSO enforce character budget if specified (hard limit on final prompt length)
  const fullPrompt = `${system}\n\n${userMsg}`
  if (fullPrompt.length > charBudget) {
    // Hard slice the user message to fit within char budget
    const systemLen = system.length + 3 // \n\n
    const truncMarker = '\n…[truncated]'
    const userBudget = charBudget - systemLen - truncMarker.length
    if (userBudget > 0) {
      userMsg = userMsg.slice(0, userBudget) + truncMarker
    } else {
      userMsg = truncMarker
    }
    dropped.push('char_budget_hard_slice')
  }

  const messages = [
    { role: 'system', content: rendered.system },
    { role: 'user', content: userMsg },
  ]

  return {
    messages,
    tokens: totalTokens,
    dropped,
    truncated,
  }
}

function buildPrompt(bot, opts = {}) {
  // Edge case: bot not spawned / reconnecting
  if (!bot || !bot.entity || !bot.entity.position) {
    return { ok: false, reason: 'not_spawned' }
  }

  // Validate position is finite
  const pos = bot.entity.position
  if (!pos || typeof pos !== 'object' || 
      !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    return { ok: false, reason: 'not_spawned' }
  }

  const budget = opts.budget ?? DEFAULT_BUDGET
  const includeSkills = opts.includeSkills !== false

  // Gather all slices with defensive error handling
  let state = null
  try {
    state = getTypedState(bot)
  } catch {
    // If getTypedState throws due to malformed bot, continue with null state
    state = null
  }

  const envProfileData = envProfile.get()
  const summary = episodic.getSummary()
  const recentEntries = episodic.recent(12)
  const lastFeedback = opts.lastFeedback ?? null
  const skillsText = includeSkills ? getSkillsText() : ''
  const taskHint = opts.taskHint ?? null

  // Build env digest (handles NaN/Infinity positions internally)
  const envDigest = state ? renderEnvDigest(envProfileData, state.position) : ''

  // Build slices object for buildMessages
  const slices = {
    system: L1_SYSTEM,
    state,
    env: envDigest,
    summaryBullets: summary.bullets,
    recent: recentEntries,
    lastFeedback,
    skillsText,
    taskHint,
  }

  // Pass charBudget when maxChars is specified (for test compatibility)
  const buildOpts = {}
  if (opts.maxChars) {
    buildOpts.charBudget = opts.maxChars
  }

  const { messages, tokens, dropped, truncated } = buildMessages(slices, budget, buildOpts)

  return {
    ok: true,
    messages,
    tokens,
    meta: { dropped, truncated },
  }
}

// Wrapper for test contract compatibility
// Returns { prompt, slices, tokens } per test harness expectation
function buildContext(bot, opts = {}) {
  // Support both maxChars (test contract) and budget (DESIGN.md) parameter names
  const budget = opts.maxChars ?? opts.budget ?? DEFAULT_BUDGET
  const result = buildPrompt(bot, { ...opts, budget })

  if (!result.ok) {
    // Return empty-but-valid structure for edge cases
    return {
      prompt: '',
      slices: {},
      tokens: 0,
    }
  }

  // Extract slices from the rendered messages
  const userMsg = result.messages[1]?.content || ''
  const systemMsg = result.messages[0]?.content || ''

  // Parse user message into named sections
  const slices = {}
  const sections = userMsg.split('\n\n')
  for (const section of sections) {
    if (section.startsWith('MANUAL TASK QUEUED:')) {
      slices.manual = section
    } else if (section.startsWith('HISTORY:')) {
      slices.history = section.slice('HISTORY:'.length).trim()
    } else if (section.startsWith('RECENT:')) {
      slices.recent = section.slice('RECENT:'.length).trim()
    } else if (section.startsWith('LAST ACTION:')) {
      slices.lastAction = section
    } else if (section.startsWith('STATE:')) {
      slices.state = section.slice('STATE:'.length).trim()
    } else if (section.startsWith('ENV:')) {
      slices.env = section.slice('ENV:'.length).trim()
    } else if (section.startsWith('SKILLS:')) {
      slices.skills = section.slice('SKILLS:'.length).trim()
    }
  }
  if (systemMsg) slices.system = systemMsg

  // Use the full concatenated prompt as the prompt string
  const prompt = `${systemMsg}\n\n${userMsg}`

  // CRITICAL: tokens MUST equal estimateTokens(prompt) for consistency
  const tokens = estimateTokens(prompt)

  return {
    prompt,
    slices,
    tokens,
  }
}

module.exports = { buildPrompt, buildMessages, estimateTokens, DEFAULT_BUDGET, buildContext }