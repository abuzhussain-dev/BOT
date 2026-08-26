/**
 * In-process control server. Lets an external CLI (bin/botctl.js) drive the
 * live bot over a Unix socket without touching game chat.
 *
 * Commands (single line, space separated):
 *   status              -> state snapshot + last brain cycle + queue depth
 *   pos                 -> position only
 *   chat <text...>      -> send chat message as the bot
 *   skills              -> list available skills
 *   run <skill> [args]  -> execute skill now; args as JSON string or k=v pairs
 *   enqueue <taskJSON>  -> push task into the brain queue
 *   stop                -> graceful shutdown
 */
const net = require('net')
const fs = require('fs')
const { logger } = require('./utils/helpers')
const skills = require('./skills')
const botApi = require('./bot')
const { getBotState } = botApi

// getter returns the CURRENT bot instance (or null before connect)
const liveBot = () => botApi.bot

const SOCK = process.env.BOTCTL_SOCK || '/tmp/botc.sock'
let server = null

function parseArgs(raw) {
  raw = raw.trim()
  if (!raw) return {}
  if (raw.startsWith('{')) return JSON.parse(raw)
  const out = {}
  for (const pair of raw.split(/\s+/)) {
    const idx = pair.indexOf('=')
    if (idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return out
}

async function handle(line) {
  const sp = line.indexOf(' ')
  const cmd = (sp === -1 ? line : line.slice(0, sp)).toLowerCase()
  const rest = sp === -1 ? '' : line.slice(sp + 1)
  const b = liveBot()

  switch (cmd) {
    case 'status': {
      const state = getBotState()
      const brain = require('./agents/brain')
      return {
        connected: !!b && b._client !== null,
        health: b?.health ?? null,
        food: b?.food ?? null,
        position: b ? serializePos(b.entity?.position) : null,
        state: state ?? null,
        queueDepth: brain.queue.length,
        lastCycle: brain.lastCycle
          ? { action: brain.lastCycle.action, ok: brain.lastCycle.ok }
          : null,
        uptimeSec: Math.round(process.uptime()),
      }
    }
    case 'pos':
      return { position: serializePos(b?.entity?.position), dimension: b?.entity?.dimension }
    case 'chat':
    case 'say':
      if (!rest) throw new Error('usage: chat <text>')
      b.chat(rest)
      return { sent: rest }
    case 'skills':
      return { skills: skills.describeForLLM().split('\n') }
    case 'run': {
      if (!rest) throw new Error('usage: run <skill> [{json}|k=v ...]')
      const sp2 = rest.indexOf(' ')
      const name = sp2 === -1 ? rest : rest.slice(0, sp2)
      const argStr = sp2 === -1 ? '' : rest.slice(sp2 + 1)
      if (!skills.has(name)) throw new Error(`unknown skill: ${name}`)
      const ctx = { bot: b, logger, state: getBotState() }
      const result = await skills.run(ctx, name, parseArgs(argStr))
      return { skill: name, result: result ?? null }
    }
    case 'enqueue': {
      const task = JSON.parse(rest)
      const brain = require('./agents/brain')
      brain.enqueue(task)
      return { queued: task, queueDepth: brain.queue.length }
    }
    case 'stop':
      setTimeout(() => require('./agents/brain').quit?.() ?? process.exit(0), 50)
      return { stopping: true }
    default:
      throw new Error(`unknown command: ${cmd} (try status|pos|chat|skills|run|enqueue|stop)`)
  }
}

function serializePos(p) {
  if (!p) return null
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }
}

function start() {
  try { fs.unlinkSync(SOCK) } catch (_) {}
  server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        handle(line)
          .then((res) => conn.write(JSON.stringify(res) + '\n'))
          .catch((e) => conn.write(JSON.stringify({ error: e.message }) + '\n'))
      }
    })
  })
  server.listen(SOCK, () => logger.info(`[ctl] listening on ${SOCK}`))
  server.on('error', (e) => logger.error(`[ctl] ${e.message}`))
}

function stop() {
  try { server?.close(); fs.unlinkSync(SOCK) } catch (_) {}
}

module.exports = { start, stop }
