const { logger } = require('./utils/helpers')

const STATES = {
  PENDING: 'pending',
  REGISTERED: 'registered',
  LOGGED_IN: 'logged_in',
  FAILED: 'failed',
}

/**
 * Handles Aternos /register + /login authentication.
 *
 * Flow: after spawn we send /login password. If the server answers
 * with "Please register" (or the account does not exist yet) we first
 * send /register password password, then /login.
 */
class AuthManager {
  constructor(bot, cfg) {
    this.bot = bot
    this.cfg = cfg
    this.state = STATES.PENDING
    this._loginAttempts = 0
    this._hook()
  }

  _hook() {
    this.bot.on('message', (json) => {
      const text = json?.toString?.() ?? ''
      const lower = text.toLowerCase()

      logger.debug(`[auth] server message: ${lower}`)

      // LoginSecurity kicks after 5 login/register attempts — stop sending at 4.
      if (this._loginAttempts >= 4) return

      // "you are not registered or already logged in!" is LoginSecurity's
      // not-logged-in nag — NOT a register prompt. Retry login (throttled).
      if (/you are not registered or already logged in/.test(lower)) {
        if (this._loginAttempts < 4) {
          this.say(`/login ${this.cfg.botPassword}`)
          this._loginAttempts += 1
        }
        return
      }

      if (/please register|you need to register|account not registered|register first/.test(lower)) {
        this.state = STATES.REGISTERED // not yet, but we register below
        this.say(`/register ${this.cfg.botPassword} ${this.cfg.botPassword}`)
        this._loginAttempts += 1
        return
      }

      // Account already exists — just log in.
      if (/already registered under this account/.test(lower)) {
        this.say(`/login ${this.cfg.botPassword}`)
        this._loginAttempts += 1
        return
      }

      // LoginSecurity confirms with "ready. | ready. | ready."
      // Note: server repeats "ready." every second as a countdown — harmless,
      // state is already LOGGED_IN; only the transition is logged.
      if (/you are now logged|successfully logged|logged in as|welcome|\bready\./.test(lower)) {
        const was = this.state
        this.state = STATES.LOGGED_IN
        if (was !== STATES.LOGGED_IN) logger.info('[auth] logged in')
        return
      }

      if (/wrong password|incorrect password|invalid password|invalid credentials/.test(lower)) {
        this.state = STATES.FAILED
        logger.error('[auth] password rejected by server')
      }
    })
  }

  say(text) {
    try {
      this.bot.chat(text)
      logger.info(`[auth] >> ${text.split(' ')[0]} ****`)
    } catch (e) {
      logger.warn(`[auth] failed to send: ${e.message}`)
    }
  }

  /** Call right after the bot spawns. Returns true when login completed. */
  async waitForSpawnAndLogin(timeoutMs = 120000) {
    const t0 = Date.now()
    while (this.state !== STATES.LOGGED_IN) {
      if (this.state === STATES.FAILED) return false
      if (Date.now() - t0 > timeoutMs) {
        logger.warn('[auth] login took too long, continuing anyway')
        return false
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return true
  }

  /** Public: trigger login now (after spawn). */
  async login() {
    if (!this.cfg.botPassword) {
      logger.warn('[auth] no BOT_PASSWORD set; assuming server needs no login')
      this.state = STATES.LOGGED_IN
      return true
    }
    if (this._loginAttempts < 1) {
      this.say(`/login ${this.cfg.botPassword}`)
      this._loginAttempts += 1
    }
    return this.waitForSpawnAndLogin()
  }

  get done() {
    return this.state === STATES.LOGGED_IN
  }
}

module.exports = { AuthManager, STATES }