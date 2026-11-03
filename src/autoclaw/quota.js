/**
 * 额度耗尽识别（`quota_exhausted`）与「熔断」判定。
 *
 * ## 消息从哪来
 *
 * AutoClaw 桌面端把上游失败分类成 10 个 `diagnosticCode`，其中额度类叫
 * `quota_exhausted`。它的判定规则（`main.cjs` 原文）非常宽，**中英文都覆盖**：
 * ```js
 * /insufficient[_ -]?quota/i
 * /quota (?:exceeded|exhausted)/i
 * /(?:credit|balance|budget|billing).*(?:exhausted|insufficient|limit|required)/i
 * /(?:exhausted|insufficient).*(?:credit|balance|budget|quota)/i
 * /exceeded.*(?:credit|balance|budget|quota)/i
 * /余额不足|无可用资源包|请充值|资源包.*(?:用尽|耗尽|不足)/
 * /"code"\s*:\s*"?1113"/
 * ```
 *
 * ⚠️ 只按英文判会**漏掉全部中文额度错误**（而界面语言是中文时上游就回中文），
 * 所以这里把两套都抄下来，别自己重写一套更“简洁”的。
 *
 * ## 为什么「额度耗尽」必须区别对待
 *
 * 换号（下一个账号）与重试（同一个账号再来一次）是**两种完全不同的处置**：
 * 额度用光是**确定性失败**，重试只会把时间烧光。所以要能把它挑出来，
 * 转成「换一个账号」或「明确告诉用户该充钱/换号了」。
 *
 * @module dsh-teleagent-pool/src/autoclaw/quota
 */

/** 额度耗尽的关键词（中英双套，来自客户端原文）。 */
const QUOTA_PATTERNS = Object.freeze([
  /insufficient[_ -]?quota/iu,
  /quota\s*(?:exceeded|exhausted)/iu,
  /(?:credit|balance|budget|billing).*(?:exhausted|insufficient|limit|required)/iu,
  /(?:exhausted|insufficient).*(?:credit|balance|budget|quota)/iu,
  /exceeded.*(?:credit|balance|budget|quota)/iu,
  // ⚠️ 中文：界面语言是中文时上游就回中文，只判英文会全漏
  /余额不足/u,
  /无可用资源包/u,
  /请充值/u,
  /资源包.*(?:用尽|耗尽|不足)/u,
  /"code"\s*:\s*"?1113"?/u,
])

/** 限流（与额度不同：等一会儿就好，不该换号）。 */
const RATE_LIMIT_PATTERNS = Object.freeze([
  /rate[_ -]?limit/iu,
  /too many requests/iu,
  /\b429\b/u,
])

/** 判定文本是否表示「额度耗尽」。 */
export function looksLikeQuotaExhausted(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text))
}

/** 判定文本是否表示「被限流」。 */
export function looksLikeRateLimited(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 判定一个 `code` 字段是否额度类。
 *
 * ⚠️ 不能只认客户端那个精确的 `quota_exhausted` —— 上游/中间层还会给
 * `QUOTA_EXCEEDED` / `QUOTA` 这类变体（我在自测里就漏过 `QUOTA_EXCEEDED`）。
 * 也**不能**把 `rate_limited` 算进来：限流等一会儿就好，换号是错的处置。
 */
export function isQuotaDiagnosticCode(code) {
  if (typeof code !== 'string') return false
  const text = code.trim().toLowerCase().replace(/[_ -]+/gu, '_')
  if (text === 'quota_exhausted') return true
  if (text === 'quota_exceeded') return true
  if (text === 'quota') return true
  if (text === 'insufficient_quota') return true
  // 明确排除限流（同样常被写成 code，但处置完全不同）
  if (text === 'rate_limited' || text === 'rate_limit') return false
  return false
}

/**
 * 从一段错误对象里尽力提取「额度耗尽」的证据。
 *
 * 检查顺序：结构化字段 → 嵌套 message → 原文。
 * 任何一环命中就算命中（上游不同层会把同一个错误包成不同形状）。
 *
 * @param {unknown} source
 */
export function detectQuotaExhausted(source) {
  const seen = new Set()
  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > 6) return false
    if (typeof value === 'string') {
      if (seen.has(value)) return false
      seen.add(value)
      return looksLikeQuotaExhausted(value)
    }
    if (typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)

    const record = value
    // ① 结构化分类码优先
    for (const key of ['code', 'diagnosticCode', 'errorCode', 'failureCode', 'reason', 'kind']) {
      if (isQuotaDiagnosticCode(record[key])) return true
    }
    // ② 常见文案字段
    for (const key of ['message', 'detail', 'error', 'text', 'upstream']) {
      if (walk(record[key], depth + 1)) return true
    }
    // ③ 兜底：整个对象序列化后扫一遍（防止文案藏在没列到的键里）
    try {
      const text = JSON.stringify(value)
      if (text !== undefined && text.length < 20_000 && looksLikeQuotaExhausted(text)) return true
    } catch {
      // 循环引用等，忽略
    }
    return false
  }
  return walk(source, 0)
}
