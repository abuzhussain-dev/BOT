// Version-agnostic Mineflayer -> ReplayMod (.mcpr) recorder.
//
// Captures the raw clientbound PLAY packets the bot receives and writes them in
// ReplayMod's native format (verified against ReplayMod PacketListener.java):
//   recording.tmcpr = repeat[ int32 absTimestampMs, int32 length, (varint id + body) ]
// The `packet` event's `fullBuffer` is already (varint packet id + body) and is
// decompressed, which is exactly what ReplayMod stores. Timestamps are absolute
// milliseconds since recording start (NOT deltas).
//
// No hardcoded packet names, no version-specific serialization, no extra deps.
// This module never edits your bot; see attach-example.js / record-standalone.js.

const fs = require('fs')
const path = require('path')

const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Minimal STORE (no compression) ZIP writer -> valid .mcpr for ReplayMod.
function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // method 0 = store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(f.data.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    chunks.push(local, f.data)
    const c = Buffer.alloc(46 + name.length)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0, 8)
    c.writeUInt16LE(0, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(0, 14)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(f.data.length, 20)
    c.writeUInt32LE(f.data.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(0, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE(0, 38)
    c.writeUInt32LE(offset, 42)
    name.copy(c, 46)
    central.push(c)
    offset += local.length + f.data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

// Minimal STORE ZIP reader (test/verification only).
function unzipStore(buf) {
  const out = {}
  let p = 0
  while (p + 4 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0x04034b50) break
    const method = buf.readUInt16LE(p + 8)
    const crc = buf.readUInt32LE(p + 14)
    const size = buf.readUInt32LE(p + 18)
    const nlen = buf.readUInt16LE(p + 26)
    const elen = buf.readUInt16LE(p + 28)
    const name = buf.slice(p + 30, p + 30 + nlen).toString('utf8')
    const dataStart = p + 30 + nlen + elen
    const data = buf.slice(dataStart, dataStart + size)
    if (method === 0) out[name] = { data, crc }
    p = dataStart + size
  }
  return out
}

function buildMetadata(startTime, lastTs, info, bot) {
  const mcversion = String(bot.version || bot._client?.version || 'unknown')
  const protocol = bot._client?.protocolVersion || 0
  return {
    singleplayer: false,
    serverName: 'ruin-bot',
    duration: lastTs,
    date: startTime,
    mcversion,
    fileFormat: 'MCPR',
    fileFormatVersion: 14,
    protocol,
    generator: 'mineflayer-recorder (ruin-bot)',
    selfId: info.selfId ?? -1,
    players: info.players,
  }
}

// Recover orphaned chunks left by a crash/hard-kill. A live chunk is written to
// `<base>_partNNN.recording.tmcpr` (+ sidecar `.recording.meta.json`); on a
// clean finalize those are deleted. If the process died before finalizing, they
// linger on disk — this converts them into proper `.mcpr` files so nothing is
// lost. Must run BEFORE any new live chunk is opened.
function recoverOrphans(dir) {
  if (!fs.existsSync(dir)) return []
  const recovered = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.recording.tmcpr')) continue
    const full = path.join(dir, f)
    const tmcpr = fs.readFileSync(full)
    // compute true duration = max timestamp in the chunk
    let p = 0, maxTs = 0
    while (p + 8 <= tmcpr.length) {
      const ts = tmcpr.readInt32BE(p)
      const len = tmcpr.readInt32BE(p + 4)
      if (ts > maxTs) maxTs = ts
      p += 8 + len
    }
    const metaPath = full.replace(/\.recording\.tmcpr$/, '.recording.meta.json')
    let metadata = { selfId: -1, players: {} }
    if (fs.existsSync(metaPath)) {
      try { metadata = { ...metadata, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) } } catch { /* ignore */ }
    }
    metadata.duration = maxTs
    metadata.singleplayer = false
    metadata.fileFormat = 'MCPR'
    metadata.fileFormatVersion = 14
    metadata.serverName = 'ruin-bot'
    metadata.generator = 'mineflayer-recorder (ruin-bot)'
    const outPath = full.replace(/\.recording\.tmcpr$/, '.mcpr')
    if (fs.existsSync(outPath)) { fs.unlinkSync(full); fs.unlinkSync(metaPath); continue }
    const zip = zipStore([
      { name: 'metaData.json', data: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8') },
      { name: 'recording.tmcpr', data: tmcpr },
      { name: 'mods.json', data: Buffer.from(JSON.stringify({ requiredMods: [] }), 'utf8') },
    ])
    fs.writeFileSync(outPath, zip)
    fs.unlinkSync(full)
    fs.unlinkSync(metaPath)
    recovered.push(outPath)
  }
  return recovered
}

function attachRecorder(bot, opts = {}) {
  const dir = opts.dir || path.join(__dirname, 'recordings')
  fs.mkdirSync(dir, { recursive: true })
  const base = opts.base || `rec_${Date.now()}`
  const autoSaveMs = opts.autoSaveMs || 0 // 0 = only on stop (single file)

  // Recover anything a previous (crashed) run left behind.
  const rec = recoverOrphans(dir)
  if (rec.length) console.log(`[recorder] recovered ${rec.length} orphaned chunk(s):`, rec.map((p) => path.basename(p)))

  let fd = null
  let tmcprPath = null
  let metaPath = null
  let startTime = 0
  let lastTs = 0
  let count = 0
  let chunkIndex = 0
  let lastOutPath = null
  let stopping = false
  const info = { selfId: null, players: {} }

  function writeSidecar() {
    if (!metaPath) return
    const meta = buildMetadata(startTime, lastTs, info, bot)
    try { fs.writeFileSync(metaPath, JSON.stringify(meta)) } catch { /* ignore */ }
  }

  function openChunk() {
    const suffix = `_part${String(chunkIndex).padStart(3, '0')}`
    tmcprPath = path.join(dir, `${base}${suffix}.recording.tmcpr`)
    metaPath = path.join(dir, `${base}${suffix}.recording.meta.json`)
    fd = fs.openSync(tmcprPath, 'w')
    startTime = Date.now()
    lastTs = 0
    count = 0
    writeSidecar()
  }
  openChunk()

  const onPacket = (data, meta, buff, fullBuffer) => {
    if (meta.state !== 'play') return
    if (!fullBuffer || !fullBuffer.length) return
    const ts = Date.now() - startTime
    if (ts > lastTs) lastTs = ts
    const entry = Buffer.alloc(8 + fullBuffer.length)
    entry.writeInt32BE(ts, 0)
    entry.writeInt32BE(fullBuffer.length, 4)
    fullBuffer.copy(entry, 8)
    fs.writeSync(fd, entry)
    count++
  }
  bot._client.on('packet', onPacket)

  const onSpawn = () => {
    info.selfId = bot.entity?.id ?? info.selfId
    if (bot.entity?.uuid) info.players[bot.entity.uuid] = { name: bot.username, uuid: bot.entity.uuid }
    writeSidecar()
  }
  if (bot.entity) onSpawn()
  else bot.once('spawn', onSpawn)

  // Finalize the current chunk into its own .mcpr. Returns null if empty.
  function writeChunk() {
    if (fd === null) return null
    if (count === 0) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
      try { fs.unlinkSync(tmcprPath) } catch { /* ignore */ }
      try { fs.unlinkSync(metaPath) } catch { /* ignore */ }
      fd = null
      return null
    }
    fs.fsyncSync(fd) // durable: push packet bytes to disk before we build the .mcpr
    try { fs.closeSync(fd) } catch { /* ignore */ }
    fd = null
    const outPath = path.join(dir, `${base}_part${String(chunkIndex).padStart(3, '0')}.mcpr`)
    const metadata = buildMetadata(startTime, lastTs, info, bot)
    const mods = { requiredMods: [] }
    const tmcpr = fs.readFileSync(tmcprPath)
    const zip = zipStore([
      { name: 'metaData.json', data: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8') },
      { name: 'recording.tmcpr', data: tmcpr },
      { name: 'mods.json', data: Buffer.from(JSON.stringify(mods), 'utf8') },
    ])
    fs.writeFileSync(outPath, zip)
    fs.unlinkSync(tmcprPath)
    fs.unlinkSync(metaPath)
    lastOutPath = outPath
    return { outPath, packets: count, durationMs: lastTs, meta: metadata }
  }

  // Save current chunk and start a fresh one.
  function flush() {
    const m = writeChunk()
    chunkIndex++
    openChunk()
    return m
  }

  let timer = null
  if (autoSaveMs > 0) timer = setInterval(() => {
    const m = flush()
    if (m) console.log(`[recorder] auto-saved chunk ${path.basename(m.outPath)} (${m.packets} packets, ${m.durationMs}ms)`)
  }, autoSaveMs)

  function stop() {
    if (stopping) return { outPath: lastOutPath, packets: 0, durationMs: 0 }
    stopping = true
    if (timer) clearInterval(timer)
    try { bot._client.removeListener('packet', onPacket) } catch { /* ignore */ }
    try { bot.removeListener('spawn', onSpawn) } catch { /* ignore */ }
    const m = writeChunk() // final partial chunk (may be null if empty)
    return m ? { outPath: lastOutPath, packets: m.packets, durationMs: m.durationMs, meta: m.meta } : { outPath: null, packets: 0, durationMs: 0 }
  }

  // Flush on clean process shutdown (bonto Stop sends SIGTERM; OOM-mgr SIGTERM).
  const onSig = () => { stop(); process.exit(0) }
  process.once('SIGTERM', onSig)
  process.once('SIGINT', onSig)

  return { stop, flush, getOutPath: () => lastOutPath, info }
}

// Independent recording bot from the same .env (no edits to your main bot).
function recordStandalone(opts = {}) {
  const cfg = require(path.join(__dirname, '..', 'src', 'config'))
  const mineflayer = require('mineflayer')
  const BOT_VERSION = cfg.version || '1.21.11'
  const bot = mineflayer.createBot({
    host: cfg.serverHost, port: cfg.serverPort,
    username: cfg.botUsername, auth: cfg.authMode,
    version: BOT_VERSION, hideErrors: false,
  })
  // Default: auto-save a new .mcpr every 5 minutes (override via RECORD_SPLIT_MS).
  const autoSaveMs = Number(process.env.RECORD_SPLIT_MS) || opts.autoSaveMs || 5 * 60 * 1000
  const rec = attachRecorder(bot, { ...opts, autoSaveMs })
  bot.once('spawn', () => console.log('[recorder] spawned, recording ->', rec.getOutPath()))
  bot.on('end', () => { const m = rec.stop(); console.log('[recorder] stopped', m) })
  return { bot, rec }
}

// Self-test: feed fake PLAY packets through the recorder and verify the .mcpr,
// including a chunk flush mid-stream.
function selfTest() {
  const EventEmitter = require('events')
  const bot = new EventEmitter()
  bot.username = 'selftest'
  bot.version = '1.21.11'
  bot._client = new EventEmitter()
  bot._client.protocolVersion = 767
  bot._client.version = '1.21.11'
  bot.entity = { id: 42, uuid: '11111111-1111-1111-1111-111111111111' }

  const rec = attachRecorder(bot, { base: `_selftest_${Date.now()}`, dir: '/tmp', autoSaveMs: 0 })
  const fb = (id, ...body) => Buffer.from([id, ...body])
  bot._client.emit('packet', {}, { state: 'play', name: 'keep_alive' }, Buffer.alloc(0), fb(0x01, 0xaa))
  bot._client.emit('packet', {}, { state: 'login', name: 'compress' }, Buffer.alloc(0), fb(0x02)) // skipped
  bot._client.emit('packet', {}, { state: 'play', name: 'chat' }, Buffer.alloc(0), fb(0x03, 0xbb, 0xcc))
  // simulate a 5-min chunk boundary
  const chunk1 = rec.flush()
  bot._client.emit('packet', {}, { state: 'play', name: 'chat' }, Buffer.alloc(0), fb(0x04, 0xdd))
  const m = rec.stop()

  const verify = (outPath, expectEntries) => {
    const zip = unzipStore(fs.readFileSync(outPath))
    const tbuf = zip['recording.tmcpr'].data
    let p = 0, entries = 0, prev = -1, mono = true
    while (p < tbuf.length) {
      const ts = tbuf.readInt32BE(p); const len = tbuf.readInt32BE(p + 4); p += 8
      if (ts < prev) mono = false
      prev = ts; p += len; entries++
    }
    const meta = JSON.parse(zip['metaData.json'].data.toString())
    return zip['metaData.json'] && zip['mods.json'] && mono && entries === expectEntries && meta.selfId === 42 && meta.protocol === 767
  }
  const pass = verify(chunk1.outPath, 2) && verify(m.outPath, 1)
  console.log(`[selfTest] ${pass ? 'PASS' : 'FAIL'} -> chunk1=${chunk1.outPath} final=${m.outPath}`)
  fs.unlinkSync(chunk1.outPath); fs.unlinkSync(m.outPath)
  if (!pass) process.exit(1)
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selfTest()
  else {
    const { rec } = recordStandalone()
    const shutdown = () => { const m = rec.stop(); console.log('[recorder] stopped', m); process.exit(0) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
}

module.exports = { attachRecorder, recordStandalone, selfTest, zipStore, unzipStore }
