/**
 * AutoClaw 的 DSH 适配器。
 *
 * ## ✅ 推流**可用**（这一版是实测跑通的，不是推测）
 *
 * 走 AutoClaw 桌面端暴露的**本地配对协议**（`autoclaw-office-plugin` v2），
 * 而不是直接打上游 HTTP。后者试了 20+ 组合全部 406 —— 原因是上游要求
 * 客户端 `client_sign` 握手（密钥在握手期换出来，纯 HTTP 侧没有）。
 * 本地协议由桌面端**它自己**完成那一步，我们只消费结果。
 *
 * 完整链路见 `session.js` 与 `bridge.js` 的模块注释；核心是：
 * ```
 * 配对(WS+AES信封) → bootstrap(拿 model connection id) → subscribe → chat → run.events
 * ```
 *
 * ## 为什么不用 `listModels` 播报模型名
 *
 * `bootstrap` 返回的 `models[].id` 是 **UUID**（model connection id），
 * 与 `remote-snapshot.json` 里的 `zai_auto`/`zaicoding_glm-5.3` 是两套标识：
 * 前者给本地协议用，后者给上游 HTTP 用。**两者不能混**。
 * 因此：
 * - `listModels` 播报 `remote-snapshot` 的**可读 model 名**（用户能认出 GLM-5.3）；
 * - `stream` 内部再把名字映射到 bootstrap 里的 UUID。
 *
 * @module dsh-teleagent-pool/src/autoclaw/adapter
 */

import crypto from 'node:crypto'

import { contentHasImage, serializeMessages } from '../compat.js'
import { PoolError } from '../errors.js'
import { BridgeSession } from './session.js'
import { discoverInstances } from './instances.js'
import { detectQuotaExhausted } from './quota.js'
import { listSwitchableAccounts, restartAutoClaw, writeActiveAccountKey } from './switch.js'
import { PROVIDER_ID, PROVIDER_NAME } from './product.js'

/** 连接复用：一个进程内多个并发请求共享一条已配对连接。 */
const sessionPool = new WeakMap()

/**
 * 额度耗尽时的自动换号：改写指针 → 重启 AutoClaw → 等它拉起。
 *
 * ⚠️ 这**不是**「无痛」操作：重启会把用户的 AutoClaw 窗口关掉再开。
 * 所以只有 `settings.autoSwitchOnQuota === true` 才会走到这里（默认关闭）。
 *
 * @param {import('./pool.js').AutoClawPool} pool
 * @param {{ warn?: Function, info?: Function }} logger
 */
async function switchAndRetry(pool, logger) {
  const accounts = listSwitchableAccounts({ userDataDir: pool.autoClawDir })
  const target = accounts.find((account) => account.switchable)
  if (target === undefined) {
    const withCredential = accounts.filter((account) => account.hasCredential)
    return {
      ok: false,
      reason: withCredential.length <= 1
        ? '只有 1 个账号有凭据 ⇒ 无号可换。请先在 AutoClaw 里登录另一个账号（要真正登录成功，生成 account-credentials.enc）'
        : '没有其他可切换的账号（其余账号都缺凭据文件）',
    }
  }

  logger?.info?.(`[autoclaw] 额度耗尽 ⇒ 自动切到 ${target.phone || target.accountKey.slice(0, 10)}`)
  const written = writeActiveAccountKey(target.accountKey, { userDataDir: pool.autoClawDir })
  if (!written.ok) return { ok: false, reason: written.reason }

  const restarted = await restartAutoClaw()
  if (!restarted.ok) {
    // 指针已经改好了：下次用户手动开 AutoClaw 就会用新账号
    return { ok: false, reason: `${restarted.reason}（指针已改，下次启动即生效）` }
  }

  // 等 office-plugin 重新监听（配对靠它）
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const instances = await discoverInstances({ timeoutMs: 800 }).catch(() => [])
    if (instances.length > 0) {
      logger?.info?.('[autoclaw] 客户端已重新拉起，继续用新账号')
      return { ok: true, accountKey: target.accountKey }
    }
  }
  return { ok: false, reason: '重启后 25 秒内没等到 office-plugin 就绪（指针已改，可手动重开 AutoClaw）' }
}

/** bootstrap 里的 `models` 缓存（每次连接取一次）。 */
const bootstrapCache = new WeakMap()

