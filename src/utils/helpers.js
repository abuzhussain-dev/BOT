const logger = require('./logger')

function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

module.exports = { withTimeout, sleep, clamp, logger }