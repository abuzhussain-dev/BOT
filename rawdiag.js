const mc = require('minecraft-protocol')
console.log('nmp version:', require('minecraft-protocol/package.json').version)
// 1.21.11 protocol number
const mcData = require('minecraft-data')('1.21.11')
console.log('1.21.11 protocol:', mcData.version?.version, 'versionId', mcData.version?.versionId)

const client = mc.createClient({
  host: 'RUIN_SMPS1.aternos.me', port: 56892,
  username: 'BOTC', auth: 'offline', version: '1.21.11',
})

const seen = []
client.on('packet', (data, meta) => { seen.push(meta.name); console.log('S->C', meta.name, JSON.stringify(data).slice(0, 200)) })
client.on('packet_send', (data, meta) => console.log('C->S', meta.name, JSON.stringify(data).slice(0, 120)))
client.on('error', (e) => console.log('ERR', e.message))
client.on('end', (r) => { console.log('END', r); process.exit(0) })
client.on('login', (p) => console.log('LOGIN packet:', JSON.stringify(p).slice(0, 300)))

setTimeout(() => { console.log('--- 90s, packets seen:', seen.join(',')); process.exit(1) }, 90000)
