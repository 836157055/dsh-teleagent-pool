/**
 * TeleAgent 模型适配器（`LlmAdapter` 结构实现）。
 *
 * ## 为什么用「结构实现」而不是 `extends LlmAdapter`
 *
 * `registerAdapter` 是靠**调用方法**校验的，不靠 `instanceof`；而
 * `@deepseek-ai/dsh-llm` 在本 profile 里没有 hoist 到插件可见的位置。
 * 自己实现 `providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` /
 * `stream` 这五个方法，插件就不钉死任何内核版本，换内核线也能挂上去。
 *
 * ## 账号池的失败转移（只在**首字节之前**）
 *
 * 请求先 `fetch`，拿到 `ok` 之后才开始 yield。于是「AUTH / 积分不足 / 限流 /
 * 传输失败」这些在响应到达时就已知的失败，可以**换下一个账号重试**，而不会出现
 * 「已经吐了半句话又换号」这种把两段回答拼在一起的灾难。
 * 流**中途**出错只能抛错（那时正文已经交给用户了）。
 *
 * @module dsh-teleagent-pool/src/adapter
 */

import {
  INFER_PATH,
  API_BASE,
  FALLBACK_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  INFER_FIRST_TOKEN_TIMEOUT_MS,
} from './product.js'
import { inferHeaders, isExpired } from './protocol.js'
import { PoolError, asPoolError } from './errors.js'
import { errorDetail, httpErrorCode, isTransportError, looksLikeSigningError } from './http.js'
import { consumeOpenAiSse, contentHasImage, serializeMessages } from './compat.js'

/** 这些失败码值得换下一个账号再试一次。 */
const FAILOVER_CODES = new Set(['AUTH', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'TRANSPORT', 'TIMEOUT', 'SERVER'])

/** 模型目录条目归一（远端与兜底共用形状）。 */
function entryFor(modelId) {
  return FALLBACK_MODELS.find((model) => model.id === modelId)
}

/** 模型声明的输入模态。 */
function modalitiesFor(modelId) {
  return entryFor(modelId)?.supportsImage === true ? ['text', 'image'] : ['text']
}

/**
 * TeleAgent 适配器。
 *
 * @param {object} options
 * @param {import('./pool.js').AccountPool} options.pool
 * @param {(message: string) => void} [options.warn]
 */
