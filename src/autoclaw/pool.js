/**
 * AutoClaw 账号池：**从桌面端自动发现账号**（零手工），余额/目录/刷新都在这里。
 *
 * ## 与 TeleAgent 池的三处不同
 *
 * 1. **不用手工粘 token**：token 从本机 DPAPI + AES-GCM 解出来（`credential.js`）。
 *    所以「加账号」= 在 AutoClaw 里登录一次，然后点「扫描本机账号」。
 * 2. **有 refresh_token**：缺 token 时可以静默续（/userapi/v1/refresh）。
 * 3. **没有每日签到**：AutoClaw 服务端不存在「每日领取积分」端点
 *    （`checkin` / `签到` / `领取` 在 15.6MB main.cjs 里 0 命中）。
 *    它有邀请返利、积分过期提醒、兑换码，但都不是每日签到 —— 不编一个假的。
 *
 * @module dsh-teleagent-pool/src/autoclaw/pool
 */

import path from 'node:path'

import { credentialRef } from '../refs.js'
import { utc8DayKey } from '../pool.js'
import { fetchBalance, fetchExpiring, fetchProviderConfig, refreshToken } from './api.js'
import { listLocalAccounts, readAccountModelCatalog, userDataDir } from './credential.js'
import { KEEP_DIR_NAME, backupCredential, listBackups } from './vaultkeeper.js'
import {
  FALLBACK_MODELS,
  PROVIDER_ID,
} from './product.js'
import { ACCOUNT_PREFIX, AutoClawStore } from './store.js'

/** 连续失败达到阈值后的冷却时长。 */
const COOL_DOWN_MS = 10 * 60_000

/**
 * 解析凭据库里存的 token 值。
 *
 * 兼容两种形态：`{"access_token":"…"}`（本插件的格式）与裸 token 串
 * （用户手填 / 早期版本）。
 */
function parseStoredToken(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      const token = typeof parsed?.access_token === 'string' ? parsed.access_token.trim() : ''
      return token.length > 0 ? { token } : undefined
    } catch {
      return undefined
    }
  }
  return { token: text }
}

/** AutoClaw 账号池。 */
export class AutoClawPool {
  /**
   * @param {object} options
   * @param {string} options.home - `$DSH_HOME`
   * @param {object} [options.credentials] - `ctx.credentials`（可选）
   * @param {{ warn?: Function, info?: Function }} [options.logger]
   * @param {string} [options.autoClawDir] - 覆盖 AutoClaw 用户目录（测试用）
   */
  constructor(options) {
    this.logger = options.logger
    this.credentials = options.credentials
    this.autoClawDir = options.autoClawDir
    this.store = new AutoClawStore(options.home, { logger: this.logger })
    /**
     * 凭据保管目录。
     *
     * 放在**插件自己的数据目录**下（跟 `autoclaw.json` 同级），不污染客户端目录。
     * 用途见 `vaultkeeper.js`：切号前备份、切回时还原 —— 因为客户端切号会
     * `rm` 掉旧账号的 `account-credentials.enc`，不备份就再也回不来。
     */
    this.keepRoot = path.join(this.store.dir, KEEP_DIR_NAME)
    /** 目录缓存（`{ models, channels, at }`）。 */
    this.catalog = undefined
    /** token 刷新冷却（accessToken → 下次可刷时刻），避免 401 时反复打。 */
    this.refreshBlockedUntil = new Map()
  }

  /** 脱敏快照。 */
  snapshot() {
    return this.store.publicSnapshot()
  }

  /** 本机路径（UI 展示 + 排错用）。 */
  localPaths() {
    return { userDataDir: userDataDir(this.autoClawDir), keepRoot: this.keepRoot }
  }

  /** 保管目录里有哪些账号的凭据备份。 */
  listCredentialBackups() {
    return listBackups(this.keepRoot)
  }

  /**
   * 手动备份某账号凭据（用户点「立即备份」时用）。
   */
  backupCredential(accountKey) {
    return backupCredential({
      userDataDir: userDataDir(this.autoClawDir),
      keepRoot: this.keepRoot,
      accountKey,
    })
  }

  // ── 凭据 ──────────────────────────────────────────────────────────────

