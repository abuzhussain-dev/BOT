// Zero-edit stand-alone recorder: spawns its OWN mineflayer bot using the
// bot's .env config and records the server session to recorder/recordings/.
// Run:  node recorder/record-standalone.js
// Stop with Ctrl-C; it writes <base>.cap + <base>.meta.json.
// Convert to ReplayMod: node recorder/export-mcpr.js recordings/<base>.cap

const { recordStandalone } = require('./recorder')

const { rec } = recordStandalone({ base: `ruin_${Date.now()}` })
const shutdown = () => { const m = rec.stop(); console.log('[recorder] stopped', m); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
