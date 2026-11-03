/**
 * 与**真实内核**的契约测试：用 `$DSH_HOME/profiles/node_modules` 里那份真正的
 * `@deepseek-ai/dsh-llm`，而不是替身。
 *
 * 只有这里能证明两件替身永远证明不了的事：
 * 1. `registerAdapter([...], adapter)` 真的接受这个**结构实现**的适配器
 *    （它校验 providerInfo 的 id/name、并读 providerRetryPolicy 的已解析形状）；
 * 2. `PoolError` 的 `code` / `failure` 真的能穿过 `normalizeLlmFailure`
 *    —— 即 AUTH / QUOTA_EXCEEDED 这类关键分类不会退化成 `UNKNOWN`。
 *
 * 内核不在预期位置时**跳过**（这台机器是 Windows 桌面版布局；换机器不该变红）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { AccountPool } from '../src/pool.js'
import { createAdapter } from '../src/adapter.js'
import { PoolError } from '../src/errors.js'

/** 找一份可用的 `@deepseek-ai/dsh-llm`（profile 的共享 node_modules 优先）。 */
function findKernelFile(name) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js'),
    path.join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js'),
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  return undefined
}

const KERNEL = findKernelFile('dsh-llm')
const CORDIS = findKernelFile('cordis')

/**
 * 造一个**真实的** cordis 根上下文。
 *
 * `LlmRuntime` 继承 `Service`，而 `Service` 构造时要 `ctx.reflect.provide(...)` ——
 * 手搓的替身会在那一行就炸。用真正的 cordis 根上下文，才验得到真实注册路径。
 */
async function realContext() {
  const cordis = await import(pathToFileURL(CORDIS).href)
  return new cordis.Context()
}

test('真实内核：registerAdapter 接受结构实现的适配器', { skip: KERNEL === undefined || CORDIS === undefined }, async () => {
  const dshLlm = await import(pathToFileURL(KERNEL).href)
  const ctx = await realContext()
  const runtime = new dshLlm.LlmRuntime(ctx)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-kernel-'))
  const pool = new AccountPool({ home })
  const adapter = createAdapter({ pool })

  assert.doesNotThrow(() => runtime.registerAdapter(['teleagent'], adapter))
  const providers = runtime.listProviders()
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'teleagent')
  assert.equal(providers[0].name, 'TeleAgent (电信)')

  // 空池 ⇒ 空目录（DSH 会把没有模型的分组隐藏掉）。
  assert.deepEqual(await runtime.listModels('teleagent'), [])

  // resolveModelInfo 走内核的**校验**路径：它检查 provider/id/name 一致、
  // context.contextWindow 是正整数、defaultMaxTokens 是正安全整数 ——
  // 任何一项不合规都抛 INVALID_MODEL_*，比单测自己断言更硬。
  const resolved = await runtime.resolveModelInfo('teleagent', 'chat-lite')
  assert.equal(resolved.reasoning, undefined)
  assert.equal(resolved.context.contextWindow, 100_000)
  assert.equal(resolved.defaultMaxTokens, 16_384)
})

test('真实内核：PoolError 的 code/failure 穿过 normalizeLlmFailure', { skip: KERNEL === undefined || CORDIS === undefined }, async () => {
  const dshLlm = await import(pathToFileURL(KERNEL).href)

  // 用内核自己的归一化：把 PoolError 当作「适配器抛出的错误」，看它产出什么 finish 块。
  const ctx = await realContext()
  const runtime = new dshLlm.LlmRuntime(ctx)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-kernel-'))
  const pool = new AccountPool({ home })
  pool.store.state.tokenStorage = 'inline'
  const account = pool.store.addAccount({ id: 'a1', token: 't-bad' })
  pool.store.updateAccount(account.id, { token: 't-bad' })

  const failing = {
    providerInfo: (provider) => ({ id: provider, name: 'TeleAgent (电信)' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
    async *stream() {
      throw new PoolError('teleagent: token 已失效', 'AUTH', { status: 401 })
    },
  }
  runtime.registerAdapter(['teleagent'], failing)

  const chunks = []
  for await (const chunk of runtime.stream({
    provider: 'teleagent',
    model: 'chat-lite',
    messages: [],
  })) {
    chunks.push(chunk)
  }
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  // ⚠️ 这里就是重点：code 必须是 AUTH，而不是 UNKNOWN。
  assert.equal(finish.reason.failure.code, 'AUTH')
  assert.equal(finish.reason.failure.status, 401)
  assert.match(finish.reason.failure.message, /token 已失效/u)
})

test('真实内核：适配器确实把 tools 下发到请求体顶层', { skip: KERNEL === undefined }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-kernel-'))
  const pool = new AccountPool({ home })
  pool.store.state.tokenStorage = 'inline'
  const account = pool.store.addAccount({ id: 'a1', token: 't1' })
  // 这条测的是「请求体结构」，所以放开签名闸门（3.0.0 下没有真实 sessionKey 的池
  // 会在发请求前就抛 AUTH，那是另一条用例的事）。
  pool.store.updateAccount(account.id, { token: 't1', trustedSignKey: true })
  const adapter = createAdapter({ pool })

  let seen
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen = JSON.parse(init.body)
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 })
  }
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'teleagent',
      model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
      system: '你是助手',
    })) {
      chunks.push(chunk)
    }
    assert.equal(seen.stream, true)
    assert.equal(seen.model, 'chat-lite')
    // system 必须进消息列表（TeleAgent 只有 messages 槽，没有独立 system 字段）。
    assert.equal(seen.messages[0].role, 'system')
    assert.equal(seen.messages[0].content, '你是助手')
    // ⚠️ 工具必须真的在顶层 tools 里：不下发时模型只能在正文里臆造调用，任务会终止。
    assert.equal(Array.isArray(seen.tools), true)
    assert.equal(seen.tools[0].function.name, 'bash')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    globalThis.fetch = original
  }
})
