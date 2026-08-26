#!/usr/bin/env node
/**
 * botctl - CLI controller for the live BOTC instance.
 * Talks to the in-bot control server over a Unix socket.
 *
 * Usage:
 *   botctl status
 *   botctl pos
 *   botctl chat hello world
 *   botctl skills
 *   botctl run goto x=10 y=11 z=10
 *   botctl run mineType type=iron_ore
 *   botctl enqueue '{"action":"goto","args":{"x":0,"y":52,"z":20}}'
 *   botctl stop
 */
const net = require('net')
const SOCK = process.env.BOTCTL_SOCK || '/tmp/botc.sock'

const cmd = process.argv[2]
if (!cmd) {
  console.log('usage: botctl <status|pos|chat|skills|run|enqueue|stop> [args...]')
  console.log('  botctl status')
  console.log('  botctl chat hi everyone')
  console.log('  botctl run mineType type=iron_ore')
  console.log('  botctl run goto x=10 y=11 z=10')
  process.exit(1)
}

// join remaining args; everything after `chat` is free text, after `run` it is skill + args
let payload = cmd
if (cmd === 'chat' || cmd === 'say') payload += ' ' + process.argv.slice(3).join(' ')
else if (process.argv.slice(3).length) payload += ' ' + process.argv.slice(3).join(' ')

const c = net.connect(SOCK)
let buf = ''
const timer = setTimeout(() => {
  console.error(`timeout: is the bot running? (socket ${SOCK})`)
  process.exit(2)
}, 120000)

c.on('connect', () => c.write(payload + '\n'))
c.on('data', (d) => {
  buf += d.toString()
  if (buf.endsWith('\n')) {
    clearTimeout(timer)
    const out = JSON.parse(buf)
    if (out.error) { console.error('ERROR:', out.error); process.exit(1) }
    if (cmd === 'status' || cmd === 'pos') console.log(JSON.stringify(out, null, 2))
    else if (out.result !== undefined) console.log(JSON.stringify(out.result, null, 2))
    else console.log(JSON.stringify(out, null, 2))
    c.end()
    process.exit(0)
  }
})
c.on('error', (e) => {
  clearTimeout(timer)
  console.error(`cannot reach bot: ${e.message} (is it running? socket ${SOCK})`)
  process.exit(2)
})
