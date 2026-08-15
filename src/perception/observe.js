/**
 * Phase A — observe-after-action + typed-feedback contract.
 * Every skill run produces a feedback row (RESEARCH.md §9 #2):
 *   { skill, ok, errorType?, stateDelta, invDelta, progress, stagnation, durationMs }
 * Inventory deltas are the highest-value signal — a skill that didn't change
 * inventory likely didn't work.
 */

const { countInventory } = require('./state')

/** Hash the inventory into a compact signature for change detection. */
function invSignature(bot) {
  return countInventory(bot).map(({ name, count }) => `${name}:${count}`).join('|')
}

/**
 * Build the typed feedback for one action.
 * @param {object} before previous inventory signature string
 * @param {object} bot mineflayer bot (post-action)
 * @param {object} action { skill, args, ok, errorType, result }
 */
function makeFeedback(beforeSig, bot, action) {
  const afterSig = invSignature(bot)
  const invDelta = afterSig !== beforeSig
  return {
    skill: action.skill,
    args: action.args,
    ok: action.ok,               // complete without error
    errorType: action.errorType || null,
    invDelta,                    // boolean: inventory changed
    invBefore: beforeSig,
    invAfter: afterSig,
    progress: action.progress ?? (action.ok ? 1 : 0),
    stagnation: !!action.ok && !invDelta, // returned ok but nothing changed
    durationMs: action.durationMs || null,
    result: (action.result || '').slice(0, 200),
  }
}

/**
 * observeAfterAction: run an action, then return the freshly-derived typed
 * state PLUS its feedback, so the caller never needs a separate observation
 * turn (auto-observe, RESEARCH.md §9 #6).
 */
async function observeAfterAction(bot, stateFn, action) {
  const beforeSig = invSignature(bot)
  const t0 = Date.now()
  let ok = false
  let errorType = null
  let result = ''
  let progress = 0
  try {
    result = await action.run()
    ok = true
    progress = 1
  } catch (e) {
    errorType = e.name || 'Error'
    result = e.message || String(e)
  }
  const feedback = makeFeedback(beforeSig, bot, {
    skill: action.skill,
    args: action.args,
    ok,
    errorType,
    result,
    progress,
    durationMs: Date.now() - t0,
  })
  return { feedback, state: stateFn(bot) }
}

module.exports = { makeFeedback, observeAfterAction, invSignature }