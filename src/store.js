/**
 * 账号池的持久化（`$DSH_HOME/teleagent-pool/pool.json`）。
 *
 * ## 为什么 token 走 `ctx.credentials`，而账号元数据走 JSON
 *
 * token 是**凭据**，DSH 有专门的凭据服务（`.credentials.yaml`，含写入锁与
 * 原子替换）；把 token 塞进插件自己的 JSON 会让它落在没有凭据语义的地方。
 * 但**账号列表**（昵称、余额快照、签到记录、启用开关）是普通状态，写进凭据库
 * 既不该也不方便 —— 所以两者分开，靠 `ref` 关联。
 *
 * 无 `credentials` 服务的组合（headless 极简 profile）会退化为**同文件内联**，
 * 并在状态里标记 `tokenStorage: 'inline'`，让 UI 能如实说明风险，而不是假装安全。
 *
 * ## 设备级值
 *
 * `deviceId` / `installId` / `signKey` 是**设备级**（全账号共用一份）：
 * asar 明示 deviceId 与 installId 一起持久化在设备级状态文件，且签名 sessionKey
 * 是每进程随机、不经服务端注册 ⇒ 服务端只看「头在不在、版本合法、时间戳新鲜」。
 * 若给每个账号各造一份，服务端会看到「同一台机器冒出 N 台设备」。
 *
 * @module dsh-teleagent-pool/src/store
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR_NAME } from './product.js'

const STATE_VERSION = 1

/** 生成一个账号 id（字母数字下划线，可安全拼进 credential ref）。 */
export function newAccountId() {
  return `acc_${randomBytes(5).toString('hex')}`
}

/** 账号的凭据 ref 名（必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`）。 */
export function tokenRef(accountId) {
  return `TELEAGENT_TOKEN_${String(accountId).toUpperCase().replace(/[^A-Z0-9_]/gu, '_')}`
}

/** 空状态。 */
function emptyState() {
  return {
    version: STATE_VERSION,
    deviceId: '',
    installId: '',
    signKey: '',
    settings: {
      autoCheckin: true,
      /** 选号策略：`balance-desc`（余额从多到少）| `round-robin`（依次轮换）。 */
      strategy: 'balance-desc',
      /** 单账号连续失败多少次后临时冷却。 */
      failureCooldown: 3,
    },
    accounts: [],
    checkin: {
      day: null,
      attempts: 0,
      succeeded: false,
      lastRunAt: null,
      lastResults: [],
    },
    tokenStorage: 'credentials',
  }
}

/** 把任意读到的东西收敛成一个形状合法的状态（存储里什么都可能有）。 */
export function sanitizeState(raw) {
  const base = emptyState()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base

  const str = (value) => (typeof value === 'string' ? value : '')
  const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

  base.deviceId = str(raw.deviceId)
  base.installId = str(raw.installId)
  base.signKey = str(raw.signKey)
  base.tokenStorage = raw.tokenStorage === 'inline' ? 'inline' : 'credentials'

  const settings = typeof raw.settings === 'object' && raw.settings !== null ? raw.settings : {}
  base.settings.autoCheckin = settings.autoCheckin !== false
  base.settings.strategy = settings.strategy === 'round-robin' ? 'round-robin' : 'balance-desc'
  base.settings.failureCooldown = Math.max(1, Math.min(20, num(settings.failureCooldown, 3)))

  const accounts = Array.isArray(raw.accounts) ? raw.accounts : []
  const seen = new Set()
  for (const entry of accounts) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = str(entry.id)
    if (!/^[A-Za-z0-9_]+$/u.test(id) || seen.has(id)) continue
    seen.add(id)
    base.accounts.push({
      id,
      ref: str(entry.ref) || tokenRef(id),
      nickname: str(entry.nickname) || id,
      accountId: str(entry.accountId),
      phoneTail: str(entry.phoneTail),
      enabled: entry.enabled !== false,
      expiresAt: typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
      balance: typeof entry.balance === 'number' && Number.isFinite(entry.balance) ? entry.balance : null,
      balanceAt: num(entry.balanceAt, 0),
      lastCheckinDay: str(entry.lastCheckinDay) || null,
      lastCheckinAt: num(entry.lastCheckinAt, 0),
      lastCheckinResult: str(entry.lastCheckinResult),
      lastError: str(entry.lastError),
      lastErrorAt: num(entry.lastErrorAt, 0),
      failStreak: Math.max(0, num(entry.failStreak, 0)),
      coolDownUntil: num(entry.coolDownUntil, 0),
      /** 只有 `inline` 模式下才有值（无 credentials 服务的降级存储）。 */
      token: base.tokenStorage === 'inline' ? str(entry.token) : '',
      /**
       * 该账号是否持有**真实**的客户端 sessionKey（能过 3.0.0 的签名校验）。
       *
       * ⚠️ 必须持久化：这颗布尔值决定「发不发签名头」。不落盘的话，池一重建它就丢，
       * 适配器会重新去发必然被拒的头（40104/40105），而且单元测试里
       * 「设了 trustedSignKey 但仍被判无签名能力」正是这个原因。
       */
      trustedSignKey: entry.trustedSignKey === true,
      createdAt: num(entry.createdAt, 0),
    })
  }

  const checkin = typeof raw.checkin === 'object' && raw.checkin !== null ? raw.checkin : {}
  base.checkin.day = typeof checkin.day === 'string' ? checkin.day : null
  base.checkin.attempts = Math.max(0, num(checkin.attempts, 0))
  base.checkin.succeeded = checkin.succeeded === true
  base.checkin.lastRunAt = typeof checkin.lastRunAt === 'number' && Number.isFinite(checkin.lastRunAt) ? checkin.lastRunAt : null
  base.checkin.lastResults = Array.isArray(checkin.lastResults)
    ? checkin.lastResults
      .filter((row) => typeof row === 'object' && row !== null)
      .slice(0, 50)
      .map((row) => ({
        accountId: str(row.accountId),
        nickname: str(row.nickname),
        ok: row.ok === true,
        status: str(row.status),
        message: str(row.message),
        credit: typeof row.credit === 'number' && Number.isFinite(row.credit) ? row.credit : 0,
        at: num(row.at, 0),
      }))
    : []

  return base
}

