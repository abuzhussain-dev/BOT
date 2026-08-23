const cfg = require('../config')
const { start, stop, getBotState, onCommand } = require('../bot')
const skillsApi = require('../skills')
const { plan } = require('./planner')
const { findNearestBlock } = require('../skills/foundation')
const { logger, sleep } = require('../utils/helpers')
const { observeAfterAction } = require('../perception/observe')
const { getTypedState } = require('../perception/state')
const episodic = require('../memory/episodic')
const envProfile = require('../memory/envProfile')

let running = false
let queue = [] // manual tasks injected via chat, each {task, args, reason}
let lastResult = ''
let lastCycle = null // latest {feedback, state} from the last action (auto-observe)
let lastTaskUsedOre = null

/**
 * Register in-game chat commands that let a human override the AI.
 *   /bot mine stone
 *   /bot goto 100 64 -200  (uses 'goto' skill)
 */
function wireChatCommands() {
  onCommand('mine', async (_user, args) => {
    enqueue({ task: 'mineType', args: { type: args.join(' ').trim() }, reason: 'manual' })
  })
  onCommand('goto', async (_user, args) => {
    const [x, y, z] = args.map(Number)
    if (![x, y, z].every(Number.isFinite)) { bot().chat?.('usage: goto x y z'); return }
    enqueue({ task: 'goto', args: { x, y, z }, reason: 'manual' })
  })
  onCommand('dig', async (_user, args) => {
    const [x, y, z] = args.map(Number)
    if (![x, y, z].every(Number.isFinite)) { bot().chat?.('usage: dig x y z'); return }
    enqueue({ task: 'digBlock', args: { x, y, z }, reason: 'manual' })
  })
  onCommand('eat', async () => enqueue({ task: 'eat', args: {}, reason: 'manual' }))
  onCommand('status', async () => {
    bot().chat?.(`HP ${bot().health} food ${bot().food} queue=${queue.length} last=${lastResult.slice(0, 60) || '—'}`)
  })
}

function bot() {
  return require('../bot').bot
}

function enqueue(task) {
  queue.push(task)
  logger.info(`[brain] queued manual task: ${task.task}`)
  episodic.record({ type: 'chat', action: task.task, result: 'manual queue', detail: task.reason })
}

/** Dynamic skill-vision: did blocks of type `name` exist nearby? */
const ctxProbe = {
  skillGot(name) {
    return !!findNearestBlock(bot(), name, 24)
  },
}

async function cycle() {
  if (running) return
  running = true
  try {
    const state = getBotState()
    if (!state) return

    // Phase C: planner gets lastFeedback (typed row from last cycle) as ground
    // truth for the previous action's result; getTypedState has no lastResult.
    const task = queue.length ? queue.shift() : await plan(state, {
      bot: bot(),
      logger,
      state,
      ...ctxProbe,
      lastFeedback: lastCycle?.feedback || null,
    })
    if (!task) {
      lastResult = '(idle)'
      return
    }
    const ctx = { bot: bot(), logger, state, lastFeedback: lastCycle?.feedback || null }
    // Phase A: auto-observe-after-action — run the skill, then capture the
    // typed feedback row + re-derived state in one shot.
    const { feedback, state: afterState } = await observeAfterAction(bot(), getTypedState, {
      skill: task.task,
      args: task.args,
      run: () => skillsApi.run(ctx, task.task, task.args),
    })
    lastCycle = { feedback, state: afterState }
    lastResult = feedback.ok
      ? `${task.task}: ${feedback.result || 'done'}${feedback.stagnation ? ' (no inv change)' : ''}`
      : `${task.task}: ERROR ${feedback.errorType}: ${feedback.result}`
    logger.info(`[brain] ${lastResult}`)

    episodic.record({
      type: 'action',
      action: feedback.skill,
      ok: feedback.ok,
      result: (feedback.result || feedback.errorType || '').slice(0, 200),
      position: state.position,
      realm: state.realm,
      health: state.health,
      food: state.food,
    })
    envProfile.observe(bot())
    envProfile.saveIfDirty()

    if (task.task === 'mineType') lastTaskUsedOre = task.args.type
  } catch (e) {
    logger.warn(`[brain] cycle error: ${e.message}`)
    lastResult = `error: ${e.message}`
  } finally {
    running = false
  }
}

async function run() {
  start()
  await sleep(3000) // give connection a moment before first probe
  wireChatCommands()
  logger.info('[brain] loop started')
  // poll until the bot is connected & authed, then start planning
  while (true) {
    if (bot()?.entity && bot()?.entity.position) {
      await cycle()
    }
    await sleep(cfg.planIntervalSec * 1000)
  }
}

function shutdown() {
  stop()
  logger.info('[brain] stopped')
  process.exit(0)
}

module.exports = { run, enqueue, get queue() { return queue }, get lastCycle() { return lastCycle } }