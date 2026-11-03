/**
 * 核心逻辑测试（`node --test`）。
 *
 * 覆盖四类**曾经踩过或最容易踩**的点：
 * 1. 协议层纯函数（token 解析、JWT exp、签名头两组时间戳单位）；
 * 2. 账号池选号（余额排序 / 轮换 / 冷却）；
 * 3. 每日签到闸门（UTC+8 日界、次数上限、inactive 算成功）；
 * 4. 适配器：SSE 投影、空回复与截断必须报错、失败换号只在首字节前发生。
 *
 * 全部用注入的假 `fetch`，不碰网络。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  parseLoginInput,
  decodeJwtExpMs,
  signHeaders,
  identityHeaders,
} from '../src/protocol.js'
import { AccountPool, utc8DayKey } from '../src/pool.js'
import { createAdapter } from '../src/adapter.js'
import { PoolError } from '../src/errors.js'
import { contentHasImage, serializeMessages } from '../src/compat.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tap-test-'))
}

/** 造一个 base64url 的 JWT 载荷。 */
function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`
}

// ── 1. 协议层 ──────────────────────────────────────────────────────────

test('parseLoginInput 接受 deeplink / 回调 URL / 裸 token 三种形态', () => {
  assert.deepEqual(parseLoginInput('teleai-cowork://auth?token=abc123'), { token: 'abc123' })
  assert.deepEqual(
    parseLoginInput('https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?code=ucc.1&token=xyz'),
    { token: 'xyz' },
  )
  assert.deepEqual(parseLoginInput('  raw-token-value  '), { token: 'raw-token-value' })
})

test('parseLoginInput 对只有 code 的授权页给出可执行的取法（不是「去地址栏复制」）', () => {
  const result = parseLoginInput('https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?code=ucc.ABC')
  assert.ok('reason' in result)
  assert.match(result.reason, /Network/u)
  assert.match(result.reason, /一次性/u)
})

test('parseLoginInput 拒绝含空白的整句话（复制粘贴的典型脏数据）', () => {
  const result = parseLoginInput('我登录好了 token 在这里')
  assert.ok('reason' in result)
})

test('decodeJwtExpMs 能剥掉 tenant 前缀并解出 exp', () => {
  const exp = 1_800_000_000
  const token = `Em9xR4:${jwt({ exp })}`
  assert.equal(decodeJwtExpMs(token), exp * 1000)
  assert.equal(decodeJwtExpMs('not-a-jwt'), undefined)
  assert.equal(decodeJwtExpMs(`Em9xR4:${jwt({})}`), undefined)
})

test('签名头：只有**真实** sessionKey（trustedSignKey）才发，时间戳单位毫秒 vs 秒', () => {
  const nowMs = 1_700_000_000_123
  const headers = signHeaders(
    'POST',
    '/api/v1/chat/completions',
    { signKey: 'k', trustedSignKey: true },
    nowMs,
  )
  assert.equal(headers['X-SA-Timestamp'], String(nowMs))
  assert.equal(headers['X-SuperAgent-Timestamp'], String(Math.floor(nowMs / 1000)))
  assert.equal(headers['X-SA-Sign-Version'], 'local-v1')
  assert.equal(headers['X-SuperAgent-Sign-Version'], 'local-v1')
  assert.ok(headers['X-SA-Signature'].length > 20)
})

test('缺 signKey 或不是真实密钥时**不发**签名头（自造 key 会被 40104/40105）', () => {
  // 无 key
  assert.deepEqual(signHeaders('POST', '/x', {}), {})
  // 有自造 key 但没被标为可信 —— 这正是 2.5.3 时代能过、3.0.0 上必然被拒的那种
  assert.deepEqual(signHeaders('POST', '/x', { signKey: 'self-made' }), {})
})

test('身份头里没有 Authorization（用户 token 绝不能进 Bearer）', () => {
  const headers = identityHeaders({ token: 'tok' }, { deviceId: 'dev' }, 1_700_000_000, 'nonce')
  assert.equal(headers['X-Token'], 'tok')
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers['X-SuperAgent-Device-Id'], 'dev')
  assert.equal(headers['X-Route-Target'], 'ops-gateway')
})

// ── 2. 序列化 ──────────────────────────────────────────────────────────

test('serializeMessages 把 tool-result 展开成独立 tool 消息', () => {
  const wire = serializeMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '跑一下' },
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
    },
  ])
  assert.equal(wire[0].role, 'user')
  assert.equal(wire[1].role, 'tool')
  assert.equal(wire[1].tool_call_id, 'call_1')
  assert.equal(wire[2].tool_calls[0].function.name, 'bash')
})

test('contentHasImage 递归识别嵌套图片', () => {
  assert.equal(contentHasImage([{ type: 'image', attachment: {} }]), true)
  assert.equal(contentHasImage([{ type: 'tool-result', content: [{ type: 'image' }] }]), true)
  assert.equal(contentHasImage([{ type: 'text', text: 'x' }]), false)
})

// ── 3. 账号池 ──────────────────────────────────────────────────────────

/**
 * 造一个带账号的池。
 *
 * @param {object} [options]
 * @param {boolean} [options.signed] - 默认 `true`：模拟「已有真实签名能力」。
 *
 * ⚠️ 为什么要这个开关：`stream()` 现在会**先判签名能力再发请求** —— 3.0.0 客户端
 * 要求用主进程内存里的 sessionKey 签 `X-SA-Signature`，自造 key 一律 40104/40105。
 * 本文件测的是**签名之后**的下游行为（换号、SSE 投影、错误分类），
 * 所以默认把闸门放开；专门测闸门的用例用 `signed: false`。
 */
function seedPool(home, accounts, options = {}) {
  const signed = options.signed !== false
  const pool = new AccountPool({ home })
  for (const account of accounts) {
    pool.store.addAccount({ id: account.id, token: account.token, balance: account.balance ?? null, createdAt: account.createdAt })
    pool.store.state.tokenStorage = 'inline'
    pool.store.updateAccount(account.id, {
      token: account.token,
      ...(signed ? { trustedSignKey: true } : {}),
    })
  }
  pool.store.save()
  return new AccountPool({ home })
}

test('选号：balance-desc 把余额多的排前面，余额未知的排在最后', () => {
  const home = tempHome()
  const pool = seedPool(home, [
    { id: 'a_low', token: 't1', balance: 10, createdAt: 1 },
    { id: 'a_none', token: 't2', balance: null, createdAt: 2 },
    { id: 'a_high', token: 't3', balance: 900, createdAt: 3 },
  ])
  assert.deepEqual(pool.orderedAccounts().map((a) => a.id), ['a_high', 'a_low', 'a_none'])
})

test('选号：round-robin 按加入顺序轮换，游标推进后顺序改变', () => {
  const home = tempHome()
  const pool = seedPool(home, [
    { id: 'a1', token: 't1', createdAt: 1 },
    { id: 'a2', token: 't2', createdAt: 2 },
    { id: 'a3', token: 't3', createdAt: 3 },
  ])
  pool.store.updateSettings({ strategy: 'round-robin' })
  assert.deepEqual(pool.orderedAccounts().map((a) => a.id), ['a1', 'a2', 'a3'])
  pool.advanceCursor()
  assert.deepEqual(pool.orderedAccounts().map((a) => a.id), ['a2', 'a3', 'a1'])
})

test('选号：冷却中的账号被跳过；全部冷却时仍然返回（宁可尝试也不凭空拒绝）', () => {
  const home = tempHome()
  const pool = seedPool(home, [
    { id: 'a1', token: 't1', createdAt: 1 },
    { id: 'a2', token: 't2', createdAt: 2 },
  ])
  pool.markFailure('a1', 'x', { permanent: true })
  assert.deepEqual(pool.orderedAccounts().map((a) => a.id), ['a2'])
  pool.markFailure('a2', 'x', { permanent: true })
  assert.equal(pool.orderedAccounts().length, 2)
})

test('连续失败达到阈值才冷却；成功会清零', () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  pool.markFailure('a1', 'e1')
  pool.markFailure('a1', 'e2')
  assert.equal(pool.store.findAccount('a1').coolDownUntil, 0)
  pool.markFailure('a1', 'e3')
  assert.ok(pool.store.findAccount('a1').coolDownUntil > Date.now())
  pool.markSuccess('a1')
  assert.equal(pool.store.findAccount('a1').coolDownUntil, 0)
  assert.equal(pool.store.findAccount('a1').failStreak, 0)
})

test('快照永不含 token', () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 'SECRET-TOKEN' }])
  assert.equal(JSON.stringify(pool.snapshot()).includes('SECRET-TOKEN'), false)
})

// ── 4. 自动签到闸门 ────────────────────────────────────────────────────

test('utc8DayKey 用 UTC+8 日界（不受本机时区影响）', () => {
  // 2026-11-02T16:30:00Z = UTC+8 的 11-03 00:30
  assert.equal(utc8DayKey(Date.parse('2026-11-02T16:30:00Z')), '2026-11-03')
  assert.equal(utc8DayKey(Date.parse('2026-11-02T15:59:00Z')), '2026-11-02')
})

test('自动签到闸门：开关 → 当天已成功 → 次数上限', () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const day = utc8DayKey()

  pool.store.updateSettings({ autoCheckin: false })
  assert.equal(pool.decideAutoCheckin().reason, 'disabled')

  pool.store.updateSettings({ autoCheckin: true })
  assert.equal(pool.decideAutoCheckin().run, true)

  pool.store.updateCheckin({ day, attempts: 1, succeeded: true })
  assert.equal(pool.decideAutoCheckin().reason, 'done')

  pool.store.updateCheckin({ day, attempts: 3, succeeded: false })
  assert.equal(pool.decideAutoCheckin().reason, 'exhausted')

  // 跨天归零
  pool.store.updateCheckin({ day: '2000-01-01', attempts: 3, succeeded: true })
  assert.equal(pool.decideAutoCheckin().run, true)
})

// ── 5. 适配器（假 fetch）────────────────────────────────────────────────

function sseResponse(events, { includeDone = true, status = 200 } = {}) {
  const encoder = new TextEncoder()
  const chunks = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  if (includeDone) chunks.push(encoder.encode('data: [DONE]\n\n'))
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('stream 投影出文本块 + usage + finish，并回传真实内容', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const adapter = createAdapter({ pool })

  const original = globalThis.fetch
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content: '你' } }] },
    { choices: [{ delta: { content: '好' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } },
  ])
  try {
    const chunks = await collect(adapter.stream({
      provider: 'teleagent',
      model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(text, '你好')
    const use = chunks.find((c) => c.type === 'usage')
    assert.equal(use.usage.inputTokens, 12)
    assert.equal(use.usage.outputTokens, 2)
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop')
  } finally {
    globalThis.fetch = original
  }
})

test('空回复必须报错而不是「干净地成功」', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const adapter = createAdapter({ pool })
  const original = globalThis.fetch
  globalThis.fetch = async () => sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
  try {
    const chunks = await collect(adapter.stream({
      provider: 'teleagent', model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /空回复/u)
  } finally {
    globalThis.fetch = original
  }
})

test('缺 [DONE]（截断）必须报错', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const adapter = createAdapter({ pool })
  const original = globalThis.fetch
  globalThis.fetch = async () => sseResponse([{ choices: [{ delta: { content: '半句' } }] }], { includeDone: false })
  try {
    const chunks = await collect(adapter.stream({
      provider: 'teleagent', model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /截断/u)
  } finally {
    globalThis.fetch = original
  }
})

test('上游错误帧必须抛错（不能静默返回空流）', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const adapter = createAdapter({ pool })
  const original = globalThis.fetch
  globalThis.fetch = async () => sseResponse([{ error: { message: 'quota exhausted' } }])
  try {
    await assert.rejects(async () => {
      await collect(adapter.stream({
        provider: 'teleagent', model: 'chat-lite',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }))
    }, /quota exhausted/u)
  } finally {
    globalThis.fetch = original
  }
})

test('账号失败在首字节之前换号；全部失败时报出逐账号原因', async () => {
  const home = tempHome()
  const pool = seedPool(home, [
    { id: 'a1', token: 't-bad', balance: 100 },
    { id: 'a2', token: 't-good', balance: 50 },
  ])
  const adapter = createAdapter({ pool })
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return new Response('{"code":401,"message":"invalid token"}', { status: 401 })
    return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
  }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'teleagent', model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(calls, 2)
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'ok')
    // 失败的账号被标记（AUTH 是永久性 → 立刻冷却）
    assert.ok(pool.store.findAccount('a1').coolDownUntil > Date.now())
  } finally {
    globalThis.fetch = original
  }
})

test('无真实签名能力时**发请求之前**就抛出可执行的 AUTH（不发必然被拒的头）', async () => {
  const home = tempHome()
  // 显式关闭签名闸门：这条用例测的就是「没有真实 sessionKey」时的行为。
  const pool = seedPool(home, [{ id: 'a1', token: 't-bad' }], { signed: false })
  const adapter = createAdapter({ pool })
  const original = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called += 1; return new Response('{}', { status: 401 }) }
  try {
    await assert.rejects(async () => {
      await collect(adapter.stream({
        provider: 'teleagent', model: 'chat-lite',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }))
    }, (error) => {
      assert.ok(error instanceof PoolError)
      assert.notEqual(error.code, 'AUTH', 'UI 会把 AUTH 显示成「API 密钥无效」，吃掉真实原因')
      assert.notEqual(error.failure.code, 'AUTH', 'UI 会把 AUTH 显示成「API 密钥无效」')
      // 必须说清「缺的是客户端主进程的 sessionKey」，而不是甩一句配置错误
      assert.match(error.message, /sessionKey/u)
      assert.match(error.message, /40104/u)
      // 并明确告知积分/签到不受影响，用户才不会以为整个 provider 废了
      assert.match(error.message, /积分/u)
      return true
    })
    // ⚠️ 关键：一个请求都不该发出去（发出去只会换来 40104/40105，白等一轮超时）
    assert.equal(called, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('拿到真实签名能力后（trustedSignKey）才真正发请求', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't-good' }])
  // 模拟「将来拿到了客户端真实 sessionKey」
  pool.store.updateAccount('a1', { trustedSignKey: true })
  const adapter = createAdapter({ pool })
  const original = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
  }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'teleagent', model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(called, 1)
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'ok')
  } finally {
    globalThis.fetch = original
  }
})

test('图片输入：声明不支持就报错，绝不静默丢图', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const adapter = createAdapter({ pool })
  await assert.rejects(async () => {
    await collect(adapter.stream({
      provider: 'teleagent', model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }],
    }))
  }, (error) => {
    assert.equal(error.code, 'UNSUPPORTED_CONTENT')
    return true
  })
})

test('listModels 在空池时返回空数组（让 DSH 隐藏该分组，而不是抛错）', async () => {
  const home = tempHome()
  const pool = new AccountPool({ home })
  const adapter = createAdapter({ pool })
  assert.deepEqual(await adapter.listModels('teleagent'), [])
})

test('resolveModel 不编造 reasoning，且过滤非法 maxTokens', async () => {
  const home = tempHome()
  const pool = seedPool(home, [{ id: 'a1', token: 't1' }])
  const adapter = createAdapter({ pool })
  const resolved = await adapter.resolveModel('teleagent', 'chat-lite')
  assert.equal(resolved.reasoning, undefined)
  assert.equal(resolved.context.contextWindow, 100_000)
  assert.equal(resolved.defaultMaxTokens, 16_384)
  const unknown = await adapter.resolveModel('teleagent', 'no-such-model')
  assert.equal(unknown.context, undefined)
  assert.equal(unknown.defaultMaxTokens, undefined)
})

test('providerRetryPolicy 是已解析的完整对象（不是配置片段）', async () => {
  const home = tempHome()
  const pool = new AccountPool({ home })
  const policy = createAdapter({ pool }).providerRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
  assert.ok(policy.retryableCodes.length > 0)
  assert.ok(Number.isFinite(policy.initialDelayMs))
})