/**
 * 取（或建）一条已配对连接，并返回它的 bootstrap 结果。
 *
 * ## 多实例：这才是「换号」的唯一实现方式
 *
 * 桌面端**只有一个激活账号**，且本地协议**没有切号操作**
 * （`hds` 的 31 项 operation 里没有任何一项能换号），切号还必须重启进程
 * （`account_switch_requires_restart`）。所以在单实例下，「池里有额度账号」
 * 与「对话用哪个账号」是两件事 —— 后者由桌面端决定。
 *
 * ⇒ 想真正换号，只能换**实例**：多开 AutoClaw（不同 userData → 各自登录不同账号），
 * 这里扫描所有实例、逐个配对，按额度顺序选用。
 *
 * @param {import('./pool.js').AutoClawPool} pool
 * @param {{ warn?: Function, info?: Function }} logger
 * @param {{ forceInstanceId?: string }} [options]
 */
async function ensureSession(pool, logger, options = {}) {
  const cached = sessionPool.get(pool)
  if (cached !== undefined && cached.sessions.size > 0) {
    // 已配对过：优先用调用方指定的实例，否则用当前「正在用」的那个
    const wanted = options.forceInstanceId ?? cached.currentInstanceId
    const hit = cached.sessions.get(wanted)
    if (hit !== undefined && hit.session.connectionId !== null) return hit
  }

  const instances = await discoverInstances({ timeoutMs: 1_200 })
  if (instances.length === 0) {
    throw new PoolError(
      'autoclaw: 没有找到正在运行的 AutoClaw 桌面端（127.0.0.1:3917 起）。'
      + '请先打开 AutoClaw 并登录。',
      'TRANSPORT',
    )
  }

  const sessions = new Map()
  const failures = []
  for (const instance of instances) {
    const session = new BridgeSession({ discovery: instance, logger })
    try {
      await session.connect()
      const bootstrap = await session.request('bootstrap', { documentId: '' })
      sessions.set(instance.instanceId, { session, bootstrap, instance, accountId: session.accountId })
      logger?.info?.(
        `[autoclaw] 实例 ${String(instance.instanceId).slice(0, 8)} @${instance.discoveryPort} 配对成功：`
        + `account=${String(session.accountId).slice(0, 10)} models=${(bootstrap?.models ?? []).length}`,
      )
    } catch (error) {
      failures.push(`${instance.discoveryPort}: ${error?.message ?? String(error)}`)
      session.close()
    }
  }

  if (sessions.size === 0) {
    throw new PoolError(
      `autoclaw: 找到 ${instances.length} 个桌面端实例但都配对失败（${failures.slice(0, 3).join('；')}）`,
      'AUTH',
    )
  }

  const ordered = [...sessions.entries()]
  const currentInstanceId = ordered[0][0]
  const fresh = { sessions, currentInstanceId, instances }
  sessionPool.set(pool, fresh)
  return fresh.sessions.get(currentInstanceId)
}

/**
 * 把可读 model 名（`zaicoding_glm-5.3`）映射到 bootstrap 的 UUID。
 *
 * bootstrap 给的 `models[].name` 是 `GLM-5.3` / `Auto` 这类可读名，
 * 而 `id` 是 UUID。两者经由 **`name`** 对上号：
 * ```
 * zaicoding_glm-5.3  →  name "GLM-5.3"  →  bootstrap 里 name==="GLM-5.3" 的 id
 * ```
 * 找不到时返回 `undefined`，让服务端用它自己的默认模型（不要瞎猜一个 UUID）。
 */
export function mapModelNameToConnectionId(catalogName, bootstrapModels) {
  const rows = Array.isArray(bootstrapModels) ? bootstrapModels : []
  if (rows.length === 0) return undefined

  // ① 直接同名（有些部署会直接用可读名当 id）
  const direct = rows.find((row) => row.id === catalogName)
  if (direct !== undefined) return direct.id

  // ② 目录名 `zaicoding_glm-5.3` → 可读名 `GLM-5.3`
  const tail = String(catalogName).replace(/^(?:zaicoding_|zai_)/u, '')
  const byName = rows.find((row) => String(row.name).toLowerCase() === tail.toLowerCase())
  if (byName !== undefined) return byName.id

  // ③ 模糊：GLM-5.3 <-> glm-5.3 / GLM-5.3-Flash <-> glm-5.3-flash
  const normalized = tail.toLowerCase().replace(/[-_.]/gu, '')
  const fuzzy = rows.find((row) => String(row.name).toLowerCase().replace(/[-_.]/gu, '') === normalized)
  if (fuzzy !== undefined) return fuzzy.id

  return undefined
}

