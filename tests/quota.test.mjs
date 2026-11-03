/**
 * 额度识别与多实例换号的测试。
 *
 * 这些用例锁的是**处置正确性**：额度耗尽 ≠ 限流 ≠ 网络错误，
 * 三者的正确反应完全不同（换号 / 等一下 / 重试）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectQuotaExhausted,
  isQuotaDiagnosticCode,
  looksLikeQuotaExhausted,
  looksLikeRateLimited,
} from '../src/autoclaw/quota.js'
import { SCAN_PORTS, probeInstance } from '../src/autoclaw/instances.js'

test('额度关键词：中英文都要认（只认英文会漏掉全部中文额度错误）', () => {
  const quotaCases = [
    'insufficient_quota',
    'insufficient quota',
    'quota exceeded',
    'quota exhausted',
    'credit balance exhausted',
    'budget limit reached',
    '余额不足，请充值',
    '无可用资源包',
    '资源包已用尽',
    '资源包不足',
    '{"code":1113}',
    '"code": "1113"',
  ]
  for (const text of quotaCases) {
    assert.equal(looksLikeQuotaExhausted(text), true, `应识别为额度：${text}`)
  }

  const notQuota = ['rate limit exceeded', 'too many requests', 'network timeout', 'invalid token', 'ok', '']
  for (const text of notQuota) {
    assert.equal(looksLikeQuotaExhausted(text), false, `不该识别为额度：${text}`)
  }
})

test('限流与额度必须分开（限流等一会儿就好，换号是错的处置）', () => {
  assert.equal(looksLikeRateLimited('rate limit exceeded'), true)
  assert.equal(looksLikeRateLimited('too many requests'), true)
  assert.equal(looksLikeRateLimited('429'), true)
  assert.equal(looksLikeRateLimited('余额不足'), false)
  assert.equal(looksLikeRateLimited('quota exceeded'), false)
})

test('diagnosticCode：认变体，但不把限流算成额度', () => {
  for (const code of ['quota_exhausted', 'QUOTA_EXHAUSTED', 'quota_exceeded', 'QUOTA_EXCEEDED', 'quota', 'insufficient_quota']) {
    assert.equal(isQuotaDiagnosticCode(code), true, `应识别：${code}`)
  }
  for (const code of ['rate_limited', 'rate_limit', 'network_or_endpoint_unavailable', 'timeout', 'unknown_failure']) {
    assert.equal(isQuotaDiagnosticCode(code), false, `不该识别：${code}`)
  }
  assert.equal(isQuotaDiagnosticCode(undefined), false)
})

test('detectQuotaExhausted 能穿透常见嵌套形状', () => {
  assert.equal(detectQuotaExhausted({ diagnosticCode: 'quota_exhausted' }), true)
  assert.equal(detectQuotaExhausted({ code: 'QUOTA_EXCEEDED' }), true)
  assert.equal(detectQuotaExhausted({ error: { message: '余额不足' } }), true)
  assert.equal(detectQuotaExhausted({ upstream: { code: 1113 } }), true)
  assert.equal(detectQuotaExhausted({ payload: { error: { detail: '无可用资源包' } } }), true)

  assert.equal(detectQuotaExhausted({ message: 'all good' }), false)
  assert.equal(detectQuotaExhausted({ error: { message: 'invalid token' } }), false)
  assert.equal(detectQuotaExhausted(null), false)
  assert.equal(detectQuotaExhausted(undefined), false)
  assert.equal(detectQuotaExhausted('quota exceeded'), true)
})

test('detectQuotaExhausted 对循环引用不炸', () => {
  const a = { name: 'a' }
  const b = { name: 'b', a }
  a.b = b
  // 不抛错即可（内部有 seen 去重 + try/catch）
  assert.equal(typeof detectQuotaExhausted(a), 'boolean')
})

test('扫描端口区间以 3917 起（主端口 + 顺延实例）', () => {
  assert.equal(SCAN_PORTS[0], 3917)
  assert.ok(SCAN_PORTS.length >= 2)
  // 必须递增，否则漏扫
  for (let i = 1; i < SCAN_PORTS.length; i += 1) {
    assert.equal(SCAN_PORTS[i], SCAN_PORTS[i - 1] + 1)
  }
})

test('probeInstance 对非本服务/不可达返回 undefined（不抛错）', async () => {
  // 未监听的端口
  assert.equal(await probeInstance(1, { timeoutMs: 300 }), undefined)
  // 一个肯定不是 office-plugin 的地址
  assert.equal(await probeInstance(65000, { timeoutMs: 300 }), undefined)
})
