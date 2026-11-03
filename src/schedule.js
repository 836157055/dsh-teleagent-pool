/**
 * 每天 **09:00（UTC+8）** 定时全量签到。
 *
 * ## 为什么不是「只在打开 DSH 时签」
 *
 * 打开时签到（v1 的做法）有个真实缺陷：如果用户每天 08:00 开机、09:00 之后
 * 一直不重开，那么「今天的积分」要等到第二天才领到 —— 而积分是**当天不领就作废**的。
 *
 * ## 为什么也不是纯「固定钟点」
 *
 * 定时器只在进程存活期间有效，DSH 不是常驻服务。纯固定钟点会退化成
 * 「恰好 09:00 那一刻开着才签」。
 *
 * ⇒ 两者**并集**：
 * | 时机 | 行为 |
 * |---|---|
 * | 启动后 20 秒 | 若今天还没签成功 → 立刻补签（跨天后的第一次开机会立刻补） |
 * | 每 10 分钟巡检 | 若「现在 ≥ 09:00」且今天还没成功 → 签（覆盖 09:00 那一刻没开机的场景） |
 * | 当天已成功 | 当天不再动（闸门在池里） |
 *
 * ⚠️ 日界与定时都用 **UTC+8 算术偏移**，不用本机时区 —— 与 `utc8DayKey` 同一条理由：
 * 额度是服务端按自己的账期结算的。
 *
 * @module dsh-teleagent-pool/src/autoclaw/schedule
 */

import { BILLING_UTC_OFFSET_MS } from './product.js'

/** 每日签到时刻（UTC+8 的 09:00）。 */
export const DAILY_CHECKIN_HOUR_UTC8 = 9

/** 巡检间隔。 */
export const CHECKIN_TICK_MS = 10 * 60_000

/**
 * 距今天（UTC+8）09:00 还有多少毫秒；已过则为 0。
 *
 * @param {number} now - 当前毫秒时间戳
 */
export function msUntilDailyWindow(now = Date.now(), hour = DAILY_CHECKIN_HOUR_UTC8) {
  const shifted = new Date(now + BILLING_UTC_OFFSET_MS)
  const localMs = ((shifted.getUTCHours() * 60 + shifted.getUTCMinutes()) * 60 + shifted.getUTCSeconds()) * 1000
  const target = hour * 60 * 60 * 1000
  return Math.max(0, target - localMs)
}

/**
 * 现在是否已进入今天的签到窗口（UTC+8 09:00 之后）。
 *
 * ⚠️ 不判「是不是同一分钟」：那会让「09:00 那一刻没开机」永远错过。
 * 只判**是否已过 09:00**，配合池里的「当天已成功」闸门，语义正确且不重复签。
 */
export function inDailyWindow(now = Date.now(), hour = DAILY_CHECKIN_HOUR_UTC8) {
  return msUntilDailyWindow(now, hour) === 0
}

/**
 * 到**下一个** UTC+8 09:00 的毫秒数（用于精确设一次性定时器）。
 *
 * @param {number} now
 */
export function msUntilNextDailyWindow(now = Date.now(), hour = DAILY_CHECKIN_HOUR_UTC8) {
  const today = msUntilDailyWindow(now, hour)
  if (today > 0) return today
  // 已过今天的 09:00 ⇒ 明天 09:00
  return 24 * 60 * 60 * 1000 - (
    ((new Date(now + BILLING_UTC_OFFSET_MS).getUTCHours() * 60
      + new Date(now + BILLING_UTC_OFFSET_MS).getUTCMinutes()) * 60
      + new Date(now + BILLING_UTC_OFFSET_MS).getUTCSeconds()) * 1000
    - hour * 60 * 60 * 1000
  )
}
