# Graph Report - .  (2026-08-13)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 165 nodes · 270 edges · 11 communities (9 shown, 2 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10

## God Nodes (most connected - your core abstractions)
1. `getTypedState()` - 10 edges
2. `AuthManager` - 8 edges
3. `withTimeout()` - 8 edges
4. `logger` - 8 edges
5. `setupMovement()` - 7 edges
6. `sleep()` - 7 edges
7. `start()` - 7 edges
8. `cycle()` - 7 edges
9. `goto()` - 6 edges
10. `stop()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `cycle()` --indirect_call--> `getTypedState()`  [INFERRED]
  src/agents/brain.js → src/perception/state.js
- `start()` --calls--> `setupMovement()`  [EXTRACTED]
  src/bot.js → src/motion.js
- `run()` --calls--> `sleep()`  [EXTRACTED]
  src/agents/brain.js → src/utils/helpers.js
- `complete()` --calls--> `withTimeout()`  [EXTRACTED]
  src/llm.js → src/utils/helpers.js
- `shutdown()` --calls--> `stop()`  [EXTRACTED]
  src/agents/brain.js → src/bot.js

## Import Cycles
- None detected.

## Communities (11 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.11
Nodes (24): { logger }, STATES, apply12111HitboxFix(), approachBlock(), goto(), pfModule, NOTE: clearing via setGoal(null) emits the goal as null (2nd arg = dynamic), REGISTRY (+16 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (27): dotenv, minecraft-data, mineflayer, mineflayer-pathfinder, @modelcontextprotocol/sdk, dependencies, dotenv, minecraft-data (+19 more)

### Community 2 - "Community 2"
Cohesion: 0.12
Nodes (19): shutdown(), { AuthManager }, bot(), cfg, commandHandlers, getBotState(), { getTypedState }, handleInGameChat() (+11 more)

### Community 3 - "Community 3"
Cohesion: 0.16
Nodes (16): bot(), cfg, ctxProbe, cycle(), enqueue(), { findNearestBlock }, { getTypedState }, { logger, sleep } (+8 more)

### Community 4 - "Community 4"
Cohesion: 0.18
Nodes (13): cfg, { complete, extractJson }, hasFood(), { logger }, plan(), planHeuristic(), planWithLLM(), skillsApi (+5 more)

### Community 5 - "Community 5"
Cohesion: 0.21
Nodes (15): { countInventory }, invSignature(), makeFeedback(), observeAfterAction(), countInventory(), DIM_REALM, dirFrom(), equipmentOf() (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.20
Nodes (9): fs, LITERAL_PCS, load(), mcData, { McpServer }, path, server, { StdioServerTransport } (+1 more)

### Community 8 - "Community 8"
Cohesion: 0.33
Nodes (6): fs, LOG_DIR, out, path, ts(), writeFile()

### Community 9 - "Community 9"
Cohesion: 0.50
Nodes (3): plugin, $schema, ./.opencode/plugins/graphify.js

## Knowledge Gaps
- **71 isolated node(s):** `queue`, `{ logger }`, `STATES`, `pfModule`, `REGISTRY` (+66 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `mineflayer` connect `Community 1` to `Community 2`?**
  _High betweenness centrality (0.241) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `getTypedState()` (e.g. with `cycle()` and `state.js`) actually correct?**
  _`getTypedState()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `queue`, `{ logger }`, `STATES` to the rest of the system?**
  _71 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.11397849462365592 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.12121212121212122 - nodes in this community are weakly interconnected._