/**
 * 建 AutoClaw 适配器。
 *
 * @param {object} options
 * @param {import('./pool.js').AutoClawPool} options.pool
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 */
export function createAutoClawAdapter(options) {
  const pool = options.pool
  const logger = options.logger

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_NAME }
    },

    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        // 失败几乎都是「桌面端没开 / 配对过期 / 上游问题」，重试同一次意义不大。
        maxRetries: 0,
        retryableCodes: Object.freeze(['TRANSPORT', 'TIMEOUT']),
        initialDelayMs: 500,
        maxDelayMs: 4_000,
        jitterRatio: 0.2,
      })
    },

    async listModels(provider) {
      // 无已登录账号 ⇒ 空目录，让 DSH 隐藏该分组（**返回空数组而不是抛错**）。
      if (pool.selectableAccounts().length === 0) return []
      const catalog = await pool.loadCatalog()
      return catalog.models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: model.supportsImage ? ['text', 'image'] : ['text'],
      }))
    },

    async resolveModel(provider, model) {
      const catalog = await pool.loadCatalog()
      const entry = catalog.models.find((row) => row.id === model)
      const resolved = {
        provider,
        id: model,
        name: entry?.name ?? model,
        inputModalities: entry?.supportsImage === true ? ['text', 'image'] : ['text'],
      }
      if (entry !== undefined && entry.contextWindow > 0) {
        resolved.context = { contextWindow: entry.contextWindow }
      }
      const maxTokens = entry?.maxTokens
      if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
        resolved.defaultMaxTokens = maxTokens
      }
      return resolved
    },

    /**
     * 绑定「模型解析 + 分发」到同一次调用。
     *
     * ⚠️ 必须实现：新版内核的 `LlmRuntime.prepareCall()` 会调
     * `registration.adapter.prepareCall(...)`，基类没有这个方法。
     * 缺它的表现是每轮对话都抛 `adapter.prepareCall is not a function`。
     */
    async prepareCall(provider, model, signal) {
      const resolved = await adapter.resolveModel(provider, model, signal)
      return {
        model: resolved,
        stream: (opts) => adapter.stream(opts),
      }
    },

    /**
     * 推流：走桌面端本地配对协议。
     *
     * @param {object} request - DSH 的 GenerateOptions
     */
    async *stream(request) {
      if (pool.selectableAccounts().length === 0) {
        // ⚠️ 不用 `AUTH`（客户端会把它显示成「API key is invalid」，与事实不符）。
        throw new PoolError(
          'autoclaw: 账号池为空（打开 AutoClaw 登录后点「扫描本机账号」）',
          'UNSUPPORTED_CONTENT',
        )
      }

      if (contentHasImage(request.messages?.[0]?.content) === true
        || request.messages?.some?.((message) => contentHasImage(message.content)) === true) {
        const catalog = await pool.loadCatalog()
        const entry = catalog.models.find((row) => row.id === request.model)
        if (entry?.supportsImage !== true) {
          throw new PoolError(`autoclaw: 模型 "${request.model}" 未声明图片输入`, 'UNSUPPORTED_CONTENT')
        }
      }

      // ① 把 DSH 的多段消息压成一段纯文本（本地协议只收 `message` 字符串）
      const text = buildPromptText(request)
      if (text.length === 0) {
        throw new PoolError('autoclaw: 消息内容为空', 'UNSUPPORTED_CONTENT')
      }

      // ② 建连 / 复用，拿 bootstrap
      let entry
      try {
        entry = await ensureSession(pool, logger, {
          forceInstanceId: pool.store.state.settings.preferInstanceId,
        })
      } catch (error) {
        sessionPool.delete(pool)
        if (error instanceof PoolError) throw error
        throw new PoolError(
          `autoclaw: 连接桌面端失败 —— ${error?.message ?? String(error)}。`
          + '请确认 AutoClaw 桌面端正在运行并已登录。',
          'TRANSPORT',
        )
      }

      // ③ 跑一轮：额度耗尽时**换实例**再试
      //
      // ## 为什么换的是「实例」而不是「池里的账号」
      //
      // 桌面端只有一个激活账号，本地协议没有切号 operation，且切号要重启进程。
      // 所以池里多存账号并不会让这一轮换号 —— 能换的只有**多开的实例**。
      // 单实例时这里会退化为「用尽即报错」，并如实说明该怎么做。
      const cached = sessionPool.get(pool)
      const tried = new Set()
      let lastError
      let lastQuota = false
      /** 只允许自动换号一次，避免 A→B→A 死循环。 */
      let switchedOnce = false

      const candidates = [entry]
      if (cached !== undefined) {
        for (const [instanceId, hit] of cached.sessions) {
          if (instanceId !== cached.currentInstanceId) candidates.push(hit)
        }
      }

      for (const candidate of candidates) {
        const instanceId = String(candidate.instance?.instanceId ?? candidate.session?.accountId ?? '')
        if (instanceId !== '' && tried.has(instanceId)) continue
        if (instanceId !== '') tried.add(instanceId)

        // 目录名 → bootstrap UUID（每个实例的 UUID 不同，必须各自映射）
        const connectionId = mapModelNameToConnectionId(request.model, candidate.bootstrap?.models)
        if (connectionId === undefined) {
          logger?.warn?.(
            `[autoclaw] 模型 "${request.model}" 在该实例的 bootstrap 里没有对应连接，交给服务端用默认模型`,
          )
        }

        const callId = String(request.callId ?? crypto.randomUUID())
        let index = 0
        let textBlockIndex = -1
        let reasoningBlockIndex = -1
        let sawOutput = false
        /** 累积正文/思考，用于 block-end 时的完整 block。 */
        let textAccum = ''
        let reasoningAccum = ''

        const openTextBlock = () => {
          if (textBlockIndex !== -1) return null
          textBlockIndex = index
          index += 1
          // ⚠️⚠️ 字段名必须是 `blockType`，**不是** `kind`。
          // 内核与客户端都读 `chunk.blockType`：
          //   blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
          // 写成 `kind` 会得到 emptyAssistantBlock(undefined)，下一步读它的
          // `.type` 就抛 `Cannot read properties of undefined (reading 'type')`。
          // 这个错误发生在**客户端**，表现是「界面报错，但 AutoClaw 那边明明回复成功」。
          return { type: 'block-start', index: textBlockIndex, blockType: 'text' }
        }
        const openReasoningBlock = () => {
          if (reasoningBlockIndex !== -1) return null
          reasoningBlockIndex = index
          index += 1
          return { type: 'block-start', index: reasoningBlockIndex, blockType: 'reasoning' }
        }

        let quotaHit = false
        try {
          for await (const chunk of candidate.session.chat({
            message: text,
            model: connectionId,
            // ⚠️ documentId 每轮唯一：复用会让后续轮次产出 0 块。
            documentId: `dsh-${callId}`,
            signal: request.signal,
          })) {
            if (chunk.kind === 'text') {
              const open = openTextBlock()
              if (open !== null) yield open
              sawOutput = true
              textAccum += chunk.text
              yield { type: 'text-delta', index: textBlockIndex, text: chunk.text }
              continue
            }
            if (chunk.kind === 'reasoning') {
              const open = openReasoningBlock()
              if (open !== null) yield open
              reasoningAccum += chunk.text
              yield { type: 'reasoning-delta', index: reasoningBlockIndex, text: chunk.text }
              continue
            }
            if (chunk.kind === 'error') {
              // ⚠️ 额度耗尽要能认出来 —— 它与「网络抖一下」处置完全不同：
              // 重试同账号只会烧时间，必须换实例或直接告诉用户。
              if (detectQuotaExhausted(chunk.detail)) {
                quotaHit = true
                lastQuota = true
                lastError = new PoolError(
                  `autoclaw: 账号额度已用尽 —— ${chunk.detail}`,
                  'QUOTA',
                )
                break
              }
              throw new PoolError(`autoclaw: ${chunk.detail}`, 'SERVER')
            }
            // status/notice 不投影成内容块（DSH 没有对应类型）
          }
        } catch (error) {
          sessionPool.delete(pool)
          if (error instanceof PoolError) {
            lastError = error
            lastQuota = error.code === 'QUOTA' || detectQuotaExhausted(error.failure)
            if (!lastQuota) throw error
            break
          }
          const wrapped = new PoolError(
            `autoclaw: 对话失败 —— ${error?.message ?? String(error)}`,
            detectQuotaExhausted(error) ? 'QUOTA' : 'SERVER',
          )
          lastError = wrapped
          lastQuota = wrapped.code === 'QUOTA'
          if (!lastQuota) throw wrapped
          break
        }

        if (quotaHit) {
          // 把「这个实例额度空了」记到池上，UI 能看到，也避免下次又从它开始
          const accountId = candidate.session?.accountId
          if (typeof accountId === 'string' && accountId.length > 0) {
            pool.store.updateAccount(
              pool.store.findByAccountId(accountId)?.id ?? '',
              { lastError: '额度已用尽', lastErrorAt: Date.now() },
            )
          }

          // ⚠️ 自动换号是**显式开关**（默认关）：它要重启 AutoClaw，
          // 会打断用户正在做的事，不能悄悄做。
          if (pool.store.state.settings.autoSwitchOnQuota === true && !switchedOnce) {
            switchedOnce = true
            const outcome = await switchAndRetry(pool, logger)
            if (outcome.ok) {
              // 换号成功：清掉缓存，递归重来一轮（新账号、新实例）
              sessionPool.delete(pool)
              yield* adapter.stream(request)
              return
            }
            logger?.warn?.(`[autoclaw] 自动换号未成功：${outcome.reason ?? '未知原因'}`)
          }

          logger?.warn?.(`[autoclaw] 实例 ${instanceId.slice(0, 8)} 额度用尽，尝试下一个实例`)
          continue
        }

        // 收尾：一个字都没有 = 静默失败
        if (!sawOutput) {
          throw new PoolError(
            'autoclaw: 桌面端没有返回任何正文（可能被安全策略拦下，或模型只回了思考）',
            'EMPTY_RESPONSE',
          )
        }

        // ⚠️ 这一轮真的成功了 ⇒ 把历史失败清掉。
        // 之前完全没调 `markSuccess`（改桥接实现时漏了），于是「上次失败：…」这条
        // **永远**留在 `autoclaw.json` 里，界面一直红着 —— 那不是 UI 缓存，是落盘旧状态。
        if (typeof candidate.session?.accountId === 'string') {
          const account = pool.store.findByAccountId(candidate.session.accountId)
          if (account !== undefined) pool.markSuccess(account.id)
        }

        if (textBlockIndex !== -1) {
          // ⚠️⚠️ block-end 必须带 `block` 对象，且 `block.type` 指向该块类型。
          // 内核原文：
          //   case 'block-end': {
          //     const partial = this.ensure(chunk.index, chunk.block.type);   // ← 读 chunk.block.type
          //     partial.block = chunk.block;
          //   }
          // 只发 `{type:'block-end', index}` 时 `chunk.block` 是 undefined，
          // 于是抛 `Cannot read properties of undefined (reading 'type')` ——
          // 这就是「界面报错、但 AutoClaw 明明回复成功」的真正原因。
          yield {
            type: 'block-end',
            index: textBlockIndex,
            block: { type: 'text', text: textAccum },
          }
        }
        if (reasoningBlockIndex !== -1) {
          yield {
            type: 'block-end',
            index: reasoningBlockIndex,
            block: { type: 'reasoning', text: reasoningAccum },
          }
        }
        yield { type: 'finish', reason: { kind: 'stop' }, callId }
        return
      }

      // 所有实例都试过：给出能执行的结论
      if (lastQuota) {
        const instanceCount = cached?.sessions?.size ?? 1
        throw new PoolError(
          'autoclaw: 所有桌面端实例的额度都已用尽。'
          + (instanceCount <= 1
            ? '当前只检测到 1 个 AutoClaw 实例，而对话固定用该实例的激活账号 —— '
              + '换号需要在 AutoClaw 里切换账号并**重启客户端**（协议没有远程切号能力），'
              + '或者再开一个 AutoClaw 实例登录另一个账号（本插件会自动发现并轮换）。'
            : '已尝试全部实例。充值或换用其他账号。'),
          'QUOTA',
          { instances: instanceCount },
        )
      }

      throw lastError ?? new PoolError('autoclaw: 对话失败（无可用实例）', 'SERVER')
    },
  }

  return adapter
}

