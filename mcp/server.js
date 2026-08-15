const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')
const mcData = require('minecraft-data')
const fs = require('fs')
const path = require('path')

const DEFAULT_VERSION = '1.21.11'

const LITERAL_PCS = ('1.8 1.9 1.10 1.11 1.12 1.13 1.14 1.15 1.16 1.17 1.18 1.19 1.20 1.21 '
  + '1.21.9 1.21.11 1.21.20 1.21.50 1.21.60 1.21.70 1.21.80').split(' ')

function load(version) {
  let v = version || DEFAULT_VERSION
  try {
    return mcData(v)
  } catch {
    throw new Error(`minecraft-data has no data for "${v}". Latest PC versions: ${LITERAL_PCS.join(', ')}`)
  }
}

const server = new McpServer({
  name: 'minecrafter-data',
  version: '1.0.0',
})

server.registerTool(
  'list_versions',
  { title: 'List versions', description: 'List Minecraft versions the bot/library supports and can answer data questions for.' },
  () => ({ content: [{ type: 'text', text: LITERAL_PCS.join(', ') }] }),
)

server.registerTool(
  'search_blocks',
  {
    title: 'Search blocks',
    description: 'Search registered Minecraft block names by substring. Returns matching block names to use later with get_block.',
    inputSchema: { query: z.string(), version: z.string().optional() },
  },
  async ({ query, version }) => {
    const d = load(version)
    const names = Object.keys(d.blocksByName).filter((n) => n.includes(query.toLowerCase()))
    const top = names.slice(0, 40)
    const text = top.length ? `matches (${names.length}):\n${top.join('\n')}` : 'no matching blocks'
    return { content: [{ type: 'text', text }] }
  },
)

server.registerTool(
  'get_block',
  {
    title: 'Get block',
    description: 'Get full block metadata (name, id, hardness, diggable, drops, boundingBox) for a block id or name.',
    inputSchema: { block: z.union([z.string(), z.number()]), version: z.string().optional() },
  },
  async ({ block, version }) => {
    const d = load(version)
    const b = typeof block === 'number' ? d.blocks[block] : d.blocksByName[block]
    if (!b) return { content: [{ type: 'text', text: `no block "${block}" in ${d.version.minecraftVersion}` }] }
    return { content: [{ type: 'text', text: JSON.stringify(b, null, 2) }] }
  },
)

server.registerTool(
  'search_items',
  {
    title: 'Search items',
    description: 'Search registered Minecraft item names by substring. Returns matching item names for get_item.',
    inputSchema: { query: z.string(), version: z.string().optional() },
  },
  async ({ query, version }) => {
    const d = load(version)
    const names = Object.keys(d.itemsByName).filter((n) => n.includes(query.toLowerCase()))
    const top = names.slice(0, 40)
    const text = top.length ? `matches (${names.length}):\n${top.join('\n')}` : 'no matching items'
    return { content: [{ type: 'text', text }] }
  },
)

server.registerTool(
  'get_item',
  {
    title: 'Get item',
    description: 'Get item metadata (name, id, stackSize) plus foodPoints/saturation if it is food.',
    inputSchema: { item: z.union([z.string(), z.number()]), version: z.string().optional() },
  },
  async ({ item, version }) => {
    const d = load(version)
    const it = typeof item === 'number' ? d.items[item] : d.itemsByName[item]
    if (!it) return { content: [{ type: 'text', text: `no item "${item}" in ${d.version.minecraftVersion}` }] }
    return { content: [{ type: 'text', text: JSON.stringify(it, null, 2) }] }
  },
)

server.registerTool(
  'foods',
  {
    title: 'Foods',
    description: 'List all edible foods with foodPoints and saturation, best first. For knowing what to eat when hungry.',
    inputSchema: { version: z.string().optional() },
  },
  async ({ version }) => {
    const d = load(version)
    const foods = d.foodsArray.slice().sort((a, b) => b.saturation - a.saturation)
    const text = foods
      .map((f) => `- ${f.name}: ${f.foodPoints} food, ${f.saturation} saturation`)
      .join('\n')
    return { content: [{ type: 'text', text: text || 'no food data' }] }
  },
)

server.registerTool(
  'recipes_for',
  {
    title: 'Recipes for',
    description: 'List recipes that produce a given item name.',
    inputSchema: { item: z.string(), version: z.string().optional() },
  },
  async ({ item, version }) => {
    const d = load(version)
    const it = d.itemsByName[item]
    if (!it) return { content: [{ type: 'text', text: `no item "${item}"` }] }
    const recipes = d.recipes[it.id] || []
    const text = recipes.length
      ? recipes.map(JSON.stringify).join('\n')
      : `no recipes for ${item}`
    return { content: [{ type: 'text', text }] }
  },
)

server.registerTool(
  'wiki',
  {
    title: 'Wiki',
    description: 'Read official mineflayer docs/wiki (cached api.md). query = substring of the section you want, e.g. "bot.dig", "loadPlugin", "spawn".',
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    const file = path.join(__dirname, 'wiki', 'mineflayer-api.md')
    const all = fs.readFileSync(file, 'utf8')
    const lines = all.split('\n')
    const wanted = query.toLowerCase()
    const idx = lines.findIndex((l) => l.toLowerCase().includes(wanted))
    if (idx === -1) return { content: [{ type: 'text', text: `"${query}" not found in API docs` }] }
    const section = lines.slice(idx, idx + 60).join('\n')
    return { content: [{ type: 'text', text: section }] }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
main().catch((e) => {
  process.stderr.write(`MCP server error: ${e.stack}\n`)
  process.exit(1)
})