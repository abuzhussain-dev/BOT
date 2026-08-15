require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const num = (v, d) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : d
}

const cfg = {
  botUsername: process.env.BOT_USERNAME || 'BOTC',
  botPassword: process.env.BOT_PASSWORD || '',
  serverHost: process.env.SERVER_HOST || 'localhost',
  serverPort: parseInt(process.env.SERVER_PORT, 10) || 25565,
  version: (process.env.MINECRAFT_VERSION || '').trim() || false, // false = auto-detect (ViaVersion/backwards)
  authMode: process.env.AUTH_MODE || 'offline',

  reconnect: (process.env.RECONNECT || 'true') !== 'false',
  reconnectDelaySec: num(process.env.RECONNECT_DELAY_SEC, 15),
  // Aternos: retry fast (10s) while server online per probe, back off to this
  // when it's offline/booting so we don't hammer the panel.
  reconnectOfflineSec: num(process.env.RECONNECT_OFFLINE_SEC, 300),

  chatPrefix: process.env.CHAT_PREFIX || '/bot',
  ownerUsername: process.env.OWNER_USERNAME || 'MUHAMMAD_OWAIS',
  spawnRadius: num(process.env.SPAWN_RADIUS, 12),

  llm: {
    enabled: !!process.env.LLM_BASE_URL,
    baseURL: process.env.LLM_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-v4-flash-free',
    cheapestModel: process.env.LLM_CHEAP_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash-free',
    temperature: num(process.env.LLM_TEMPERATURE, 0.2),
    timeoutSec: num(process.env.LLM_TIMEOUT_SEC, 60),
  },

  planIntervalSec: num(process.env.PLAN_INTERVAL_SEC, 8),
  safeHealth: num(process.env.SAFE_HEALTH, 16),
  foodThreshold: num(process.env.FOOD_THRESHOLD, 12),
}

module.exports = cfg