/**
 * 账号池运行时：凭据读写、选号、健康度（冷却）、积分与签到。
 *
 * ## token 存在哪
 *
 * `ctx.credentials` 存在时走它（ref = `TELEAGENT_TOKEN_<ACCID>`）；服务缺失时降级为
 * `pool.json` 内联，并把 `tokenStorage` 标成 `inline`，让 UI 如实说明而不是假装安全。
 *
 * ## 选号策略
 *
 * - `balance-desc`（默认）：余额多的优先 —— 积分用光就会 402，先把有额度的排前面。
 * - `round-robin`：按加入顺序轮换，适合想平均分散调用、避免单号被限流的人。
 *
 * 两种策略都**跳过冷却中的账号**（连续失败 N 次后歇 10 分钟），
 * 但**全部都在冷却时照样按顺序试** —— 宁可尝试，也不要凭空拒绝用户。
 *
 * @module dsh-teleagent-pool/src/pool
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { credentialRef } from './refs.js'
import {
  USER_INFO_PATH,
  REQUEST_TIMEOUT_MS,
  BILLING_UTC_OFFSET_MS,
  AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
} from './product.js'
import {
  absoluteUrl,
  businessHeaders,
  credentialExpiresAtMs,
  displayNickname,
  parseUserInfo,
} from './protocol.js'
import { fetchWithTimeout, readJson } from './http.js'
import { claimDaily, fetchBalance, fetchCheckinPanel } from './credits.js'
import { PoolStore, newAccountId, tokenRef } from './store.js'

/** 连续失败达到阈值后的冷却时长。 */
const COOL_DOWN_MS = 10 * 60_000

/**
 * UTC+8 自然日键（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术偏移 + `getUTC*`**：`getFullYear()` / `toLocaleDateString()`
 * 按本机时区算，在非 UTC+8 的机器上会算出错的日界（偏东则闸门过早失效→重复签到，
 * 偏西则该签的时候不签）。
 */