/**
 * 把 DSH 的消息数组压成一段纯文本。
 *
 * ⚠️ 本地协议只收一个 `message` 字符串（它是给 Word 插件用的），
 * 所以多轮历史必须**内联**进这一段。
 *
 * ## ⚠️⚠️ 绝不把 `request.system` 转发出去
 *
 * 一开始我把 `request.system` 原样拼进了 prompt，结果 AutoClaw 那边能看到
 * 完整的 DSH 运行时指令（`<project_instructions>`、模式声明、工具规则…）。
 * 这有两个实打实的问题：
 *
 * 1. **泄露运行时指令**：那是本机 DSH 的内部配置，不该出现在第三方服务商的会话记录里
 *    （它会长期存在对方服务器上，用户也能在客户端里翻阅）。
 * 2. **污染对方模型的身份判断**：那段文字里有「你是 XXX」「你必须…」这类自我声明，
 *    对方模型会照着扮演，输出就不再是它自己 —— 用户看到的答复会变得莫名其妙。
 *
 * ⇒ 只转发**真实对话内容**（user / assistant 轮次）。系统指令留在本机。
 */
export function buildPromptText(request) {
  const parts = []
  // 注意：**不** push request.system（见上面的长注释）
  const messages = serializeMessages(request.messages ?? [])
  for (const message of messages) {
    // system 轮次同样跳过（它属于运行时指令，不是对话内容）
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    parts.push(`${role}: ${message.content}`)
  }
  return parts.join('\n\n').trim()
}

export { PROVIDER_ID }
