/**
 * dsh-teleagent-pool — Host 半身。
 *
 * 把**多个** TeleAgent（中国电信天翼 AI 星辰超级智能体）账号的积分与模型接进 DSH：
 *
 * 1. 注册 `teleagent` provider 路由 → 模型选择器里出现「TeleAgent (电信)」分组；
 * 2. 账号池：多账号、余额排序 / 轮换、失败自动换号、AUTH 与积分不足的区分；
 * 3. 积分：逐账号余额查询 + 每日签到（手动「一键领取」+ **每日自动签到**）；
 * 4. 浏览器 API：设置页读写账号与开关（`/api/teleagent-pool/*`）。
 *
 * ## `inject` 里为什么只有 `llm`
 *
 * Cordis 会**扣住** fiber 里没声明的服务，并让 fiber **一直 pending** 直到它出现。
 * 所以只有「插件没它就活不下去」的那个能写进去 —— 那正是 `llm`。
 * `credentials` / `webServer` / `commands` 全部走**嵌套 `ctx.inject`**：
 * 缺席时对应的能力降级（没有凭据服务就内联存储、没有 webServer 就没有面板），
 * 但 provider 本身照常可用。
 *
 * @module dsh-teleagent-pool
 */

import path from 'node:path'
import os from 'node:os'
import { PROVIDER_ID, PROVIDER_NAME, LOGIN_PAGE, AUTO_CHECKIN_TICK_MS } from './src/product.js'
import { AccountPool } from './src/pool.js'
import { createAdapter } from './src/adapter.js'
import { parseLoginInput } from './src/protocol.js'
import { inDailyWindow, msUntilNextDailyWindow } from './src/schedule.js'
import { AutoClawPool } from './src/autoclaw/pool.js'
import { createAutoClawAdapter } from './src/autoclaw/adapter.js'
import { readActiveAccountKey, restartAutoClaw, listSwitchableAccounts, writeActiveAccountKey } from './src/autoclaw/switch.js'
import { PROVIDER_ID as AUTOCLAW_PROVIDER_ID, PROVIDER_NAME as AUTOCLAW_PROVIDER_NAME } from './src/autoclaw/product.js'

/** 插件名（cordis 用它做 fiber 标识与日志前缀）。 */
export const name = 'teleagent-pool'

/** 唯一的硬依赖：没有 `llm` 就没有这个插件存在的意义。 */
export const inject = ['llm']

/**
 * 解析 `$DSH_HOME`。
 *
 * 不 import `@deepseek-ai/dsh-home-paths`：它与内核版本绑定，而规则本身只有三行。
 * 优先级：配置 > `$DSH_HOME` > `~/.dsh`。
 * ⚠️ 空白值当未设置（否则会把 home 解析成当前目录）。
 */
function resolveHome(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return path.resolve(explicit)
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** 读请求体（有上限，防止一条畸形请求把内存吃光）。 */
async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return undefined
  return JSON.parse(text)
}

