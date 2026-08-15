const cfg = require('./config')
const { logger } = require('./utils/helpers')
const brain = require('./agents/brain')

process.on('SIGINT', () => { logger.info('SIGINT received'); brain.quit?.() ?? process.exit(0) })
process.on('SIGTERM', () => { logger.info('SIGTERM received'); brain.quit?.() ?? process.exit(0) })
process.on('unhandledRejection', (err) => logger.error(`unhandled rejection: ${err?.message || err}`))

async function main() {
  logger.info(`== RUIN BOT starting ==`)
  logger.info(`server: ${cfg.serverHost}:${cfg.serverPort}  version: ${cfg.version}  bot: ${cfg.botUsername}`)
  logger.info(`LLM planner: ${cfg.llm.enabled ? `${cfg.llm.model} @ ${cfg.llm.baseURL}` : 'disabled (heuristic fallback active)'}`)
  await brain.run()
}

brain.quit = () => {
  const { stop } = require('./bot')
  stop()
  logger.info('shutdown complete')
  process.exit(0)
}

main().catch((e) => {
  logger.error(`fatal: ${e.stack || e.message}`)
  process.exit(1)
})