/**
 * AutoClaw 账号池的持久化（`$DSH_HOME/teleagent-pool/autoclaw.json`）。
 *
 * 与 TeleAgent 池**分文件存**：两家的账号形状不同（AutoClaw 有 accountKey/refresh_token、
 * 没有签到记录），塞进同一个文件会让 `sanitizeState` 长出两套互不相干的可选字段，
 * 那是维护负担而不是复用。
 *
 * ⚠️ 目录仍是同一个（`teleagent-pool/`）—— 它们是同一个插件的两个号池，
 * 不是两个插件。
 *
 * @module dsh-teleagent-pool/src/autoclaw/store
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR_NAME } from '../product.js'

const STATE_VERSION = 1

/** 本池账号 id 前缀（与 TeleAgent 的 `acc_` 区分，便于日志里一眼看出是谁）。 */
export const ACCOUNT_PREFIX = 'zai_'

/** 生成账号 id。 */
export function newAccountId(seed) {
  const cleaned = String(seed ?? '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 24)
  return `${ACCOUNT_PREFIX}${cleaned.length > 0 ? cleaned : Date.now().toString(36)}`
}

/** 凭据 ref 名。 */
export function tokenRef(accountId) {
  return `AUTOCLAW_TOKEN_${String(accountId).toUpperCase().replace(/[^A-Z0-9_]/gu, '_')}`
}

function emptyState() {
  return {
    version: STATE_VERSION,
    settings: {
      strategy: 'balance-desc',
      failureCooldown: 3,
      /** 启动时自动扫描本机 AutoClaw 账号（零手工）。 */
      autoScan: true,
      /**
       * 额度耗尽时自动换号（默认**关闭**）。
       *
       * ⚠️ 为什么默认关：换号必须改写账号指针并**重启 AutoClaw 客户端**
       * （`account_switch_requires_restart`），会关掉用户正在用的窗口十几秒。
       * 这种事得用户明确同意，不能悄悄做。
       */
      autoSwitchOnQuota: false,
    },
    accounts: [],
    tokenStorage: 'credentials',
  }
}

/** 收敛任意读到的东西成合法状态。 */
export function sanitizeState(raw) {
  const base = emptyState()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const str = (value) => (typeof value === 'string' ? value : '')
  const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

  base.tokenStorage = raw.tokenStorage === 'inline' ? 'inline' : 'credentials'
  const settings = typeof raw.settings === 'object' && raw.settings !== null ? raw.settings : {}
  base.settings.strategy = settings.strategy === 'round-robin' ? 'round-robin' : 'balance-desc'
  base.settings.failureCooldown = Math.max(1, Math.min(20, num(settings.failureCooldown, 3)))
  base.settings.autoScan = settings.autoScan !== false
  base.settings.autoSwitchOnQuota = settings.autoSwitchOnQuota === true

  const seen = new Set()
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = str(entry.id)
    if (!/^[A-Za-z0-9_]+$/u.test(id) || seen.has(id)) continue
    seen.add(id)
    base.accounts.push({
      id,
      ref: str(entry.ref) || tokenRef(id),
      /** 服务端 accountId（或 accountKey）—— 扫描去重的稳定判据。 */
      identity: str(entry.identity),
      /** 本地目录名（用于在桌面端重写凭据后重新读取）。 */
      accountKey: str(entry.accountKey),
      nickname: str(entry.nickname) || id,
      phone: str(entry.phone),
      numericUserId: num(entry.numericUserId, 0),
      enabled: entry.enabled !== false,
      balance: typeof entry.balance === 'number' && Number.isFinite(entry.balance) ? entry.balance : null,
      balanceAt: num(entry.balanceAt, 0),
      expiring: typeof entry.expiring === 'number' && Number.isFinite(entry.expiring) ? entry.expiring : null,
      expiringAt: num(entry.expiringAt, 0),
      /**
       * 凭据有效期（毫秒时间戳），从 token 的 JWT `exp` 解出。
       *
       * ⚠️ `null` 表示**解不出来**（不是"永久有效"）。界面必须显示「未知」，
       * 不能当成有效 —— 编一个日期比不显示更糟。
       */
      expiresAt: typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
      wallets: Array.isArray(entry.wallets)
        ? entry.wallets
          .filter((row) => typeof row === 'object' && row !== null)
          .slice(0, 32)
          .map((row) => ({
            type: str(row.type),
            name: str(row.name),
            balance: num(row.balance, 0),
            visible: row.visible === true,
          }))
        : [],
      lastError: str(entry.lastError),
      lastErrorAt: num(entry.lastErrorAt, 0),
      failStreak: Math.max(0, num(entry.failStreak, 0)),
      coolDownUntil: num(entry.coolDownUntil, 0),
      token: base.tokenStorage === 'inline' ? str(entry.token) : '',
      refresh_token: base.tokenStorage === 'inline' ? str(entry.refresh_token) : '',
      createdAt: num(entry.createdAt, 0),
    })
  }
  return base
}