/** 发 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 插件主体。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataHome?: string, autoCheckin?: boolean, strategy?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const home = resolveHome(config.dataHome)

  /** `credentials` 可能要等一会儿才出现，故用可变引用（nest inject 里补上）。 */
  let credentials
  let pool
  /**
   * 凭据服务的「就绪宽限期」截止时刻。
   *
   * `ctx.inject(['credentials'], …)` 在服务出现前一直 pending，而**绝大多数组合
   * 都有**它（`dsh-base` 就带）。所以不能让「此刻还没拿到」等价于「这个组合没有」——
   * 那会把 token 的存储方式在启动瞬间误判并**永久落盘**。
   */
  const CREDENTIALS_GRACE_MS = 60_000
  let credentialsGraceUntil = Date.now() + CREDENTIALS_GRACE_MS
  /** 自动签到巡检的定时器句柄（dispose 时清掉）。 */
  let checkinTimer
  /** AutoClaw 号池（惰性）。 */
  let autoclawPool

  /**
   * 建池。`credentials` 是否就绪决定 token 存哪：
   * 就绪 → 凭据库；未就绪 → 先按「凭据库」建池，若之后确认它永远不来，
   * `tokenStorage` 会在首次写入时被纠正并落盘（见 `ensureInlineFallback`）。
   */
  const buildPool = () => {
    pool ??= new AccountPool({ home, credentials, logger })
    return pool
  }

  /** AutoClaw 号池（惰性建；与 TeleAgent 池**分文件**存）。 */
  const buildAutoClawPool = () => {
    autoclawPool ??= new AutoClawPool({
      home,
      credentials,
      logger,
      autoClawDir: typeof config.autoclawDir === 'string' ? config.autoclawDir : undefined,
    })
    return autoclawPool
  }

  /**
   * 无 `credentials` 服务的组合：把存储方式降级为内联（一次性、持久化）。
   *
   * ⚠️ **必须给凭据服务一个就绪窗口**：`ctx.inject(['credentials'], …)` 是异步的，
   * 它在服务出现之前一直 pending。若在它落定前就判定「没有凭据服务」，启动后
   * 第一个 `/state` 请求就会把存储方式错误地改成内联 —— 而这份状态是**落盘**的，
   * 于是 token 从此写进插件 JSON（用户以为它在凭据库里）。
   * ⇒ 只有过了 {@link CREDENTIALS_GRACE_MS} 仍未拿到才降级；且拿到时会翻回来。
   */
  const ensureInlineFallback = () => {
    const current = buildPool()
    if (current.credentials !== undefined) return current
    if (current.store.state.tokenStorage === 'inline') return current
    if (Date.now() < credentialsGraceUntil) return current
    current.store.state.tokenStorage = 'inline'
    current.store.save()
    logger.warn?.(
      '[teleagent-pool] 本组合没有 credentials 服务 ⇒ token 改为内联存储在 '
      + `${path.join(current.store.dir, 'pool.json')}（文件权限 600）。`,
    )
    return current
  }

  // ── provider 注册 ──────────────────────────────────────────────────────
  const activePool = buildPool()
  const adapter = createAdapter({
    pool: activePool,
    warn: (message) => logger.warn?.(message),
  })
  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  ctx.effect(() => () => {
    registration()
  }, 'teleagent-pool: llm routes')

  // AutoClaw：模型目录照实播报（其推理端点被服务端 scope 握手挡住，见 src/autoclaw/adapter.js）
  const activeAutoClaw = buildAutoClawPool()
  const autoclawAdapter = createAutoClawAdapter({
    pool: activeAutoClaw,
    warn: (message) => logger.warn?.(message),
  })
  const autoclawRegistration = ctx.llm.registerAdapter([AUTOCLAW_PROVIDER_ID], autoclawAdapter)
  ctx.effect(() => () => {
    autoclawRegistration()
  }, 'teleagent-pool: autoclaw llm routes')

  // provider 出现在「模型设置」的可配置目录里（不影响能否用）。
  try {
    ctx.llm.registerConfigurableProviders?.([
      { provider: PROVIDER_ID, displayName: PROVIDER_NAME, settingsNs: name, settingsPath: [] },
      { provider: AUTOCLAW_PROVIDER_ID, displayName: AUTOCLAW_PROVIDER_NAME, settingsNs: name, settingsPath: [] },
    ])
  } catch (error) {
    logger.warn?.(`[teleagent-pool] registerConfigurableProviders 跳过：${error?.message ?? String(error)}`)
  }

  // ── 凭据服务（可选）────────────────────────────────────────────────────
  if (typeof ctx.inject === 'function') {
    ctx.inject(['credentials'], (scoped) => {
      credentials = scoped.credentials
      activePool.credentials = scoped.credentials
      activeAutoClaw.credentials = scoped.credentials
      // 有凭据服务：把存储方式纠正回 credentials（并发/上一次内联降级都会被翻回来）。
      if (activePool.store.state.tokenStorage !== 'credentials') {
        activePool.store.state.tokenStorage = 'credentials'
        activePool.store.save()
        logger.info?.('[teleagent-pool] credentials 服务已就绪 ⇒ token 改由凭据库管理')
      }
      if (activeAutoClaw.store.state.tokenStorage !== 'credentials') {
        activeAutoClaw.store.state.tokenStorage = 'credentials'
        activeAutoClaw.store.save()
      }
      scoped.effect(() => () => {
        credentials = undefined
      }, 'teleagent-pool: credentials lease')
    })
  } else {
    // 极简 cordis 替身（没有 `ctx.inject`）：直接按内联处理。
    credentialsGraceUntil = 0
    ensureInlineFallback()
    activeAutoClaw.store.state.tokenStorage = 'inline'
    activeAutoClaw.store.save()
  }

  // AutoClaw 启动扫描：零手工把本机已登录账号收进池（失败不致命 —— 用户可手动点）。
  if (activeAutoClaw.store.state.settings.autoScan === true && activeAutoClaw.store.state.accounts.length === 0) {
    const scanKickoff = setTimeout(() => {
      void activeAutoClaw.scanLocalAccounts({ skipBalance: false })
        .then((rows) => {
          if (rows.length > 0) {
            logger.info?.(`[teleagent-pool] AutoClaw 启动扫描：发现 ${rows.length} 个本机账号`)
          }
        })
        .catch((error) => {
          logger.warn?.(`[teleagent-pool] AutoClaw 启动扫描失败：${error?.message ?? String(error)}`)
        })
    }, 25_000)
    scanKickoff.unref?.()
    ctx.effect(() => () => {
      clearTimeout(scanKickoff)
    }, 'teleagent-pool: autoclaw startup scan')
  }

  // ── 每日自动签到（每天 09:00 UTC+8 全量，外加启动补签）───────────────
  /**
   * 跑一次自动签到并记录。
   *
   * ## 时机设计（三者的并集，缺一不可）
   *
   * | 时机 | 覆盖的场景 |
   * |---|---|
   * | **每天 09:00（UTC+8）** 一次性定时器 | 09:00 那一刻 DSH 开着 → 准时签 |
   * | **每 10 分钟巡检**（`inDailyWindow`） | 09:00 没开机、之后才打开 → 一旦过点就签 |
   * | **启动后 20 秒补签** | 昨天没开、今天开机在 09:00 之前 → 若当天已有可领项就顺手领掉 |
   *
   * ⚠️ 纯「固定钟点」会退化成「恰好那一刻开着才签」；纯「打开就签」会让
   * 「08:00 开机、之后不重启」的用户当天领不到（积分当天不领作废）。
   * 三者并集 + 池内「当天已成功」闸门 ⇒ 既不漏签也不重复签。
   */
  const runAutoCheckin = async (trigger) => {
    try {
      const checkinPool = ensureInlineFallback()
      if (checkinPool.store.state.accounts.length === 0) {
        return { ran: false, reason: 'empty', day: null, results: [] }
      }
      const outcome = await checkinPool.runAutoCheckin()
      if (outcome.ran) {
        const claimed = outcome.results.filter((row) => row.status === 'claimed').length
        logger.info?.(
          `[teleagent-pool] 自动签到（${trigger}）：${outcome.results.length} 个账号，`
          + `新领取 ${claimed} 个，${outcome.succeeded ? '本轮完成' : '本轮仍有失败（下次巡检再试）'}`,
        )
      }
      return outcome
    } catch (error) {
      logger.warn?.(`[teleagent-pool] 自动签到失败：${error?.message ?? String(error)}`)
      return { ran: false, reason: 'error', message: error?.message ?? String(error), results: [] }
    }
  }

  /**
   * 每日签到定时器。
   *
   * 两条并行：
   * 1. **精确 09:00（UTC+8）** 的一次性定时器 —— 到点签，并自行续订到明天；
   * 2. **每 10 分钟巡检** —— 只在「已过 09:00 且今天还没成功」时真正执行，
   *    覆盖「09:00 那刻没开机」的场景。
   * 外加启动后 20 秒补签一次（昨天没开、今天早开时立刻补上）。
   */
  const startCheckinTimer = () => {
    if (checkinTimer !== undefined) return
    let dailyHandle
    let hourlyHandle

    // 精确到下一个 UTC+8 09:00；不 unref 会阻止进程退出，故 unref + effect 清理。
    const scheduleDaily = () => {
      const delay = msUntilNextDailyWindow()
      dailyHandle = setTimeout(async () => {
        await runAutoCheckin('daily-09:00')
        if (checkinTimer !== undefined || dailyHandle !== undefined) scheduleDaily()
      }, delay)
      dailyHandle.unref?.()
    }
    scheduleDaily()

    // 巡检：每 10 分钟看一眼，只在已过 09:00 时才真跑（闸门在池里，成功过就跳过）。
    hourlyHandle = setInterval(() => {
      if (!inDailyWindow()) return
      void runAutoCheckin('tick')
    }, AUTO_CHECKIN_TICK_MS)
    hourlyHandle.unref?.()

    // 启动补签：别和内核启动抢 IO/网络，也别在凭据服务就绪前白跑。
    const kickoff = setTimeout(() => {
      void runAutoCheckin('startup')
    }, 20_000)
    kickoff.unref?.()

    checkinTimer = hourlyHandle
    ctx.effect(() => () => {
      clearTimeout(kickoff)
      if (dailyHandle !== undefined) clearTimeout(dailyHandle)
      if (hourlyHandle !== undefined) clearInterval(hourlyHandle)
      checkinTimer = undefined
    }, 'teleagent-pool: auto checkin timer')
  }
  startCheckinTimer()

  // ── 浏览器 API（可选）──────────────────────────────────────────────────
  /**
   * 注册 HTTP API。
   *
   * 路由是**前缀**：`/api/teleagent-pool/<action>`。客户端用同源 `fetch`，
   * 与设置页其余插件同一条路（Web UI 的鉴权由壳负责，插件不碰）。
   *
   * ⚠️ **两家号池共用一套动作名**，靠 `?pool=` 或 body 里的 `pool` 区分：
   * `pool=teleagent`（默认）| `pool=autoclaw`。这样设置页的两个 Tab
   * 走的是同一份前端代码，不用维护两套。
   */
  const apiHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.replace(/^\/api\/teleagent-pool\/?/u, '').replace(/\/+$/u, '')
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      const p = ensureInlineFallback()
      const z = buildAutoClawPool()
      // 号池选择：query 优先，其次 body（body 在下面读）。
      let poolName = url.searchParams.get('pool') ?? ''
      const pick = (body) => {
        const name = poolName !== '' ? poolName : (typeof body?.pool === 'string' ? body.pool : '')
        return name === AUTOCLAW_PROVIDER_ID ? 'autoclaw' : 'teleagent'
      }

      if (action === '' || action === 'state') {
        // 默认同时返回两家的摘要，前端切 Tab 时零延迟。
        return sendJson(res, 200, {
          ok: true,
          pools: {
            teleagent: {
              provider: { id: PROVIDER_ID, name: PROVIDER_NAME },
              loginUrl: LOGIN_PAGE,
              models: await adapter.listModels(PROVIDER_ID),
              ...p.snapshot(),
              // ⚠️ 必须放在 `...p.snapshot()` **之后**：快照里也有个 `checkin`（签到闸门状态），
              // 写前面会被它整个盖掉，前端就读不到「支持/不支持」这个能力位。
              checkin: {
                supported: true,
                scheduleHourUtc8: 9,
                ...p.snapshot().checkin,
              },
            },
            autoclaw: {
              provider: { id: AUTOCLAW_PROVIDER_ID, name: AUTOCLAW_PROVIDER_NAME },
              paths: z.localPaths(),
              ...z.snapshot(),
              models: z.catalogView().models,
              channels: z.catalogView().channels,
              catalogFallback: z.catalogView().fallback === true,
              // AutoClaw 没有每日签到：如实说，不给假按钮。
              checkin: z.checkinCapability(),
            },
          },
        })
      }

      if (action === 'login-url') {
        return sendJson(res, 200, { ok: true, loginUrl: LOGIN_PAGE })
      }

      // ── TeleAgent：粘贴 token 登录 ───────────────────────────────────
      if (action === 'accounts/add' && method === 'POST') {
        const body = await readBody(req)
        if (pick(body) === 'autoclaw') {
          return sendJson(res, 400, { ok: false, error: 'AutoClaw 不用粘贴 token：请在 AutoClaw 里登录后点「扫描本机账号」' })
        }
        const input = typeof body?.input === 'string' ? body.input : ''
        const parsed = parseLoginInput(input)
        if ('reason' in parsed) return sendJson(res, 400, { ok: false, error: parsed.reason })
        const account = await p.loginWithToken(parsed.token, {
          accountId: typeof body?.accountId === 'string' ? body.accountId : undefined,
        })
        return sendJson(res, 200, { ok: true, account: p.snapshot().accounts.find((row) => row.id === account.id), state: p.snapshot() })
      }

      // ── AutoClaw：扫描本机账号（零手工）─────────────────────────────
      if (action === 'autoclaw/scan' && method === 'POST') {
        const rows = await z.scanLocalAccounts({ skipBalance: false })
        await z.loadCatalog({ force: true }).catch(() => {})
        return sendJson(res, 200, {
          ok: true,
          scanned: rows.length,
          added: rows.filter((row) => row.isNew).length,
          results: rows,
          state: z.snapshot(),
        })
      }

      // ── AutoClaw：账号切换（本机账号目录层面）──────────────────────
      /**
       * 列出可切换账号 + 凭据备份情况。
       *
       * ⚠️「可切换」的判据是 **目录里有凭据，或保管目录里有备份**。
       * 客户端切号时会 `rm` 掉旧账号的 `account-credentials.enc`，
       * 所以「有备份」也算可切 —— 切回去时会自动还原，不用重新登录。
       */
      if (action === 'autoclaw/accounts') {
        const override = typeof config.autoclawDir === 'string' ? config.autoclawDir : undefined
        const accounts = listSwitchableAccounts({ userDataDir: override })
        const backups = z.listCredentialBackups()
        const backupKeys = new Set(backups.map((row) => row.accountKey))
        const enriched = accounts.map((row) => ({
          ...row,
          hasBackup: backupKeys.has(row.accountKey),
          // 有凭据，或者有备份（能还原）⇒ 可切
          switchable: (row.hasCredential || backupKeys.has(row.accountKey)) && !row.active,
        }))
        return sendJson(res, 200, {
          ok: true,
          activeKey: readActiveAccountKey({ userDataDir: override }),
          accounts: enriched,
          backups,
          keepRoot: z.keepRoot,
          // 能不能换号：至少要有 2 个「现在就能用」的账号
          switchAvailable: enriched.filter((row) => row.hasCredential || row.hasBackup).length >= 2,
          autoSwitchOnQuota: z.store.state.settings.autoSwitchOnQuota === true,
        })
      }

      /**
       * 手动备份当前账号凭据。
       *
       * 用户点一下就把凭据存进保管目录 —— 之后即便在 AutoClaw 里切走、
       * 客户端删了凭据，也还能切回来。
       */
      if (action === 'autoclaw/backup' && method === 'POST') {
        const body = await readBody(req) ?? {}
        const override = typeof config.autoclawDir === 'string' ? config.autoclawDir : undefined
        const accountKey = typeof body.accountKey === 'string' && body.accountKey !== ''
          ? body.accountKey
          : readActiveAccountKey({ userDataDir: override })
        if (accountKey === undefined || accountKey === '') {
          return sendJson(res, 400, { ok: false, error: '没有激活账号，且未指定 accountKey' })
        }
        const result = z.backupCredential(accountKey)
        return sendJson(res, result.ok ? 200 : 400, {
          ...result,
          backups: z.listCredentialBackups(),
        })
      }

      /**
       * 切换账号：备份当前凭据 → 改写指针 → 重启 AutoClaw。
       *
       * ⚠️ **必须重启客户端**（`account_switch_requires_restart` 是官方错误码），
       * 所以这一步会关掉用户正在用的 AutoClaw 窗口十几秒 —— 由调用方明确触发。
       *
       * 关键：切号前会把**当前**账号的凭据备份进保管目录
       * （客户端会 `rm` 掉它，不备份就回不来）。
       */
      if (action === 'autoclaw/switch' && method === 'POST') {
        const body = await readBody(req) ?? {}
        const accountKey = typeof body.accountKey === 'string' ? body.accountKey : ''
        if (accountKey === '') return sendJson(res, 400, { ok: false, error: '缺少 accountKey' })

        const override = typeof config.autoclawDir === 'string' ? config.autoclawDir : undefined
        const written = writeActiveAccountKey(accountKey, {
          userDataDir: override,
          keepRoot: z.keepRoot,
        })
        if (!written.ok) return sendJson(res, 400, { ok: false, error: written.reason })

        const restarted = await restartAutoClaw()
        return sendJson(res, 200, {
          ok: restarted.ok,
          pointerWritten: true,
          restoredFromBackup: written.restored === true,
          backup: written.backup,
          restart: restarted,
          backups: z.listCredentialBackups(),
          message: restarted.ok
            ? `已切换账号并重启 AutoClaw${written.restored === true ? '（凭据已从备份还原，无需重新登录）' : ''}`
            : `${restarted.reason ?? '重启未成功'} —— 指针已改，下次启动 AutoClaw 即生效`,
        })
      }

      if (action === 'accounts/remove' && method === 'POST') {
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const target = pick(body) === 'autoclaw' ? z : p
        const removed = await target.removeAccount(id)
        return sendJson(res, 200, { ok: true, removed, state: target.snapshot() })
      }

      if (action === 'accounts/toggle' && method === 'POST') {
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const target = pick(body) === 'autoclaw' ? z : p
        target.store.updateAccount(id, { enabled: body?.enabled !== false })
        return sendJson(res, 200, { ok: true, state: target.snapshot() })
      }

      if (action === 'settings' && method === 'POST') {
        const body = await readBody(req) ?? {}
        const target = pick(body) === 'autoclaw' ? z : p
        const patch = {}
        if (typeof body.autoCheckin === 'boolean') patch.autoCheckin = body.autoCheckin
        if (typeof body.autoScan === 'boolean') patch.autoScan = body.autoScan
        if (body.strategy === 'balance-desc' || body.strategy === 'round-robin') patch.strategy = body.strategy
        if (Number.isFinite(body.failureCooldown)) {
          patch.failureCooldown = Math.max(1, Math.min(20, Math.floor(body.failureCooldown)))
        }
        target.store.updateSettings(patch)
        return sendJson(res, 200, { ok: true, state: target.snapshot() })
      }

      if (action === 'balance/refresh' && method === 'POST') {
        const body = await readBody(req) ?? {}
        const target = pick(body) === 'autoclaw' ? z : p
        const results = await target.refreshBalance(typeof body.id === 'string' ? body.id : undefined)
        if (pick(body) === 'autoclaw') await z.loadCatalog({ force: true }).catch(() => {})
        return sendJson(res, 200, { ok: true, results, state: target.snapshot() })
      }

      if (action === 'checkin/status') {
        const id = url.searchParams.get('id') ?? ''
        if (id === '') return sendJson(res, 400, { ok: false, error: '缺少 id' })
        if (poolName === AUTOCLAW_PROVIDER_ID) {
          const capability = z.checkinCapability()
          return sendJson(res, 200, { ok: false, message: capability.reason, panel: null, supported: false })
        }
        const status = await p.checkinStatus(id)
        return sendJson(res, 200, { ok: status.ok, message: status.message, panel: status.panel, supported: true })
      }

      if (action === 'checkin/claim' && method === 'POST') {
        const body = await readBody(req) ?? {}
        if (pick(body) === 'autoclaw') {
          const capability = z.checkinCapability()
          return sendJson(res, 200, {
            ok: false,
            unsupported: true,
            message: capability.reason,
            results: [],
            state: z.snapshot(),
          })
        }
        if (typeof body.id === 'string' && body.id !== '') {
          const outcome = await p.claimOne(body.id)
          return sendJson(res, 200, { ok: outcome.status !== 'failed', outcome, state: p.snapshot() })
        }
        const results = await p.claimAll()
        return sendJson(res, 200, { ok: true, results, state: p.snapshot() })
      }

      if (action === 'checkin/auto-run' && method === 'POST') {
        const outcome = await runAutoCheckin('manual')
        return sendJson(res, 200, { ok: true, outcome, state: p.snapshot() })
      }

      if (action === 'autoclaw/catalog' && method === 'POST') {
        await z.loadCatalog({ force: true })
        return sendJson(res, 200, { ok: true, catalog: z.catalogView() })
      }

      return sendJson(res, 404, { ok: false, error: `未知的接口：${action || '(root)'}` })
    } catch (error) {
      logger.warn?.(`[teleagent-pool] API ${action} 失败：${error?.message ?? String(error)}`)
      return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix',
        path: '/api/teleagent-pool',
        handler: apiHandler,
      }), 'teleagent-pool: api routes')
    })
  }

  // ── 斜杠命令（可选）────────────────────────────────────────────────────
  /**
   * `/teleagent` —— 在会话里看池状态、手动签到。
   *
   * 设置页是主入口；这条命令是给「不想离开对话」的人准备的，也方便在没有
   * webServer 的 profile（headless/tui）里用。
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scoped) => {
      scoped.effect(() => scoped.commands.register({
        name: 'teleagent',
        description: 'TeleAgent 账号池：查看状态 / 一键签到（/teleagent [status|checkin|login]）',
        input: { hint: 'status | checkin | login' },
        async handler(invocation) {
          const verb = String(invocation.rawInput ?? '').trim().split(/\s+/u)[0] || 'status'
          const p = ensureInlineFallback()
          if (verb === 'login') {
            return { kind: 'success', text: `打开这个链接用天翼账号登录，然后在设置页粘贴含 token= 的回调链接：\n${LOGIN_PAGE}` }
          }
          if (verb === 'checkin') {
            const results = await p.claimAll()
            const lines = results.map((row) => `${row.nickname || row.accountId}：${row.message}`)
            return {
              kind: 'success',
              text: results.length === 0
                ? '账号池为空：先在设置页添加一个账号。'
                : `签到完成（${results.filter((row) => row.ok).length}/${results.length} 成功）\n${lines.join('\n')}`,
            }
          }
          const snapshot = p.snapshot()
          if (snapshot.accounts.length === 0) {
            return { kind: 'success', text: `账号池为空。\n登录页：${LOGIN_PAGE}` }
          }
          const lines = snapshot.accounts.map((account) => {
            const balance = account.balance === null ? '余额未知' : `余额 ${account.balance}`
            const checkin = account.lastCheckinDay === null
              ? '从未签到'
              : `${account.lastCheckinDay} ${account.lastCheckinResult || '已处理'}`
            return `· ${account.nickname}${account.enabled ? '' : '（已停用）'} — ${balance}；${checkin}`
          })
          return {
            kind: 'success',
            text: `TeleAgent 账号池：${snapshot.accounts.length} 个账号；自动签到${snapshot.settings.autoCheckin ? '已开' : '已关'}；`
              + `选号策略 ${snapshot.settings.strategy}\n${lines.join('\n')}`,
          }
        },
      }), 'teleagent-pool: command')
    })
  }

  logger.info?.(`[teleagent-pool] teleagent provider 已注册（账号池：${home}）`)
}

/** 供测试与外部集成使用的出口。 */
export { AccountPool } from './src/pool.js'
export { createAdapter } from './src/adapter.js'
export { parseLoginInput, decodeJwtExpMs } from './src/protocol.js'
export { utc8DayKey } from './src/pool.js'
export { AutoClawPool } from './src/autoclaw/pool.js'
export { createAutoClawAdapter } from './src/autoclaw/adapter.js'
export { listLocalAccounts, stripBearer } from './src/autoclaw/credential.js'
export { inDailyWindow, msUntilNextDailyWindow, msUntilDailyWindow, DAILY_CHECKIN_HOUR_UTC8 } from './src/schedule.js'
