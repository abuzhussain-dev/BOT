process.on('uncaughtException', (e) => { require('fs').appendFileSync('/tmp/diag.log', 'UNCAUGHT: ' + e.stack + '\n'); process.exit(1) })
process.on('unhandledRejection', (e) => require('fs').appendFileSync('/tmp/diag.log', 'UNHANDLED: ' + (e && e.stack || e) + '\n'))
const fs = require('fs')
const log = (s) => fs.appendFileSync('/tmp/diag.log', s + '\n')
require('dotenv').config({ path: '/root/BOT/.env' })
const mineflayer = require('mineflayer')
const cfg = require('/root/BOT/src/config')
log('creating bot version=' + cfg.version + ' host=' + cfg.serverHost)
const bot = mineflayer.createBot({
  host: cfg.serverHost, port: cfg.serverPort,
  username: cfg.botUsername, auth: 'offline', version: '1.21.11',
  hideErrors: false, checkTimeoutInterval: 600000,
})
log('createBot returned, _client state=' + bot._client.state)
const seen = new Map()
bot._client.on('packet', (d, m) => {
  const k = m.name
  seen.set(k, (seen.get(k) || 0) + 1)
  log('S->C ' + k + ' (' + seen.get(k) + ')')
})
bot._client.on('packetSend', (d, m) => log('C->S ' + m.name))
bot._client.on('state', (s) => log('CLIENT STATE -> ' + s))
bot.on('connect', () => log('event connect'))
bot.on('login', () => log('event LOGIN'))
bot.on('spawn', () => { log('event SPAWN!'); process.exit(0) })
bot.on('error', (e) => log('event error: ' + e.message))
bot.on('end', (r) => { log('event end: ' + r); process.exit(0) })
setTimeout(() => { log('--- 60s timeout, map: ' + [...seen.keys()].join(',')); process.exit(1) }, 60000)