/** 原子写 JSON（先写临时文件再 rename；文件权限 0600）。 */
function writeAtomic(filename, text) {
  const dir = path.dirname(filename)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, filename)
}

/**
 * 账号池存储。
 *
 * 读写都走**同步**文件操作：状态很小（几个账号），而同步写让「保存成功」
 * 与「内存状态一致」在同一 tick 内成立，省掉一整类竞态。
 */
export class PoolStore {
  /**
   * @param {string} home - `$DSH_HOME`
   * @param {{ logger?: { warn?: (message: string) => void } }} [options]
   */
  constructor(home, options = {}) {
    this.dir = path.resolve(home, DATA_DIR_NAME)
    this.file = path.join(this.dir, 'pool.json')
    this.logger = options.logger
    this.state = emptyState()
    this.load()
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      this.state = sanitizeState(JSON.parse(text))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.logger?.warn?.(`[teleagent-pool] 读取 ${this.file} 失败（按空池启动）：${error.message ?? String(error)}`)
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
      this.logger?.warn?.(`[teleagent-pool] 写入 ${this.file} 失败：${error.message ?? String(error)}`)
      return false
    }
  }

  /** 读一份**脱敏**快照（给 UI；永不含 token / signKey / deviceId）。 */
  publicSnapshot() {
    return {
      settings: { ...this.state.settings },
      tokenStorage: this.state.tokenStorage,
      accounts: this.state.accounts.map((account) => ({
        id: account.id,
        nickname: account.nickname,
        accountId: account.accountId,
        phoneTail: account.phoneTail,
        enabled: account.enabled,
        expiresAt: account.expiresAt,
        balance: account.balance,
        balanceAt: account.balanceAt,
        lastCheckinDay: account.lastCheckinDay,
        lastCheckinAt: account.lastCheckinAt,
        lastCheckinResult: account.lastCheckinResult,
        lastError: account.lastError,
        lastErrorAt: account.lastErrorAt,
        failStreak: account.failStreak,
        coolDownUntil: account.coolDownUntil,
        createdAt: account.createdAt,
      })),
      checkin: {
        day: this.state.checkin.day,
        attempts: this.state.checkin.attempts,
        succeeded: this.state.checkin.succeeded,
        lastRunAt: this.state.checkin.lastRunAt,
        lastResults: [...this.state.checkin.lastResults],
      },
    }
  }

  findAccount(id) {
    return this.state.accounts.find((account) => account.id === id)
  }

  /** 按服务端账号 id 找（登录去重）。 */
  findByAccountId(accountId) {
    if (typeof accountId !== 'string' || accountId.length === 0) return undefined
    return this.state.accounts.find((account) => account.accountId === accountId)
  }

  addAccount(fields) {
    const id = fields.id ?? newAccountId()
    const account = {
      id,
      ref: fields.ref ?? tokenRef(id),
      nickname: fields.nickname ?? id,
      accountId: fields.accountId ?? '',
      phoneTail: fields.phoneTail ?? '',
      enabled: fields.enabled !== false,
      expiresAt: fields.expiresAt ?? null,
      balance: fields.balance ?? null,
      balanceAt: fields.balanceAt ?? 0,
      lastCheckinDay: null,
      lastCheckinAt: 0,
      lastCheckinResult: '',
      lastError: '',
      lastErrorAt: 0,
      failStreak: 0,
      coolDownUntil: 0,
      token: this.state.tokenStorage === 'inline' ? (fields.token ?? '') : '',
      trustedSignKey: fields.trustedSignKey === true,
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
      if (key === 'token' && this.state.tokenStorage !== 'inline') continue
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

  /** 写入（或刷新）签到日闸门的记录。 */
  updateCheckin(patch) {
    Object.assign(this.state.checkin, patch)
    this.save()
    return { ...this.state.checkin }
  }

  /** 设备级值：读；空则生成后落盘（只生成一次，之后全设备共用）。 */
  ensureDeviceValue(key, generate) {
    const current = this.state[key]
    if (typeof current === 'string' && current.length > 0) return current
    const generated = generate()
    this.state[key] = generated
    this.save()
    return generated
  }
}

export { emptyState }