export function utc8DayKey(ms = Date.now()) {
  const shifted = new Date(ms + BILLING_UTC_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 账号池。
 *
 * 不继承 cordis `Service`：它不需要自己的服务名，而不继承也让它在纯单测里可直接用。
 */
export class AccountPool {
  /**
   * @param {object} options
   * @param {string} options.home - `$DSH_HOME`
   * @param {object} [options.credentials] - `ctx.credentials`（可选）
   * @param {{ warn?: Function, info?: Function }} [options.logger]
   */
  constructor(options) {
    this.logger = options.logger
    this.credentials = options.credentials
    this.store = new PoolStore(options.home, { logger: this.logger })
    /** 轮换游标（round-robin）。 */
    this.cursor = 0

    // 设备级值：只在缺失时生成一次，之后全账号/全进程共用。
    // ⚠️ 不要给每个账号各造一份 —— 服务端会看到「同一台机器冒出 N 台设备」。
    this.store.ensureDeviceValue('deviceId', () => randomBytes(8).toString('hex'))
    this.store.ensureDeviceValue('installId', () => randomUUID())
    this.store.ensureDeviceValue('signKey', () => randomBytes(32).toString('base64url'))
  }

  /** 给签名/身份头用的设备级值。 */
  deviceValues() {
    return {
      deviceId: this.store.state.deviceId,
      installId: this.store.state.installId,
      signKey: this.store.state.signKey,
    }
  }

  /** 脱敏快照（UI 用；**不含** token / signKey / deviceId）。 */
  snapshot() {
    return this.store.publicSnapshot()
  }

  // ── 凭据 ──────────────────────────────────────────────────────────────

  /** 读某账号的凭据（`{ token }`）；不存在返回 `undefined`。 */
  async readCredential(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return undefined
    if (this.store.state.tokenStorage === 'inline') {
      return account.token ? { token: account.token } : undefined
    }
    if (this.credentials === undefined) return undefined
    try {
      const resolved = await this.credentials.resolve(credentialRef(account.ref))
      const token = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
      return token.length > 0 ? { token } : undefined
    } catch (error) {
      this.logger?.warn?.(`[teleagent-pool] 读取账号 ${accountId} 的凭据失败：${error?.message ?? String(error)}`)
      return undefined
    }
  }

  /** 写某账号的 token。 */
  async writeToken(accountId, token) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) throw new Error(`账号 ${accountId} 不存在`)
    if (this.store.state.tokenStorage === 'inline') {
      this.store.updateAccount(accountId, { token })
      return
    }
    if (this.credentials === undefined) {
      throw new Error('本组合没有 credentials 服务，无法保存 token')
    }
    await this.credentials.set(credentialRef(account.ref), token)
  }

  /** 删某账号（含凭据）。 */
  async removeAccount(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return false
    if (this.store.state.tokenStorage !== 'inline' && this.credentials !== undefined) {
      try {
        await this.credentials.unset(credentialRef(account.ref))
      } catch (error) {
        this.logger?.warn?.(`[teleagent-pool] 清除账号 ${accountId} 的凭据失败：${error?.message ?? String(error)}`)
      }
    }
    return this.store.removeAccount(accountId)
  }

  // ── 登录 ──────────────────────────────────────────────────────────────

  /**
   * 用 token 登录（**先验后用**：校验通过才落盘）。
   *
   * 把无效 token 写进池会让账号显示「已登录」，而用户要到第一次发消息时才看到
   * AUTH 错误 —— 排查成本极高。
   *
   * @param {string} token
   * @param {{ accountId?: string }} [options] - 已存在的账号 id（重新登录时复用）
   * @returns {Promise<object>} 落盘后的账号条目
   */
  async loginWithToken(token, options = {}) {
    const device = this.deviceValues()
    const info = await this.fetchUserInfo({ token }, device)
    if (info === undefined) {
      throw new Error('token 校验失败（user_info 未返回账号信息）：token 可能无效、已过期，或粘贴不完整')
    }

    const expiresAt = credentialExpiresAtMs({ token }) ?? null
    const nickname = displayNickname(info)
    const phoneTail = (info.phone ?? '').slice(-4)
    const existingByAccount = this.store.findByAccountId(info.accountId)
    const targetId = options.accountId ?? existingByAccount?.id ?? newAccountId()

    // 同一个服务端账号重复添加时**复用**原条目（否则积分/签到会分裂成两行）。
    let account = this.store.findAccount(targetId)
    if (account === undefined) {
      account = this.store.addAccount({
        id: targetId,
        ref: tokenRef(targetId),
        nickname,
        accountId: info.accountId,
        phoneTail,
        expiresAt,
        token,
      })
    } else {
      this.store.updateAccount(targetId, { nickname, accountId: info.accountId, phoneTail, expiresAt })
    }
    await this.writeToken(targetId, token)

    // 顺手抓余额（失败不影响登录成功）。
    const balance = await fetchBalance({ token }, device).catch(() => null)
    if (balance !== null) {
      this.store.updateAccount(targetId, { balance: balance.total, balanceAt: Date.now() })
    }
    return this.store.findAccount(targetId)
  }

  /** 调 `user_info`；失败返回 `undefined`（不抛错）。 */
  async fetchUserInfo(credential, device = this.deviceValues()) {
    try {
      const response = await fetchWithTimeout(absoluteUrl(USER_INFO_PATH), {
        method: 'GET',
        headers: businessHeaders(credential, device),
      }, REQUEST_TIMEOUT_MS)
      if (!response.ok) return undefined
      const { payload } = await readJson(response)
      return parseUserInfo(payload)
    } catch (error) {
      this.logger?.warn?.(`[teleagent-pool] user_info 失败：${error?.message ?? String(error)}`)
      return undefined
    }
  }

  // ── 选号 ──────────────────────────────────────────────────────────────

  /** 结构上可用的账号（启用开关打开）。 */
  selectableAccounts() {
    return this.store.state.accounts.filter((account) => account.enabled)
  }

  /**
   * 排出「这次该先试谁」的顺序。
   * @returns {Array<object>} 账号条目（可能为空）
   */
  orderedAccounts() {
    const now = Date.now()
    const candidates = this.selectableAccounts()
    if (candidates.length === 0) return []

    const sorted = [...candidates]
    if (this.store.state.settings.strategy === 'round-robin') {
      sorted.sort((a, b) => a.createdAt - b.createdAt)
      const start = this.cursor % sorted.length
      return [...sorted.slice(start), ...sorted.slice(0, start)]
    }
    // balance-desc：余额未知的排在有值的后面（未知 ≠ 0）。
    sorted.sort((a, b) => {
      const left = typeof a.balance === 'number' ? a.balance : -1
      const right = typeof b.balance === 'number' ? b.balance : -1
      return right - left
    })
    const healthy = sorted.filter((account) => (account.coolDownUntil ?? 0) <= now)
    // ⚠️ 全都在冷却时照样按顺序试：一次失败尝试的代价，远小于凭空拒绝用户。
    return healthy.length > 0 ? healthy : sorted
  }

  /** 推进轮换游标。 */
  advanceCursor() {
    const total = Math.max(1, this.selectableAccounts().length)
    this.cursor = (this.cursor + 1) % total
  }

  /** 记录一次成功（清冷却、清错误）。 */
  markSuccess(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return
    if (account.failStreak === 0 && account.lastError === '' && account.coolDownUntil === 0) return
    this.store.updateAccount(accountId, { failStreak: 0, lastError: '', lastErrorAt: 0, coolDownUntil: 0 })
  }

  /**
   * 记录一次失败（必要时进冷却）。
   * @param {string} accountId
   * @param {string} message - 面向用户的单行原因
   * @param {{ permanent?: boolean }} [options] - `permanent` 立刻冷却（AUTH/QUOTA 这类重试无用）
   */
  markFailure(accountId, message, options = {}) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return
    const streak = (account.failStreak ?? 0) + 1
    const limit = this.store.state.settings.failureCooldown
    const coolDown = options.permanent === true || streak >= limit
    this.store.updateAccount(accountId, {
      failStreak: streak,
      lastError: String(message ?? '').slice(0, 400),
      lastErrorAt: Date.now(),
      coolDownUntil: coolDown ? Date.now() + COOL_DOWN_MS : 0,
    })
  }

  // ── 积分 ──────────────────────────────────────────────────────────────

  /** 刷新某账号（或全部账号）的余额；返回逐账号结果。 */
  async refreshBalance(accountId) {
    const ids = accountId === undefined
      ? this.store.state.accounts.map((account) => account.id)
      : [accountId]
    const device = this.deviceValues()
    const results = []
    for (const id of ids) {
      const credential = await this.readCredential(id)
      if (credential === undefined) {
        results.push({ accountId: id, ok: false, message: '没有可用 token（需重新登录）' })
        continue
      }
      const balance = await fetchBalance(credential, device)
      if (balance === null) {
        results.push({ accountId: id, ok: false, message: '余额查询失败（凭据可能失效，或响应形状变化）' })
        continue
      }
      this.store.updateAccount(id, { balance: balance.total, balanceAt: Date.now() })
      results.push({ accountId: id, ok: true, balance: balance.total, message: `余额 ${balance.total}` })
    }
    return results
  }

  /** 查询某账号的签到面板（不领取）。 */
  async checkinStatus(accountId) {
    const credential = await this.readCredential(accountId)
    if (credential === undefined) return { ok: false, message: '没有可用 token（需重新登录）', panel: null }
    const panel = await fetchCheckinPanel(credential, this.deviceValues())
    if (panel === null) return { ok: false, message: '签到面板查询失败', panel: null }
    return { ok: true, message: panel.claimedToday ? '今日已领' : `今日可领 ${panel.claimable}`, panel }
  }

  /** 领取单账号的每日签到（幂等：已领直接返回 `already`）。 */
  async claimOne(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return { status: 'failed', message: '账号不存在', credit: 0 }
    const device = this.deviceValues()
    const credential = await this.readCredential(accountId)
    if (credential === undefined) {
      this.store.updateAccount(accountId, { lastCheckinResult: '没有可用 token', lastCheckinAt: Date.now() })
      return { status: 'failed', message: '没有可用 token（需重新登录）', credit: 0 }
    }
    const outcome = await claimDaily(credential, device)
    const day = utc8DayKey()
    this.store.updateAccount(accountId, {
      lastCheckinResult: outcome.message,
      lastCheckinAt: Date.now(),
      ...(outcome.status === 'claimed' || outcome.status === 'already' ? { lastCheckinDay: day } : {}),
    })
    if (outcome.status === 'claimed') {
      const balance = await fetchBalance(credential, device).catch(() => null)
      if (balance !== null) this.store.updateAccount(accountId, { balance: balance.total, balanceAt: Date.now() })
    }
    return outcome
  }

  /** 领全部账号（串行；单账号失败不影响其它）。 */
  async claimAll() {
    const results = []
    for (const account of [...this.store.state.accounts]) {
      const outcome = await this.claimOne(account.id)
      const fresh = this.store.findAccount(account.id)
      results.push({
        accountId: account.id,
        nickname: fresh?.nickname ?? account.nickname,
        ok: outcome.status === 'claimed' || outcome.status === 'already',
        status: outcome.status,
        message: outcome.message,
        credit: outcome.credit ?? 0,
        at: Date.now(),
      })
    }
    return results
  }

  // ── 每日自动签到 ──────────────────────────────────────────────────────

  /**
   * 自动签到判据：开关 → 当天已成功 → 当天次数上限。
   *
   * ⚠️ 「成功」**包含 `inactive`（今日无活动项）**：活动多在 10:00（UTC+8）刷新，
   * 若把 09:30 查到的 `inactive` 算作未完成，用户当天就再也签不到了 ——
   * 而漏签正是这个功能要消灭的东西。
   */
  decideAutoCheckin(now = Date.now()) {
    const checkin = this.store.state.checkin
    const day = utc8DayKey(now)
    if (this.store.state.settings.autoCheckin !== true) {
      return { run: false, reason: 'disabled', day }
    }
    if (checkin.day === day && checkin.succeeded) {
      return { run: false, reason: 'done', day }
    }
    const attemptsToday = checkin.day === day ? checkin.attempts : 0
    if (attemptsToday >= AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY) {
      return { run: false, reason: 'exhausted', day }
    }
    return { run: true, day, attemptsToday }
  }

  /** 跑一轮自动签到（幂等；返回本轮结果）。 */
  async runAutoCheckin(now = Date.now()) {
    const decision = this.decideAutoCheckin(now)
    if (decision.run !== true) return { ran: false, ...decision, results: [] }

    const results = await this.claimAll()
    const allSettled = results.length === 0
      || results.every((row) => row.ok || row.status === 'inactive')
    this.store.updateCheckin({
      day: decision.day,
      attempts: decision.attemptsToday + 1,
      succeeded: allSettled,
      lastRunAt: Date.now(),
      lastResults: results.slice(0, 50),
    })
    return { ran: true, day: decision.day, attempts: decision.attemptsToday + 1, succeeded: allSettled, results }
  }
}