/** 原子写（0600）。 */
function writeAtomic(filename, text) {
  const dir = path.dirname(filename)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, filename)
}

/** AutoClaw 账号池存储。 */
export class AutoClawStore {
  /**
   * @param {string} home - `$DSH_HOME`
   * @param {{ logger?: { warn?: Function } }} [options]
   */
  constructor(home, options = {}) {
    this.dir = path.resolve(home, DATA_DIR_NAME)
    this.file = path.join(this.dir, 'autoclaw.json')
    this.logger = options.logger
    this.state = emptyState()
    this.load()
  }

  load() {
    try {
      this.state = sanitizeState(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.logger?.warn?.(`[autoclaw] 读取 ${this.file} 失败（按空池启动）：${error?.message ?? String(error)}`)
      }
      this.state = emptyState()
    }
    return this.state
  }

  save() {
    try {
      writeAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`)
      return true
    } catch (error) {
      this.logger?.warn?.(`[autoclaw] 写入 ${this.file} 失败：${error?.message ?? String(error)}`)
      return false
    }
  }

  /** 脱敏快照（永不含 token）。 */
  publicSnapshot() {
    return {
      settings: { ...this.state.settings },
      tokenStorage: this.state.tokenStorage,
      accounts: this.state.accounts.map((account) => ({
        id: account.id,
        nickname: account.nickname,
        phone: account.phone,
        identity: account.identity,
        accountKey: account.accountKey,
        enabled: account.enabled,
        balance: account.balance,
        balanceAt: account.balanceAt,
        expiring: account.expiring,
        expiringAt: account.expiringAt,
        /** 凭据有效期；`null` = 解不出来（界面显示「未知」）。 */
        expiresAt: account.expiresAt,
        wallets: [...account.wallets],
        lastError: account.lastError,
        lastErrorAt: account.lastErrorAt,
        failStreak: account.failStreak,
        coolDownUntil: account.coolDownUntil,
        createdAt: account.createdAt,
      })),
    }
  }

  findAccount(id) {
    return this.state.accounts.find((account) => account.id === id)
  }

  findByAccountId(identity) {
    if (typeof identity !== 'string' || identity.length === 0) return undefined
    return this.state.accounts.find((account) => account.identity === identity)
  }

  findByAccountKey(accountKey) {
    if (typeof accountKey !== 'string' || accountKey.length === 0) return undefined
    return this.state.accounts.find((account) => account.accountKey === accountKey)
  }

  addAccount(fields) {
    const id = fields.id ?? newAccountId(fields.identity)
    const account = {
      id,
      ref: fields.ref ?? tokenRef(id),
      identity: fields.identity ?? '',
      accountKey: fields.accountKey ?? '',
      nickname: fields.nickname ?? id,
      phone: fields.phone ?? '',
      numericUserId: fields.numericUserId ?? 0,
      enabled: fields.enabled !== false,
      balance: null,
      balanceAt: 0,
      expiring: null,
      expiringAt: 0,
      expiresAt: fields.expiresAt ?? null,
      wallets: [],
      lastError: '',
      lastErrorAt: 0,
      failStreak: 0,
      coolDownUntil: 0,
      token: this.state.tokenStorage === 'inline' ? (fields.token ?? '') : '',
      refresh_token: this.state.tokenStorage === 'inline' ? (fields.refresh_token ?? '') : '',
      createdAt: Date.now(),
    }
    this.state.accounts.push(account)
    this.save()
    return account
  }

  updateAccount(id, patch) {
    const account = this.findAccount(id)
    if (account === undefined) return undefined
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'ref') continue
      if ((key === 'token' || key === 'refresh_token') && this.state.tokenStorage !== 'inline') continue
      if (key === 'tokenStorageHint') continue
      account[key] = value
    }
    this.save()
    return account
  }

  removeAccount(id) {
    const before = this.state.accounts.length
    this.state.accounts = this.state.accounts.filter((account) => account.id !== id)
    if (this.state.accounts.length !== before) this.save()
    return before !== this.state.accounts.length
  }

  updateSettings(patch) {
    Object.assign(this.state.settings, patch)
    this.save()
    return { ...this.state.settings }
  }
}
