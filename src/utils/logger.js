const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function writeFile(level, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(LOG_DIR, `${day}.log`), `${ts()} [${level}] ${msg}\n`)
  } catch {
    // never let logging crash the bot
  }
}

const out = {
  debug: (msg) => { writeFile('DEBUG', msg) },
  info: (msg) => { console.log(`[${ts()}] ${msg}`); writeFile('INFO', msg) },
  warn: (msg) => { console.warn(`[${ts()}] WARN ${msg}`); writeFile('WARN', msg) },
  error: (msg) => { console.error(`[${ts()}] ERROR ${msg}`); writeFile('ERROR', msg) },
  chat: (msg) => { console.log(`[${ts()}] [CHAT] ${msg}`); writeFile('CHAT', msg) },
}

module.exports = out