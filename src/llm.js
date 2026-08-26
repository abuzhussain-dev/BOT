const cfg = require('./config')
const { withTimeout } = require('./utils/helpers')

/**
 * Minimal OpenAI-compatible chat-completions client (works with OpenAI,
 * DeepSeek, Groq, Ollama, LM Studio, ...). Only used when the brain
 * decides to call the LLM — never required for the bot to run.
 */
async function complete(messages, opts = {}) {
  if (!cfg.llm.enabled) throw new Error('LLM not enabled (set LLM_BASE_URL)')

  const body = {
    model: opts.model || cfg.llm.model,
    messages,
    temperature: opts.temperature ?? cfg.llm.temperature,
    stream: false,
    // Nemotron free routes default to extended thinking (60s+ stalls).
    // 'none' returns the final answer directly (~2s measured).
    reasoning_effort: opts.reasoningEffort ?? (process.env.LLM_REASONING_EFFORT || 'none'),
  }
  if (opts.json) {
    // Some providers (Ollama) reject response_format, so we only add it
    // when it was explicitly requested and rely on tolerant parsing anyway.
    body.response_format = opts.json === true ? { type: 'json_object' } : undefined
  }

  const url = cfg.llm.baseURL.replace(/\/+$/, '') + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.llm.apiKey) headers.Authorization = `Bearer ${cfg.llm.apiKey}`

  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    cfg.llm.timeoutSec * 1000,
    'llm.request',
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM returned empty content')
  }
  return content
}

/**
 * Extracts the first balanced JSON object from a model reply.
 * Handles stray markdown fences, prose before/after, etc.
 */
function extractJson(text) {
  if (!text) return null
  let start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch (e) {
          return null
        }
      }
    }
  }
  return null
}

module.exports = { complete, extractJson }