export function createAdapter(options) {
  const pool = options.pool
  const warn = options.warn ?? (() => {})

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_NAME }
    },

    /**
     * provider 自有的重试策略（**已解析**的完整对象，不是配置片段）。
     *
     * ⚠️ `maxRetries: 0`：本 provider 的失败几乎全是**账号级**的
     * （凭据失效 / 积分不足），重试同一个账号只会白烧时间；换号由 `stream` 自己做。
     * `retryableCodes` 仍要非空（内核校验），故只留真正瞬时的两个 —— 而它们
     * 也已经由换号逻辑吃掉了，这里留作兜底。
     */
    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: Object.freeze(['TRANSPORT', 'TIMEOUT']),
        initialDelayMs: 500,
        maxDelayMs: 4_000,
        jitterRatio: 0.2,
      })
    },

    async listModels(provider) {
      // ⚠️ 无已登录账号 ⇒ 返回 `[]`，让 DSH 隐藏整个 provider 分组。
      // **必须返回空数组而不是抛错**（抛错会在 UI 上多一条 provider 报错）。
      if (pool.selectableAccounts().length === 0) return []
      return FALLBACK_MODELS.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: modalitiesFor(model.id),
      }))
    },

    async resolveModel(provider, model) {
      const entry = entryFor(model)
      const resolved = {
        provider,
        id: model,
        name: entry?.name ?? model,
        inputModalities: modalitiesFor(model),
      }
      // 未知模型不编造窗口（`0` 是「未知」哨兵，必须判 `> 0`）。
      if (entry !== undefined && entry.contextWindow > 0) {
        resolved.context = { contextWindow: entry.contextWindow }
      }
      // 非法值必须过滤：0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS，
      // **整轮对话起不来**（不是降级，是崩）。
      const maxTokens = entry?.maxTokens
      if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
        resolved.defaultMaxTokens = maxTokens
      }
      // ⚠️ 不声明 `reasoning`：种子表没有档位，编档位就是造假。
      return resolved
    },

    /**
     * 把「模型解析」与「分发」绑定到同一次调用。
     *
     * ## ⚠️ 这个方法不是可选的（踩过的真实缺陷）
     *
     * 新一版 `LlmRuntime.prepareCall()`（打包在 DSH 的 `app.asar` 里）是这样做的：
     * ```js
     * const adapterCall = await registration.adapter.prepareCall(provider, model, signal)
     * const modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model)
     * // …
     * stream: (options) => … dispatch: (options) => adapterCall.stream(options)
     * ```
     * 而 `LlmAdapter` **基类并没有** `prepareCall`。于是只实现 `stream()` 的适配器
     * 会在**每一轮对话开始时**抛
     * `registration.adapter.prepareCall is not a function` —— 表现是「选了模型就报错、
     * 一句话都发不出去」，但 `listModels`/`resolveModel` 全都正常，很容易误判成
     * 模型目录问题。
     *
     * ⇒ 返回 `{ model, stream }`：
     * - `model` 必须是通过校验的**已解析模型信息**（含 `provider`/`id`/`name`，
     *   可选 `context`/`defaultMaxTokens`/`inputModalities`）；
     * - `stream` 是这一轮的**分发闭包**，绑定住当前适配器实例
     *   （HMR 换代时不会把上一代的模型能力配到新一代的端点上）。
     *
     * 注意签名是 `(provider, model, signal)` —— **不是**内核 `llm.prepareCall(config)`
     * 那个 `(config, signal)`。两者同名但不同层，写错会拿到一个对象而不是 provider 串。
     */
    async prepareCall(provider, model, signal) {
      const resolved = await adapter.resolveModel(provider, model, signal)
      return {
        model: resolved,
        stream: (options) => adapter.stream(options),
      }
    },

    /**
     * 流式请求：按账号池顺序尝试，失败转移，成功就直接流。
     *
     * @param {object} request - DSH 的完整请求（`GenerateOptions`）
     */
    async *stream(request) {
      const ordered = pool.orderedAccounts()
      if (ordered.length === 0) {
        // ⚠️ 不用 `AUTH`：客户端会把 AUTH 无条件显示成「API key is invalid」，
        // 而这里根本没有密钥的事 —— 是池里没账号。用 `NO_ADAPTER` 之外的语义码
        //（`UNSUPPORTED_CONTENT` 同样有「这条链路当前不可用」的意味，且不被特判）。
        throw new PoolError('teleagent: 账号池为空（先在设置页里添加一个账号）', 'UNSUPPORTED_CONTENT')
      }

      if (request.messages?.some?.((message) => contentHasImage(message.content)) === true) {
        throw new PoolError(
          'teleagent: 兜底模型目录声明不支持图片输入（未实测，保守取值）⇒ 明确报错而不是静默丢图',
          'UNSUPPORTED_CONTENT',
        )
      }

      const messages = serializeMessages(request.messages)
      if (typeof request.system === 'string' && request.system.length > 0) {
        messages.unshift({ role: 'system', content: request.system })
      }
      const tools = request.tools?.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))

      const body = { model: request.model, messages, stream: true, stream_options: { include_usage: true } }
      if (tools !== undefined && tools.length > 0) body.tools = tools
      if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
      if (request.temperature !== undefined) body.temperature = request.temperature
      if (Array.isArray(request.stop) && request.stop.length > 0) body.stop = request.stop

      const device = pool.deviceValues()
      const url = `${API_BASE}${INFER_PATH}`
      const failures = []

      /**
       * ⚠️ **先判签名能力，再发请求**。
       *
       * 3.0.0 客户端把 `X-SA-Signature` 升级成「必须用客户端主进程内存里的
       * sessionKey 签」——自造 key 一律 `40104/40105`。发一组必然无效的签名头，
       * 用户只会看到一句像配置错误的 401，而真正原因是「这条链路本插件没有钥匙」。
       *
       * ## ⚠️⚠️ 失败码**不能**用 `AUTH`
       *
       * DSH 的客户端投影（`dsh-client-runtime` 的 `displayFailureMessage`）有这么一行：
       * ```js
       * if (record.code === "AUTH") return "API key is invalid";
       * ```
       * 它把 `AUTH` **无条件**替换成这句固定文案，我们精心写的 `message` 一个字都到不了界面。
       * 这正是「选了电信模型 → 回复：API 密钥无效」的全部真相 —— 与密钥半点关系没有。
       *
       * ⇒ 用 `UNSUPPORTED_CONTENT`（语义正确：这条链路的签名能力不可用），
       * 它不在客户端的特判名单里，原文会如实透出。
       */
      const canSign = ordered.some((account) => account.trustedSignKey === true)
      if (!canSign) {
        throw new PoolError(
          'teleagent: 对话不可用 —— 推理端点要求用 TeleAgent 客户端**主进程内存里的 sessionKey** '
          + '签 X-SA-Signature，而这个值只经 SUPER_AGENT_LOCAL_SESSION_KEY 交给客户端自己的 Go 子进程，'
          + '落盘没有、进程外读不到。\n'
          + '实测：自造 key 会被拒为 40104 unsupported sign version / 40105 疑似攻击请求 '
          + '（2.5.3 时代「自造 key 也能过」在 3.0.0 上已不成立）。\n'
          + '积分余额与每日签到不受影响 —— 那是业务端点，只认 X-Token，不需要签名。',
          'UNSUPPORTED_CONTENT',
        )
      }

      for (const account of ordered) {
        const credential = await pool.readCredential(account.id)
        if (credential === undefined) {
          failures.push(`${account.nickname}: 没有可用 token`)
          continue
        }
        if (isExpired(credential)) {
          pool.markFailure(account.id, 'token 已过期（本 provider 无续期端点，需重新登录）', { permanent: true })
          failures.push(`${account.nickname}: token 已过期`)
          continue
        }

        let response
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: inferHeaders(credential, { ...device, trustedSignKey: account.trustedSignKey === true }, {
              method: 'POST',
              pathWithQuery: INFER_PATH,
            }),
            body: JSON.stringify(body),
            signal: request.signal ?? AbortSignal.timeout(INFER_FIRST_TOKEN_TIMEOUT_MS),
          })
        } catch (error) {
          if (isTransportError(error)) {
            // 传输层失败：不标记账号永久失败（通常是网络，不是账号问题）。
            pool.markFailure(account.id, `传输失败：${error?.message ?? String(error)}`)
            failures.push(`${account.nickname}: 传输失败`)
            continue
          }
          throw asPoolError(error, 'UNKNOWN')
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          // 402 是「积分余额不足」的确定文案 —— 必须原样透出。
          const code = httpErrorCode(response.status)
          const signingHint = looksLikeSigningError(text)
            ? '（这是**签名头**缺失/不被接受：服务端文案「版本过低」与版本号无关，不要去改 X-App-Version）'
            : ''
          const message = `teleagent: HTTP ${response.status}${text === '' ? '' : ` — ${errorDetail(text)}`}${signingHint}`
          pool.markFailure(account.id, message, { permanent: code === 'AUTH' || code === 'QUOTA_EXCEEDED' })
          failures.push(`${account.nickname}: HTTP ${response.status}`)
          if (FAILOVER_CODES.has(code)) continue
          throw new PoolError(message, code, { status: response.status })
        }

        // ✅ 请求成功：从这里开始 yield，之后不再换号。
        pool.markSuccess(account.id)
        pool.advanceCursor()
        try {
          yield* consumeOpenAiSse(response, { signal: request.signal }, {
            // 注入内核契约所需的两件东西，避免 compat.js 硬依赖某个内核版本：
            // `LlmError` 用本插件的 PoolError（自带 code + failure，能穿过
            // normalizeLlmFailure 保留失败码），`CallId` 是零成本品牌化。
            LlmError: PoolError,
            CallId: (id) => id,
            label: PROVIDER_ID,
          })
        } catch (error) {
          const code = error?.code ?? 'UNKNOWN'
          if (code === 'AUTH' || code === 'QUOTA_EXCEEDED') {
            pool.markFailure(account.id, `流中断：${error.message}`, { permanent: true })
          }
          throw error
        }
        return
      }

      // 所有账号都失败：把逐账号原因拼起来（否则用户只看到「失败了」）。
      const detail = failures.slice(0, 6).join('；')
      throw new PoolError(
        `teleagent: 账号池里所有账号都失败了${detail === '' ? '' : `（${detail}）`}。`
        + '常见原因：token 过期需重新登录、积分用光（余额不足）、或多账号同时被限流。',
        // ⚠️ 不用 `AUTH`：客户端会把 AUTH 无条件显示成「API key is invalid」，
        // 把上面这些话全部吃掉。用 `SERVER`（上游拒绝，语义正确且原文可透出）。
        'SERVER',
      )
    },
  }

  return adapter
}

export { PROVIDER_ID }
