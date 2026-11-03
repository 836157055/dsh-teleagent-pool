/**
 * HTTP 小工具：超时、错误归类、JSON 读取。
 *
 * 错误码沿用 DSH 的 provider-neutral 词表（`AUTH` / `QUOTA_EXCEEDED` /
 * `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）。
 *
 * @module dsh-teleagent-pool/src/http
 */

import { REQUEST_TIMEOUT_MS } from './product.js'

/** 把一个 HTTP 状态码映射成 DSH 的错误码。 */
export function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  // 402 是 TeleAgent「积分余额不足」的确定文案 —— 必须原样透出，
  // 归成 SERVER/AUTH 会让用户看不到「去充值/换号」这个唯一有效动作。
  if (status === 402) return 'QUOTA_EXCEEDED'
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'CLIENT_ERROR'
}

/** 提取错误体里可读的一段（保留原文，不做猜测性翻译）。 */
export function errorDetail(text) {
  const raw = typeof text === 'string' ? text : ''
  if (raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw)
    const message = parsed?.message ?? parsed?.msg ?? parsed?.error ?? parsed?.data?.message
    if (typeof message === 'string' && message.length > 0) {
      const code = parsed?.code ?? parsed?.error_code
      return code === undefined ? message : `${message} (code=${String(code)})`
    }
  } catch {
    // 非 JSON：原样返回
  }
  return raw.replace(/\s+/gu, ' ').trim().slice(0, 500)
}

/** 判断是否是签名类失败（`40301` / `40104`，两者文案都极具误导性）。 */
export function looksLikeSigningError(text) {
  if (/"?code"?\s*:\s*"?(40301|40104)"?/u.test(String(text))) return true
  return /unsupported sign version/iu.test(String(text))
}

/** 判断是否是传输层失败（可重试 / 可换号）。 */
export function isTransportError(error) {
  if (error === null || typeof error !== 'object') return false
  const name = String(error.name ?? '')
  const message = String(error.message ?? '')
  return name === 'AbortError'
    || name === 'TimeoutError'
    || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/iu.test(message)
}

/** 带超时的 fetch。 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const external = init.signal
  const onAbort = () => controller.abort()
  if (external !== undefined) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    if (external !== undefined) external.removeEventListener('abort', onAbort)
  }
}

/** 读 JSON（失败返回 undefined，不抛错）。 */
export async function readJson(response) {
  const text = await response.text().catch(() => '')
  if (text.length === 0) return { payload: undefined, text: '' }
  try {
    return { payload: JSON.parse(text), text }
  } catch {
    return { payload: undefined, text }
  }
}
