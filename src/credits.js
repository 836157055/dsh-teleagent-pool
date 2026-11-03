/**
 * TeleAgent 积分余额与每日签到。
 *
 * ## 端点与字段（全部取自 asar `hxe` 组件的逐字读取，不是猜的）
 *
 * | 事实 | 端点 | 字段 |
 * |---|---|---|
 * | 积分余额 | `GET /user/portal/companyStore/userCenter` | `current_points_balance` |
 * | 每日可领 | `GET …/companyStore/v2/checkDayTask` | `daily_task.daily_claimable_points` |
 * | 已领天数 | 同上 | `daily_task.total_claim_days` |
 * | 累计已领 | 同上 | `daily_task.total_claimed_points` |
 * | 今日已领 | 同上 | `daily_task.claimed_today` |
 * | **领取动作** | **`GET`** `…/companyStore/checkTask?type=daily_login` | 响应形状不解析 |
 *
 * ## 三条不许动的判据
 *
 * 1. **领取是 GET 不是 POST**（asar `Rn(...)` 即 `bM("GET", …)`），写 POST 会 404/405。
 * 2. **领取响应不解析**，领取后**重查面板**拿权威状态 —— 这样无论响应什么形状都对。
 * 3. **余额取不到字段时返回 `null`（查询失败），不是 `0`** —— 报 0 会让用户以为积分被清零。
 *
 * @module dsh-teleagent-pool/src/credits
 */

import {
  DAY_TASK_PATH,
  CHECK_TASK_PATH,
  CHECK_TASK_TYPE,
  USER_CENTER_PATH,
  REQUEST_TIMEOUT_MS,
} from './product.js'
import { absoluteUrl, businessHeaders } from './protocol.js'
import { fetchWithTimeout, readJson } from './http.js'

/** 读数字（同时接受数字与字符串 —— 金额字段常以字符串下发以规避浮点）。 */
function looseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 读布尔（认 `true/false` 与 `1/0`）。 */
function looseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return undefined
}

/** 取业务载荷：有 `data` 对象就用它，否则用顶层（信封形状未最终确认，两种都容忍）。 */
function unwrap(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const nested = payload.data
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? nested : payload
}

/** 带业务头的 GET，返回 `{ ok, payload, status, detail }`（不抛错）。 */
async function getJson(path, credential, pool, signal) {
  try {
    const response = await fetchWithTimeout(absoluteUrl(path), {
      method: 'GET',
      headers: businessHeaders(credential, pool),
      signal,
    }, REQUEST_TIMEOUT_MS)
    const { payload, text } = await readJson(response)
    if (!response.ok) {
      return { ok: false, status: response.status, detail: text.slice(0, 300) }
    }
    return { ok: true, status: response.status, payload }
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 查询积分余额。
 *
 * @returns `{ total: number }` 或 `null`（**查询失败**，不是 0 分）
 */
export async function fetchBalance(credential, pool = {}, signal) {
  const result = await getJson(USER_CENTER_PATH, credential, pool, signal)
  if (!result.ok) return null
  const data = unwrap(result.payload)
  const balance = looseNumber(data?.current_points_balance)
  if (balance === undefined) return null
  return { total: Math.round(balance * 100) / 100 }
}

/**
 * 查询签到面板。
 *
 * @returns `{ claimable, claimedToday, totalDays, totalPoints, buttonText, activityTitle }` 或 `null`
 */
export async function fetchCheckinPanel(credential, pool = {}, signal) {
  const result = await getJson(DAY_TASK_PATH, credential, pool, signal)
  if (!result.ok) return null
  const data = unwrap(result.payload)
  if (data === undefined) return null
  const dailyTask = typeof data.daily_task === 'object' && data.daily_task !== null ? data.daily_task : undefined
  const activity = typeof data.activity === 'object' && data.activity !== null ? data.activity : undefined
  if (dailyTask === undefined && activity === undefined) return null
  return {
    claimable: looseNumber(dailyTask?.daily_claimable_points) ?? 0,
    // 缺失 ⇒ false（保守：宁可让用户多点一次，也不误报「已领」而真的漏掉当天积分）
    claimedToday: looseBoolean(dailyTask?.claimed_today) ?? false,
    totalDays: looseNumber(dailyTask?.total_claim_days) ?? 0,
    totalPoints: looseNumber(dailyTask?.total_claimed_points) ?? 0,
    buttonText: typeof dailyTask?.button_text === 'string' ? dailyTask.button_text : '',
    activityTitle: typeof activity?.activity_title === 'string' ? activity.activity_title : '',
  }
}

/**
 * 领取每日签到。
 *
 * ⚠️ **GET**。领取响应不解析，随后重查面板 —— 面板说「已领」才算成功。
 *
 * @returns `{ status, message, credit }`，status ∈ `claimed | already | inactive | failed`
 */
export async function claimDaily(credential, pool = {}, signal) {
  const before = await fetchCheckinPanel(credential, pool, signal)
  if (before === null) {
    return { status: 'failed', message: '签到面板查询失败（凭据可能已失效）', credit: 0 }
  }
  if (before.claimedToday) {
    return { status: 'already', message: '今日已领', credit: 0 }
  }

  const claim = await getJson(`${CHECK_TASK_PATH}?type=${CHECK_TASK_TYPE}`, credential, pool, signal)
  if (!claim.ok) {
    // 402/余额类失败也走这里；文案必须透出，否则用户不知道发生了什么。
    return {
      status: 'failed',
      message: `领取请求失败（HTTP ${claim.status || '—'}）${claim.detail ? `：${claim.detail}` : ''}`,
      credit: 0,
    }
  }

  const after = await fetchCheckinPanel(credential, pool, signal)
  if (after === null) {
    return { status: 'failed', message: '领取请求已发送，但无法确认结果（面板查询失败），请稍后重试', credit: 0 }
  }
  if (!after.claimedToday) {
    // 领取后仍未标记已领：多半是「今天本来就没得领」或活动未开始。
    return { status: 'inactive', message: '领取后状态未变更（可能今日无可用签到，或活动未开始）', credit: 0 }
  }
  return {
    status: 'claimed',
    message: `已领取 ${before.claimable} 积分`,
    credit: before.claimable,
  }
}
