// Attach the recorder to the LIVE ruin-bot process.
//
// This file does NOT edit your bot. It requires the existing bot module and
// attaches once `bot._client` exists. Run it as a separate process ONLY if the
// bot exports a reachable live `bot` — in this codebase the bot is created inside
// bot.js and not exposed across processes, so the reliable way is to paste ONE
// line into src/bot.js right after `bot = mineflayer.createBot({...})`:
//
//     require('./recorder/recorder').attachRecorder(bot)
//
// For a zero-edit quick capture, use record-standalone.js instead (spawns its
// own bot using the same .env and records the server session).

const path = require('path')
const botMod = require(path.join(__dirname, '..', 'src', 'bot'))
const { attachRecorder } = require('./recorder')

const iv = setInterval(() => {
  const bot = botMod.bot
  if (!bot || !bot._client) return
  clearInterval(iv)
  const rec = attachRecorder(bot, { base: `ruin_${Date.now()}` })
  console.log('[recorder] attached ->', rec.capPath)
  const shutdown = () => { const m = rec.stop(); console.log('[recorder] stopped', m); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}, 1000)
