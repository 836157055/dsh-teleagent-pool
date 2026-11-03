/**
 * 与内核无关的错误与品牌化 aid。
 *
 * ## 为什么要自己造一个 `LlmError` 形状
 *
 * `LlmRuntime` 把适配器抛出的任何东西归一成终止失败块，但**只有**
 * `instanceof HarnessError` 才保留 `code`（否则一律 `UNKNOWN`，AUTH / QUOTA
 * 这些关键分类就丢了，用户看到的是「未知错误」，重试策略也无从判断）。
 *
 * 直接 `import { LlmError } from '@deepseek-ai/dsh-llm'` 又会把插件钉死在某个
 * 内核版本上（本 profile 的 `@deepseek-ai/*` 并未 hoist 到插件可见的位置）。
 *
 * ⇒ 用内核**自己公开的判据**绕过这个绑定：`normalizeLlmFailure` 优先读
 * **自有数据属性** `failure`，只要它的 `code` 与自有 `code` 一致就直接采用
 * （`ownFailureSnapshot` / `ownErrorCode`）。于是这里定义的自有属性即可让
 * 失败码完整穿过边界，不需要任何版本内省。
 *
 * @module dsh-teleagent-pool/src/errors
 */

/**
 * 带自有 `code` + `failure` 的 LLM 错误。
 *
 * @param {string} message - 面向用户的完整说明
 * @param {string} code - provider-neutral 失败码（AUTH / QUOTA_EXCEEDED / RATE_LIMIT / SERVER / …）
 * @param {{ status?: number, cause?: unknown }} [options]
 */
export class PoolError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PoolError'
    /** 自有数据属性：`ownErrorCode()` 会读它。 */
    this.code = code
    /** 自有数据属性：`normalizeLlmFailure()` 会读它并校验形状。 */
    this.failure = Object.freeze({
      message: message.length > 0 ? message : 'teleagent: unknown failure',
      code: code.length > 0 ? code : 'UNKNOWN',
      ...(typeof options.status === 'number' && Number.isInteger(options.status)
        && options.status >= 100 && options.status <= 599
        ? { status: options.status }
        : {}),
    })
  }
}

/**
 * 把任意内部错误转成 `PoolError`（保留已经带码的那些）。
 *
 * @param {unknown} error
 * @param {string} fallbackCode
 */
export function asPoolError(error, fallbackCode = 'UNKNOWN') {
  if (error instanceof PoolError) return error
  const message = error instanceof Error && error.message ? error.message : String(error)
  return new PoolError(message, fallbackCode, { cause: error })
}
