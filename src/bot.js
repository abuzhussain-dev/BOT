const mineflayer = require('mineflayer')
const cfg = require('./config')
const { AuthManager } = require('./auth')
const { setupMovement, stopMoving } = require('./motion')
const { logger } = require('./utils/helpers')
const episodic = require('./memory/episodic')
const envProfile = require('./memory/envProfile')

let bot = null
let auth = null
let reconnectTimer = null
let reconnecting = false
let stopping = false // manual shutdown — don't auto-reconnect
let bootAttempts = 0 // consecutive boot/reset attempts (server coming up)

const { getTypedState } = require('./perception/state')

/** Typed L2 state (Phase A) used by the AI planner. */
function getBotState() {
  return getTypedState(bot)
}

// Aternos confirmed Purpur 1.21.11 — pin the version so the handshake sends
// the matching protocol (auto-detect would guess a newer default → ECONNRESET).
const BOT_VERSION = cfg.version || '1.21.11'

function start() {
  if (bot) {
    logger.warn('[bot] already created, skipping duplicate start')
    return
  }
  logger.info(`Connecting to ${cfg.serverHost}:${cfg.serverPort} as ${cfg.botUsername}${BOT_VERSION ? ` (${BOT_VERSION})` : ' (auto version)'} ${cfg.authMode}`)
  bot = mineflayer.createBot({
    host: cfg.serverHost,
    port: cfg.serverPort,
    username: cfg.botUsername,
    auth: cfg.authMode,
    version: BOT_VERSION,
    hideErrors: false, // surface real errors during bring-up; disable later if chatty
    checkTimeoutInterval: 600000, // 10min — Aternos can take 90-120s+ to boot the world mid-join
  })

  // Opt-in ReplayMod recording: set RECORD_REPLAY=1 to capture the session to
  // recorder/recordings/*.mcpr (off by default). Auto-saves a new file every
  // 5 minutes (override with RECORD_SPLIT_MS). Zero impact unless enabled.
  let replayRec
  if (process.env.RECORD_REPLAY) {
    try {
      const splitMs = Number(process.env.RECORD_SPLIT_MS) || 5 * 60 * 1000
      replayRec = require('../recorder/recorder').attachRecorder(bot, { base: `ruin_${Date.now()}`, autoSaveMs: splitMs })
      logger.info(`[recorder] recording -> ${replayRec.getOutPath()}`)
    } catch (e) { logger.warn('[recorder] failed to start:', e.message) }
  }
  bot.once('end', () => {
    if (replayRec) { try { const m = replayRec.stop(); logger.info('[recorder] saved', m.outPath) } catch (e) { logger.warn('[recorder] save failed:', e.message) } }
  })

  let spawnHandled = false

  // Spawn timeout: make sure we reconnect if the server never spawns us
  // (Aternos boot, queue, or a silent reset). 150s as per the proven AFK bot.
  const spawnTimeout = setTimeout(() => {
    if (!spawnHandled && bot) {
      logger.warn('[bot] Spawn timeout (150s) — ending connection to retry')
      try { bot.end('spawn-timeout') } catch { /* already closed */ }
    }
  }, 150000)

  bot.on('login', () => {
    logger.info(`Logged into server (username ${bot.username})`)
    envProfile.updateFromLogin(bot, cfg)
    episodic.record({
      type: 'login',
      position: bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : undefined,
      realm: bot.entity?.dimension,
    })
    envProfile.save()
  })
  bot.once('spawn', async () => {
    if (spawnHandled) return
    spawnHandled = true
    clearTimeout(spawnTimeout)
    logger.info('Spawned into world')
    bootAttempts = 0 // connected — reset the offline counter
    setupMovement(bot)
    auth = auth || new AuthManager(bot, cfg)
    await auth.login()
    logger.info('[bot] ready')

    // Only run /spawn when already near world spawn — never teleport away
    // from a base/mine elsewhere. Check after a short delay so position
    // and spawnPoint are settled.
    setTimeout(() => {
      if (!bot || bot._client === null || bot.entity == null) return // torn down mid-timer
      const me = bot.entity?.position
      const spawn = bot.spawnPoint
      if (!me || !spawn) return
      const dist = me.distanceTo(spawn)
      if (dist <= (cfg.spawnRadius || 12)) {
        logger.info(`[spawn] near world spawn (${dist.toFixed(1)}m) → /spawn`)
        bot.chat('/spawn')
      } else {
        logger.info(`[spawn] ${dist.toFixed(1)}m from world spawn — skipping /spawn`)
      }
    }, 5000)
  })

  // 1.20.3+: servers push resource packs during the CONFIGURATION phase and
  // hold `finish_configuration` (no spawn) until the client replies. mineflayer
  // 4.37.1's resource_pack.js wraps data.uuid (already a string) in `new UUID()`
  // which serializes to 16 zero bytes → server never matches → silent stall
  // (PR #3842, still unmerged). Decline the pack here with the raw string.
  bot._client.on('add_resource_pack', (data) => {
    const uuid = data.uuid // already a string from nmp
    logger.info(`[resourcePack] declining ${data.url} (uuid ${uuid})`)
    bot._client.write('resource_pack_receive', { uuid, result: 1 }) // DECLINED
  })
  bot._client.on('resource_pack_send', (data) => {
    if (bot.supportFeature?.('resourcePackUsesUUID')) {
      const uuid = data.uuid
      logger.info(`[resourcePack] declining ${data.url} (uuid ${uuid})`)
      bot._client.write('resource_pack_receive', { uuid, result: 1 })
    } else {
      bot._client.write('resource_pack_receive', { hash: data.hash, result: 1 })
    }
  })

  bot.on('chat', (username, message) => {
    if (username !== bot.username) logger.chat(`${username}: ${message}`)
    handleInGameChat(username, message)
  })

  bot.on('kicked', (reason) => {
    logger.warn(`Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)
    // NOTE: do NOT schedule reconnect here — 'end' fires right after 'kicked'
    // and is the single reconnect trigger (prevents double-scheduling).
  })

  bot.on('death', () => {
    episodic.record({
      type: 'death',
      position: bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : undefined,
      realm: bot.entity?.dimension,
      detail: 'died',
    })
  })

  bot.on('error', (err) => logger.error(`Net error: ${err.message}`))
  bot.on('end', async (reason) => {
    logger.info(`Connection ended (${reason || 'unknown'})`)
    episodic.record({ type: 'logout' })
    await episodic.flush()
    envProfile.save()
    spawnHandled = false
    bot = null
    if (cfg.reconnect && !stopping) scheduleReconnect()
  })
}

/**
 * Aternos-specific reconnect: the TCP port is open even while the server
 * boots/restarts; handshakes just get ECONNRESET until it's actually up.
 * So each attempt does a real status ping first: if the ping succeeds the
 * server is joinable and we retry fast (10s); if it fails we treat it as
 * "server offline" and back off (5min) so we don't spam Aternos.
 */
function scheduleReconnect(overridesSec) {
  if (reconnectTimer || reconnecting) return
  const probe = () => {
    return new Promise((resolve) => {
      const mc = require('minecraft-protocol')
      try {
        mc.ping({ host: cfg.serverHost, port: cfg.serverPort, version: BOT_VERSION }, (err, res) => {
          if (!err) {
            resolve({ online: true, version: res?.version?.name, protocol: res?.version?.protocol })
          } else {
            resolve({ online: false, error: err.message })
          }
        })
      } catch (e) {
        resolve({ online: false, error: e.message })
      }
    })
  }

  reconnecting = true
  logger.info('[reconnect] probing server status…')
  probe().then((status) => {
    const delay = overridesSec != null ? overridesSec
      : status.online ? 10
      : cfg.reconnectOfflineSec || 300
    logger.info(`[reconnect] server ${status.online ? 'online' : 'offline'} (${status.error || status.version || ''}) → retry in ${delay}s`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnecting = false
      bootAttempts += 1
      start()
    }, delay * 1000)
  })
}

function stop() {
  stopping = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnecting = false
  if (bot) {
    stopMoving(bot)
    bot.end('shutdown')
    bot = null
  }
}

// ---- /bot chat command (in-game override of the AI queue) ----
// Example: '/bot digBlock 100 64 -200'

const commandHandlers = {}

function onCommand(name, handler) {
  commandHandlers[name] = handler
}

function handleInGameChat(username, message) {
  if (username === bot?.username) return
  if (cfg.ownerUsername && username !== cfg.ownerUsername) return
  const prefix = cfg.chatPrefix
  if (!message || !message.startsWith(prefix)) return
  const [, cmd, ...args] = message.split(/\s+/)
  if (!cmd) {
    bot?.chat(`Known commands: ${Object.keys(commandHandlers).join(', ')}`)
    return
  }
  const handler = commandHandlers[cmd]
  if (!handler) {
    bot?.chat(`Unknown command: ${cmd}`)
    return
  }
  try {
    handler(username, args)
  } catch (e) {
    logger.error(`Command ${cmd} failed: ${e.message}`)
  }
}

module.exports = { start, stop, getBotState, onCommand, handleInGameChat, get bot() { return bot } }