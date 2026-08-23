const fs = require('fs')
const path = require('path')
const cfg = require('../config')
const { complete } = require('../llm')
const { logger } = require('../utils/helpers')

const EPISODE_CAP = parseInt(process.env.MEMORY_EPISODE_CAP, 10) || 200
const KEEP_RECENT = 50
const FOLD_BATCH = 60
const TOKEN_BUDGET = parseInt(process.env.MEMORY_BUDGET, 10) || 4000
const DIR = __dirname

const EPISODES_FILE = path.join(DIR, 'episodes.ndjson')
const SUMMARY_FILE = path.join(DIR, 'summary.json')

const entries = []
const summary = { ts: 0, updated: 0, bullets: [] }
let writeQ = Promise.resolve()
let loggedDisabled = false

function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

async function load() {
  try {
    const raw = fs.readFileSync(EPISODES_FILE, 'utf8').trim()
    if (raw) {
      const lines = raw.split('\n')
      for (const line of lines.slice(-EPISODE_CAP * 2)) {
        try { entries.push(JSON.parse(line)) } catch { /* skip corrupt line */ }
      }
    }
  } catch { /* no file yet */ }

  try {
    const s = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'))
    summary.ts = s.ts || 0
    summary.updated = s.updated || 0
    summary.bullets = Array.isArray(s.bullets) ? s.bullets : []
  } catch { /* no summary yet */ }

  return { entries, summary }
}

function record(entry) {
  const e = { ...entry }
  e.ts = e.ts || Date.now()
  if (e.result && typeof e.result === 'string') e.result = e.result.slice(0, 200)
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
  entries.push(e)
  writeQ = writeQ
    .then(() => fs.promises.appendFile(EPISODES_FILE, JSON.stringify(e) + '\n'))
    .catch((err) => logger.warn(`[episodic] append failed: ${err.message}`))
}

function flush() {
  return writeQ.catch(() => {})
}

function getSummary() {
  return { ts: summary.ts, updated: summary.updated, bullets: summary.bullets.slice() }
}

function recent(n = 20) {
  return entries.slice(-n)
}

function hhmm(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

async function summarize(opts = {}) {
  try {
    const keep = Math.max(0, entries.length - KEEP_RECENT)
    const candidates = entries.slice(0, keep).slice(-FOLD_BATCH)
    if (!candidates.length) return { ok: true, folded: 0 }

    if (!cfg.llm.enabled) {
      if (!loggedDisabled) { loggedDisabled = true; logger.warn('[episodic] summarize skipped — LLM disabled') }
      return { ok: false }
    }

    const prev = summary.bullets.length ? summary.bullets.join('\n') : '(none)'
    const lines = candidates.map((e) => {
      const bits = [new Date(e.ts).toISOString(), e.type]
      if (e.action) bits.push(e.action)
      if (e.result) bits.push(e.result)
      return '- ' + bits.join(' ')
    })
    const messages = [
      { role: 'system', content: 'You are BOTC, a Minecraft bot. Fold the episode log below into concise bullet-point long-term memories. One bullet per line, no numbering, past tense, keep coordinates and item counts if mentioned. Ignore trivial noise. Output only bullets.' },
      { role: 'user', content: `PREVIOUS SUMMARY:\n${prev}\n\nEPISODES:\n${lines.join('\n')}` },
    ]
    const content = await complete(messages, {
      model: opts.llmOverride || cfg.llm.cheapestModel,
      temperature: 0.2,
    })

    const newBullets = content
      .trim()
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => `[${hhmm(candidates[0].ts)}] ${b}`)
      .slice(0, FOLD_BATCH)

    const merged = summary.bullets.concat(newBullets)
    while (merged.length && estimateTokens(merged.join('\n')) > TOKEN_BUDGET) merged.shift()
    summary.bullets = merged
    summary.ts = Date.now()
    summary.updated = Date.now()

    await flush()
    const tail = entries.slice(-KEEP_RECENT)
    atomicWrite(SUMMARY_FILE, JSON.stringify({ ts: summary.ts, updated: summary.updated, bullets: summary.bullets }))
    atomicWrite(EPISODES_FILE, tail.map((e) => JSON.stringify(e)).join('\n') + (tail.length ? '\n' : ''))
    const folded = candidates.length
    entries.splice(0, entries.length - KEEP_RECENT)
    await flush()
    return { ok: true, folded }
  } catch (e) {
    logger.warn(`[episodic] summarize failed: ${e.message}`)
    return { ok: false }
  }
}

module.exports = { EPISODE_CAP, KEEP_RECENT, FOLD_BATCH, TOKEN_BUDGET, DIR, load, record, flush, summarize, getSummary, recent, estimateTokens }