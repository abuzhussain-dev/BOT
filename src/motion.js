const pfModule = require('mineflayer-pathfinder')
const pathfinder = pfModule.pathfinder
const { Movements, goals } = pfModule
const { withTimeout, sleep, logger } = require('./utils/helpers')

const REGISTRY = Symbol('movement')

/**
 * Wraps mineflayer-pathfinder. Load once per bot.
 */
function apply12111HitboxFix(bot) {
  // mineflayer issue #3911 / pathfinder PR #364: on native 1.21.11 servers
  // bots get stuck in the air when jumping/stepping up because the client
  // hitbox half-width (0.3) aligns exactly with block boundaries. Bumping it
  // by a hair fixes jumping, climbing and water egress (verified workaround,
  // no OP needed).
  if (bot.physics) {
    bot.physics.playerHalfWidth = 0.302
    bot.physics.playerHeight = 1.80002
  }
}

function setupMovement(bot) {
  if (bot[REGISTRY]) return bot[REGISTRY]
  // ponytail: no registry yet (pre-login / after disconnect) — can't build
  // Movements safely; return a stub so stop() never crashes. Movements get
  // (re)built on the next spawn-driven call.
  if (!bot.registry) return { movements: null, moving: false, stop: () => {} }
  apply12111HitboxFix(bot)
  bot.loadPlugin(pathfinder)
  const movements = new Movements(bot)
  // 1.21.11 fix companion: avoid Creepers by default (safety + pathing sanity)
  const creeper = bot.registry?.entitiesByName?.creeper
  if (creeper && movements.canDig !== undefined) movements.entitiesToAvoid.add(creeper.name)
  bot.pathfinder.setMovements(movements)
  const api = { movements, moving: false, stop: () => bot.pathfinder.setGoal(null) }
  bot.on('goal_updated', (goal, dynamic) => {
    // NOTE: clearing via setGoal(null) emits the goal as null (2nd arg = dynamic)
    api.moving = !!goal
  })
  bot[REGISTRY] = api
  return api
}

async function goto(bot, x, y, z, distance = 1, timeoutMs = 45000, label = 'goto') {
  const mv = setupMovement(bot)
  mv.stop()
  await sleep(50)
  const goal = new goals.GoalNear(x, y, z, distance)
  await withTimeout(bot.pathfinder.goto(goal), timeoutMs, label)
}

/**
 * Move to a spot that is reachable, adjacent to (and level with) `pos`,
 * then face it — used before digging.
 */
async function approachBlock(bot, pos, timeoutMs = 45000) {
  const mv = setupMovement(bot)
  mv.stop()
  await sleep(50)

  const candidates = []
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], // around
    [0, 1, 0], [0, -1, 0],                          // above / below
  ]
  for (const [dx, dy, dz] of dirs) {
    const spot = pos.offset(dx, dy, dz)
    const b = bot.blockAt(spot)
    if (b && b.boundingBox === 'empty') {
      candidates.push(spot)
    }
  }

  const me = bot.entity.position
  candidates.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))

  let chosen = null
  for (const c of candidates.slice(0, 3)) {
    chosen = c
    break
  }
  if (!chosen) {
    // Fallback: just jump near the block
    chosen = pos
  }

  await goto(bot, chosen.x, chosen.y, chosen.z, 1, timeoutMs, 'approachBlock')
  await bot.lookAt(pos)
}

/** Cancel movement and clear any in-flight path. */
function stopMoving(bot) {
  const mv = setupMovement(bot)
  mv.stop()
}

module.exports = { setupMovement, goto, approachBlock, stopMoving, goals }