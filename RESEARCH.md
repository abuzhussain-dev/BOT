# BOT Context Builder Research

## Phase C: Context Builder for Autonomous Minecraft Bot

### 10 Concrete Rules for State Prompt Assembly

1. **ALWAYS include entity position** (`bot.entity.position`): O(1) access, provides the foundation for all spatial reasoning. Round to 1 decimal place.

2. **INCLUDE realm/dimension** (`bot.entity.dimension`): Critical for nether/end navigation. Use canonical values: `overworld`, `nether`, `end`.

3. **INCLUDE health and food** (`bot.health`, `bot.food`): Both O(1). Food saturation (`bot.foodSaturation`) is nice-to-have but add only if budget permits.

4. **INCLUDE timeOfDay** (`bot.time.timeOfDay`): O(1). Map to diurnal state: `daybreak` (0-2000), `day` (2000-16000), `sunset` (16000-18000), `night` (18000-20000).

5. **INVENTORY: top-16 by count** (`bot.inventory.items()`): Sort by count descending, take top 16 slots. Never iterate all 36 slots if only top N needed. Format: `{name: "iron_ore", count: 3}`.

6. **EQUIPMENT SLOT MAP** (`bot.entity.equipment`): O(1) access to 6 slots: hand, off-hand, head, torso, legs, feet. Map to `{hand: "iron_sword", off-hand: "shield", ...}`. Skip null slots.

7. **NEARBY BLOCKS: top-6 by distance** (`findBlocks` with `count: 2` per material): Pre-filter to essential ores+useful blocks: `coal_ore, iron_ore, copper_ore, gold_ore, diamond_ore, emerald_ore, redstone_ore, lapis_ore, oak_log, spruce_log, birch_log, chest, crafting_table, furnace, stone, dirt`. Maximum 6 entries.

8. **NEARBY ENTITIES: top-8** (`Object.values(bot.entities)`): Filter to exclude `bot.entity`. Classify as `mob` vs `player` vs `other`. Include distance and hostility status. Maximum 8 entries.

9. **TARGET BLOCK** (`bot.blockAtCursor(5)`): O(1) raycast. Include block name, hardness, and harvestability. If null, record as `null`.

10. **CONVERSATION HISTORY: last 3 turns only**: Use `bot.history.getHistory().slice(-6)` (3 user + 3 assistant). Truncate each message to first 50 characters if exceeding token budget. Never include full conversation.

### Priority Ranking When Over Budget

| Priority | State Slice | Cost Notes |
|----------|-----------|------------|
| **P0 (must include)** | entity position, realm, health, food, timeOfDay | All O(1), ~20 tokens |
| **P1 (include if budget > 40% remaining)** | inventory top-16, equipment map, target block | inventory O(36), equipment O(1), targetBlock O(1) raycast |
| **P2 (include if budget > 70% remaining)** | nearby blocks top-6, nearby entities top-8 | findBlocks is expensive O(chunk scan); entities O(entity map filter) |
| **P3 (exclude when budget constrained)** | full conversation history, blueprints, complex stats | Conversation: truncate to 3 turns; blueprints: only if construction task active |

### Exact Mineflayer Calls Recommended

```javascript
// O(1) state queries (safe to include freely)
const state = {
  position: {
    x: Math.round(bot.entity.position.x * 10) / 10,
    y: Math.round(bot.entity.position.y * 10) / 10,
    z: Math.round(bot.entity.position.z * 10) / 10
  },
  realm: DIM_REALM[bot.entity.dimension] || bot.entity.dimension,
  health: bot.health,
  food: bot.food,
  timeOfDay: bot.time.timeOfDay,
  dayCount: bot.time.day
};

// O(1) equipment (safe)
const equipment = {};
const slots = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'];
const eq = bot.entity?.equipment || [];
for (let i = 0; i < eq.length && i < slots.length; i++) {
  if (eq[i]) equipment[slots[i]] = eq[i].name;
}

// Inventory: top-16 by count (O(36) = cheap but bounded)
const inventoryCounts = {};
for (const item of bot.inventory?.items() || []) {
  const key = item.name.replace('minecraft:', '');
  inventoryCounts[key] = (inventoryCounts[key] || 0) + item.count;
}
const inventory = Object.entries(inventoryCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 16)
  .map(([name, count]) => ({ name, count }));

// Target block: O(1) raycast
const targetBlock = bot.blockAtCursor(5)
  ? { name: bot.blockAtCursor(5).name, hardness: bot.blockAtCursor(5).hardness, harvestable: true }
  : null;

// Nearby blocks: expensive, limit carefully
const nearbyBlocks = nearbyBlocks(bot, 24, 6); // from state.js

// Nearby entities: filter bot.entities map
const nearbyEntities = Object.values(bot.entities)
  .filter(e => e.position && e !== bot.entity)
  .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  .slice(0, 8)
  .map(e => ({
    kind: e.type === 'mob' ? 'mob' : e.type === 'player' ? 'player' : 'other',
    name: e.name,
    dist: Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10,
    hostile: HOSTILE_MOBS.has(e.name)
  }));
```

### Token Budget Guidelines

- **Full state prompt**: ~150-250 tokens (all P0 + P1 + P2)
- **Minimal prompt**: ~80 tokens (P0 only)
- **Token threshold**: If total prompt + user message exceeds 40% of model's context window, drop P2 first, then P3
- **Priority slicing order**: When exceeding budget, remove in this order: nearby entities → nearby blocks → inventory details → equipment slots → full conversation history

### Cost Model Summary

- **O(1) queries** (free): `bot.entity.position`, `bot.entity.dimension`, `bot.health`, `bot.food`, `bot.time.timeOfDay`, `bot.inventory.size()`, `bot.entity.equipment`, `bot.blockAtCursor()`
- **O(n) queries** (use with caps): `bot.findBlocks()` (cap at 6 materials × 2 count), `Object.values(bot.entities)` (cap at 8), `bot.inventory.items()` (cap at 16 items)
- **Avoid**: Unbounded `bot.inventory.items()` (36 slots), full `bot.history.getHistory()`, scanning all player lists without filters