  /**
   * 读某账号 token。
   *
   * ⚠️ **凭据库优先，但拿不到就回退内联字段** —— 不管 `tokenStorage` 标志写着什么。
   * 理由是真实发生过的迁移顺序：先在没有 `credentials` 服务的组合里内联存了 token，
   * 之后 `ctx.inject(['credentials'])` 才落定并把标志翻成 `credentials`。
   * 若读取时只看标志，那次迁移就会让**已经有效的 token 凭空消失**。
   */
  async readToken(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return undefined
    if (this.credentials !== undefined) {
      try {
        const resolved = await this.credentials.resolve(credentialRef(account.ref))
        const stored = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
        const fromStore = parseStoredToken(stored)
        if (fromStore !== undefined) return fromStore
      } catch (error) {
        this.logger?.warn?.(`[autoclaw] 读取账号 ${accountId} 的凭据失败：${error?.message ?? String(error)}`)
      }
    }
    // 回退：内联字段（老数据 / 无凭据服务的组合）
    const inline = typeof account.token === 'string' ? account.token.trim() : ''
    return inline.length > 0 ? { token: inline } : undefined
  }

  /**
   * 写 token。
   *
   * ⚠️ 没有 `credentials` 服务时**自动降级为内联**并落盘标记，而不是抛错 ——
   * 否则「扫描本机账号」会在极简组合里彻底不可用，而 token 本来就已经可以从
   * 桌面端解出来了（不需要额外保密层）。
   */
  async writeTokens(accountId, accessToken, refreshTokenValue) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) throw new Error(`AutoClaw 账号 ${accountId} 不存在`)
    const hasStore = this.credentials !== undefined && this.store.state.tokenStorage !== 'inline'
    if (hasStore) {
      try {
        const value = JSON.stringify({ access_token: accessToken, refresh_token: refreshTokenValue ?? '' })
        await this.credentials.set(credentialRef(account.ref), value)
        return
      } catch (error) {
        this.logger?.warn?.(
          `[autoclaw] 写入凭据库失败（降级为内联）：${error?.message ?? String(error)}`,
        )
      }
    }
    // 内联：先翻标记再写，否则 updateAccount 会拒收 token 字段。
    if (this.store.state.tokenStorage !== 'inline') {
      this.store.state.tokenStorage = 'inline'
    }
    this.store.updateAccount(accountId, { token: accessToken, refresh_token: refreshTokenValue ?? '' })
  }

  /** 读 refresh_token（内联或凭据库）。 */
  async readRefreshToken(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return ''
    if (this.credentials !== undefined) {
      try {
        const resolved = await this.credentials.resolve(credentialRef(account.ref))
        const stored = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
        if (stored.startsWith('{')) {
          const parsed = JSON.parse(stored)
          if (typeof parsed?.refresh_token === 'string' && parsed.refresh_token.length > 0) {
            return parsed.refresh_token
          }
        }
      } catch {
        // 落到内联
      }
    }
    return typeof account.refresh_token === 'string' ? account.refresh_token : ''
  }

  /** 删账号（含凭据）。 */
  async removeAccount(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return false
    if (this.store.state.tokenStorage !== 'inline' && this.credentials !== undefined) {
      try {
        await this.credentials.unset(credentialRef(account.ref))
      } catch (error) {
        this.logger?.warn?.(`[autoclaw] 清除账号 ${accountId} 的凭据失败：${error?.message ?? String(error)}`)
      }
    }
    return this.store.removeAccount(accountId)
  }

  // ── 发现（零手工）──────────────────────────────────────────────────────

  /**
   * 扫描本机 AutoClaw 账号并入库。
   *
   * 已存在的（按 accountId 或 accountKey 匹配）**复用并刷新 token**，
   * 不新增重复条目。返回逐账号结果，便于 UI 说明「扫到几个、新增几个」。
   */
  async scanLocalAccounts(options = {}) {
    const found = await listLocalAccounts({ userDataDir: this.autoClawDir })
    const results = []
    for (const row of found) {
      const identity = row.accountId !== '' ? row.accountId : row.accountKey
      const existing = this.store.findByAccountId(identity)
        ?? this.store.findByAccountKey(row.accountKey)
      const nickname = row.phone !== ''
        ? `智谱 ${row.phone.slice(-4)}`
        : `智谱 ${identity.slice(-6)}`

      let account = existing
      if (account === undefined) {
        account = this.store.addAccount({
          id: `${ACCOUNT_PREFIX}${identity.replace(/[^A-Za-z0-9]/gu, '').slice(0, 24)}`,
          identity,
          accountKey: row.accountKey,
          nickname,
          phone: row.phone,
          numericUserId: row.numericUserId,
          token: row.token,
          refresh_token: row.refreshToken,
        })
      } else {
        this.store.updateAccount(account.id, {
          accountKey: row.accountKey,
          phone: row.phone !== '' ? row.phone : account.phone,
          numericUserId: row.numericUserId || account.numericUserId,
          nickname,
          tokenStorageHint: row.hasCredential,
        })
      }
      const id = account.id
      if (row.hasCredential) {
        await this.writeTokens(id, row.token, row.refreshToken).catch((error) => {
          this.logger?.warn?.(`[autoclaw] 保存账号 ${id} 的 token 失败：${error?.message ?? String(error)}`)
        })
      } else {
        // ⚠️ 无凭据的账号要**明确记一条原因**，否则面板上只看到一个空白积分，
        // 用户会以为插件坏了。这台机器上真实发生过：账号目录在、凭据文件从未生成。
        this.store.updateAccount(id, {
          lastError: '该账号在 AutoClaw 里没有凭据文件（从未真正登录过，或登录后被切走）',
          lastErrorAt: Date.now(),
        })
      }
      results.push({
        accountId: id,
        nickname,
        isNew: existing === undefined,
        hasCredential: row.hasCredential,
        active: row.active,
      })
    }

    // 拉一次余额（让 UI 立刻有数；失败不影响扫描结果）
    if (!options.skipBalance) await this.refreshBalance().catch(() => {})
    return results
  }

  // ── 选号 ──────────────────────────────────────────────────────────────

  /** 结构上可用的账号。 */
  selectableAccounts() {
    return this.store.state.accounts.filter((account) => account.enabled)
  }

  /** 按策略排顺序（默认余额优先；全在冷却时照样试）。 */
  orderedAccounts() {
    const now = Date.now()
    const list = [...this.selectableAccounts()]
    if (list.length === 0) return []
    if (this.store.state.settings.strategy === 'round-robin') {
      list.sort((a, b) => a.createdAt - b.createdAt)
      const start = this.cursor % list.length
      this.cursor = (this.cursor + 1) % list.length
      return [...list.slice(start), ...list.slice(0, start)]
    }
    list.sort((a, b) => {
      const left = typeof a.balance === 'number' ? a.balance : -1
      const right = typeof b.balance === 'number' ? b.balance : -1
      return right - left
    })
    const healthy = list.filter((account) => (account.coolDownUntil ?? 0) <= now)
    return healthy.length > 0 ? healthy : list
  }

  /** 记一次成功。 */
  markSuccess(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return
    if (account.failStreak === 0 && account.lastError === '' && account.coolDownUntil === 0) return
    this.store.updateAccount(accountId, { failStreak: 0, lastError: '', lastErrorAt: 0, coolDownUntil: 0 })
  }

  /** 记一次失败（必要时冷却）。 */
  markFailure(accountId, message, options = {}) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return
    const streak = (account.failStreak ?? 0) + 1
    const limit = this.store.state.settings.failureCooldown
    this.store.updateAccount(accountId, {
      failStreak: streak,
      lastError: String(message ?? '').slice(0, 400),
      lastErrorAt: Date.now(),
      coolDownUntil: options.permanent === true || streak >= limit ? Date.now() + COOL_DOWN_MS : 0,
    })
  }

  /**
   * 取一个可用 token：先本地，401 时尝试 refresh 一次。
   *
   * ⚠️ 刷新失败**不删账号**：token 过期最常见的解法是「重新打开一次 AutoClaw」，
   * 那时凭据文件会被桌面端自己重写，我们重新扫描即可 —— 删了就要重配。
   */
  async resolveToken(accountId) {
    const account = this.store.findAccount(accountId)
    if (account === undefined) return undefined
    const local = await this.readToken(accountId)
    if (local !== undefined) return local.token

    // 无 token：尝试用 refresh_token 换
    const blockedUntil = this.refreshBlockedUntil.get(accountId) ?? 0
    if (Date.now() < blockedUntil) return undefined
    const refreshValue = await this.readRefreshToken(accountId)
    if (refreshValue.length === 0) return undefined
    const refreshed = await refreshToken(refreshValue, { deviceId: account.accountKey })
    if (refreshed === undefined) {
      this.refreshBlockedUntil.set(accountId, Date.now() + 10 * 60_000)
      return undefined
    }
    await this.writeTokens(accountId, refreshed.accessToken, refreshed.refreshToken).catch(() => {})
    return refreshed.accessToken
  }

  // ── 余额 / 目录 ──────────────────────────────────────────────────────

  /** 刷新某账号（或全部）余额。 */
  async refreshBalance(accountId) {
    const ids = accountId === undefined
      ? this.store.state.accounts.map((account) => account.id)
      : [accountId]
    const results = []
    for (const id of ids) {
      const account = this.store.findAccount(id)
      const token = await this.resolveToken(id)
      if (token === undefined) {
        // ⚠️ 消息必须点明**是哪一种缺失**：这台机器上真实出现过「账号目录在、
        // 但凭据文件从未生成」的情况（那个账号在 AutoClaw 里根本没真正登录过）。
        // 笼统说「token 过期」会让人反复重扫同一个空的账号。
        const hasDir = typeof account?.accountKey === 'string' && account.accountKey.length > 0
        results.push({
          accountId: id,
          ok: false,
          reason: 'no-credential',
          message: hasDir
            ? '该账号在 AutoClaw 里没有凭据文件（从未真正登录过，或登录后被切走）⇒ 插件的 0 分是「不可读」，不是「没积分」'
            : '没有可用 token（打开 AutoClaw 登录后重新扫描）',
        })
        continue
      }
      const balance = await fetchBalance(token)
      if (balance === null) {
        results.push({ accountId: id, ok: false, reason: 'query-failed', message: '余额查询失败（token 可能失效）' })
        continue
      }
      const expiring = await fetchExpiring(token).catch(() => null)
      this.store.updateAccount(id, {
        balance: balance.total,
        balanceAt: Date.now(),
        wallets: balance.wallets,
        expiring: expiring === null ? null : expiring.expiring,
        expiringAt: Date.now(),
        // ⚠️ 余额查得通 ⇒ 凭据是好的，把历史失败**清掉**。
        // 之前这里只写余额、不清错误，导致「上次失败：HTTP 400 非法模型」永远挂在界面上
        // —— 那不是缓存，是**落盘的旧状态**（`autoclaw.json` 里真的有这条）。
        lastError: '',
        lastErrorAt: 0,
        failStreak: 0,
        coolDownUntil: 0,
      })
      results.push({ accountId: id, ok: true, balance: balance.total, message: `积分 ${balance.total}` })
    }
    return results
  }

  /**
   * 取模型目录（缓存 10 分钟）。
   *
   * ## ⚠️⚠️ 模型名有两个数据源，**推理只能用账号级那个**
   *
   * | 源 | 内容 | 能否推理 |
   * |---|---|---|
   * | 账号级 `remote-snapshot.json`（**本函数首选**） | `zai_auto` / `zaicoding_glm-5.3` / … 5 条 | ✅ 网关认 |
   * | `third-party-provider-config`（**只进 `channels` 展示**） | `glm-5.3` / `deepseek-v4-pro` … BYOK 清单 | ❌ `400 非法模型` |
   *
   * 我一开始用后者喂推理，代价是每次对话都回「非法模型」。406（名字对、差 scope）
   * vs 400（网关不认）就是这两者的分辨标记。
   */
  async loadCatalog(options = {}) {
    const ttl = options.ttlMs ?? 10 * 60_000
    if (this.catalog !== undefined && Date.now() - this.catalog.at < ttl && !options.force) {
      return this.catalog
    }

    // ① 账号级目录：推理真正认的 model 名（本地文件，零网络）
    const owned = readAccountModelCatalog({ userDataDir: this.autoClawDir })
    if (owned.length > 0) {
      // ② 顺手拉一次第三方渠道清单，**仅用于展示**（失败不影响推理目录）
      let channels = []
      for (const account of this.orderedAccounts()) {
        const token = await this.resolveToken(account.id)
        if (token === undefined) continue
        const config = await fetchProviderConfig(token).catch(() => null)
        if (config !== null && config.channels.length > 0) {
          channels = config.channels
          break
        }
      }
      this.catalog = { models: owned, channels, at: Date.now() }
      return this.catalog
    }

    // ③ 客户端还没缓存过目录（没成功对话过）：兜底表 + 尝试拉渠道展示
    for (const account of this.orderedAccounts()) {
      const token = await this.resolveToken(account.id)
      if (token === undefined) continue
      const config = await fetchProviderConfig(token).catch(() => null)
      if (config !== null && config.channels.length > 0) {
        this.catalog = { models: [...FALLBACK_MODELS], channels: config.channels, at: Date.now(), fallback: true }
        return this.catalog
      }
    }

    if (this.catalog !== undefined) return this.catalog
    return { models: [...FALLBACK_MODELS], channels: [], at: 0, fallback: true }
  }

  /** 模型目录（同步视图，供 UI 立刻读）。 */
  catalogView() {
    if (this.catalog === undefined) return { models: [...FALLBACK_MODELS], channels: [], fallback: true }
    return { models: this.catalog.models, channels: this.catalog.channels, fallback: this.catalog.fallback === true }
  }

  /** AutoClaw 没有每日签到：如实说明，不给假按钮。 */
  checkinCapability() {
    return {
      supported: false,
      reason: 'AutoClaw 服务端没有「每日领取积分」端点（15.6MB main.cjs 全文 0 命中 checkin/签到/领取）。'
        + '它有邀请返利、积分过期提醒与兑换码，但都不是每日签到。',
      day: utc8DayKey(),
    }
  }
}

export { PROVIDER_ID }
