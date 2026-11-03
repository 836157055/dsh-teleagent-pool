/**
 * 每日 09:00（UTC+8）签到窗口判定。
 *
 * 这些断言锁的是**日界与时区**：算错一天就是漏签或多签，而漏签的积分当天作废。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAILY_CHECKIN_HOUR_UTC8,
  inDailyWindow,
  msUntilDailyWindow,
  msUntilNextDailyWindow,
} from '../src/schedule.js'

/** 造一个 UTC+8 的某时刻。 */
function utc8(hour, minute = 0, second = 0, day = '2026-11-02') {
  return Date.parse(`${day}T${String(hour - 8).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`)
}

test('09:00 前的窗口判定为「未进入」，09:00 后为「已进入」', () => {
  assert.equal(inDailyWindow(utc8(8, 59, 59)), false)
  assert.equal(inDailyWindow(utc8(9, 0, 0)), true)
  assert.equal(inDailyWindow(utc8(9, 0, 1)), true)
  assert.equal(inDailyWindow(utc8(23, 59, 59)), true)
  assert.equal(inDailyWindow(utc8(0, 0, 0, '2026-11-03')), false)
})

test('msUntilDailyWindow 在 08:00 时应为 1 小时，过点后为 0', () => {
  assert.equal(msUntilDailyWindow(utc8(8, 0, 0)), 60 * 60 * 1000)
  assert.equal(msUntilDailyWindow(utc8(8, 30, 0)), 30 * 60 * 1000)
  assert.equal(msUntilDailyWindow(utc8(9, 0, 0)), 0)
  assert.equal(msUntilDailyWindow(utc8(15, 0, 0)), 0)
})

test('msUntilNextDailyWindow 指向下一个 09:00（跨天正确）', () => {
  // 08:00 → 1 小时后
  assert.equal(msUntilNextDailyWindow(utc8(8, 0, 0)), 60 * 60 * 1000)
  // 09:00 整 → 已到点，指向明天 09:00（24 小时）
  assert.equal(msUntilNextDailyWindow(utc8(9, 0, 0)), 24 * 60 * 60 * 1000)
  // 10:00 → 23 小时后
  assert.equal(msUntilNextDailyWindow(utc8(10, 0, 0)), 23 * 60 * 60 * 1000)
  // 23:00 → 10 小时后
  assert.equal(msUntilNextDailyWindow(utc8(23, 0, 0)), 10 * 60 * 60 * 1000)
})

test('窗口判定不受本机时区影响（用的是 UTC+8 算术偏移）', () => {
  // 同一时刻，无论进程 TZ 如何，判定必须一致。
  const at = utc8(9, 5, 0)
  const before = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const a = inDailyWindow(at)
    process.env.TZ = 'Asia/Tokyo'
    const b = inDailyWindow(at)
    assert.equal(a, true)
    assert.equal(b, true)
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

test('小时常量是 9（用户要求的早上 9 点）', () => {
  assert.equal(DAILY_CHECKIN_HOUR_UTC8, 9)
})
