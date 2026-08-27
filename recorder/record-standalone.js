// Stand-alone recorder: spawns its OWN mineflayer bot using the bot's .env
// config and records the server session to recorder/recordings/*.mcpr
// (ReplayMod format, auto-split every 5 min). Runs completely separate from BOT.
// Run:  node recorder/record-standalone.js   (or: npm run record)
// Optional env: RECORDER_USERNAME (distinct from BOT to avoid clash),
//               RECORD_SPLIT_MS (chunk length, default 300000).
// Stop with Ctrl-C; the current chunk is flushed to a final .mcpr.

const { recordStandalone } = require('./recorder')

const { rec } = recordStandalone({ base: `ruin_${Date.now()}` })
const shutdown = () => { const m = rec.stop(); console.log('[recorder] stopped', m); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
