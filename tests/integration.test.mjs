/**
 * 接线冒烟测试：用一个最小的假 cordis context 把 `apply()` 跑起来。
 *
 * 这里锁死的是**接线类**失效模式 —— 它们不会让单测变红，只会在真实内核里表现为
 * 「插件装上了但什么也没发生」：
 * - `inject` 只有 `['llm']`（多写一个会让没有该服务的组合**永久 pending**）；
 * - adapter 真的注册到 `teleagent` 这条路由上；
 * - `ctx.effect(() => () => ...)` 的 disposer 真的会释放路由；
 * - webServer 缺席时不抛错（缺席 = 降级，不是崩溃）；
 * - webServer 在场时 `/api/teleagent-pool/state` 可用，且**不泄露 token**。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply as applyHost, inject as hostInject } from '../index.js'

/** 极简 cordis 替身：只实现插件用到的那几个面。 */
function fakeContext(options = {}) {
  const effects = []
  const adapters = new Map()
  const routes = []
  const commands = []
  const log = []

  const ctx = {
    logger: {
      info: (message) => log.push(['info', message]),
      warn: (message) => log.push(['warn', message]),
    },
    effect(factory, label) {
      const disposer = factory()
      effects.push({ disposer, label })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(deps, callback) {
      const available = options.services ?? {}
      const satisfied = deps.every((dep) => available[dep] !== undefined)
      if (!satisfied) return
      const scoped = {
        ...ctx,
        ...available,
      }
      callback(scoped)
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        let released = false
        const handle = () => {
          released = true
          for (const provider of providers) adapters.delete(provider)
        }
        handle.replace = () => {}
        return handle
      },
      registerConfigurableProviders(entries) {
        log.push(['info', `configurable:${entries.map((entry) => entry.provider).join(',')}`])
      },
    },
  }
  ctx.get = (service) => (options.services ?? {})[service]
  return { ctx, adapters, routes, commands, effects, log }
}

function fakeServer(sink) {
  return {
    register(route) {
      sink.push(route)
      return () => {}
    },
  }
}

test('host inject 只声明 llm（多一个会让缺席它的组合永久 pending）', () => {
  assert.deepEqual(hostInject, ['llm'])
})

test('apply 注册 teleagent 路由，disposer 会释放它', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-int-'))
  const world = fakeContext()
  applyHost(world.ctx, { dataHome: home })

  assert.equal(world.adapters.has('teleagent'), true)
  assert.equal(world.adapters.get('teleagent').providerInfo('teleagent').name, 'TeleAgent (电信)')

  // 跑掉所有 effect disposer，路由应当消失。
  for (const effect of world.effects) {
    if (typeof effect.disposer === 'function') effect.disposer()
  }
  assert.equal(world.adapters.has('teleagent'), false)
  // 定时器句柄必须被清掉，否则进程退出前会一直挂着。
  assert.equal(world.log.some((row) => row[1].includes('自动签到')), false)
})

test('没有 webServer / credentials / commands 时不抛错（缺席是降级）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-int-'))
  const world = fakeContext()
  assert.doesNotThrow(() => applyHost(world.ctx, { dataHome: home }))
  assert.equal(world.adapters.has('teleagent'), true)
})

test('webServer 在场：/api/teleagent-pool/state 可用且不泄露 token', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-int-'))
  const registered = []
  const world = fakeContext({ services: { webServer: fakeServer(registered) } })
  applyHost(world.ctx, { dataHome: home })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/api/teleagent-pool')

  // 直接调 handler（不入真实 socket）。
  const result = await new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: undefined,
      body: '',
      writeHead(status, headers) { this.statusCode = status; this.headers = headers },
      end(body) { this.body = body; resolve(this) },
    }
    registered[0].handler({ url: '/api/teleagent-pool/state', method: 'GET', async *[Symbol.asyncIterator]() {} }, res)
  })

  assert.equal(result.statusCode, 200)
  const payload = JSON.parse(result.body)
  assert.equal(payload.ok, true)
  // 双号池：一次 state 同时给出两家摘要，前端切 Tab 零延迟。
  assert.equal(payload.pools.teleagent.provider.id, 'teleagent')
  assert.equal(payload.pools.autoclaw.provider.id, 'autoclaw')
  assert.ok(Array.isArray(payload.pools.teleagent.accounts))
  assert.ok(payload.pools.teleagent.loginUrl.includes('upms'))
  // 空池时 models 必须是空数组（让 DSH 隐藏该分组），而不是报错。
  assert.deepEqual(payload.pools.teleagent.models, [])
  assert.deepEqual(payload.pools.autoclaw.models.length >= 1, true)
  // AutoClaw 的签到能力必须**如实**报告为不支持（它确实没有每日签到端点）。
  assert.equal(payload.pools.autoclaw.checkin.supported, false)
  assert.match(payload.pools.autoclaw.checkin.reason, /没有/u)
  // 脱敏：不得出现任何密钥/设备标识。
  for (const secret of ['signKey', 'deviceId', 'installId', 'accessToken', 'refresh_token']) {
    assert.equal(result.body.includes(secret), false, `state 泄露了 ${secret}`)
  }
})

test('webServer 在场：accounts/add 拒绝只有 code 的链接，且错误文案指向 Network 面板', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-int-'))
  const registered = []
  const world = fakeContext({ services: { webServer: fakeServer(registered) } })
  applyHost(world.ctx, { dataHome: home })

  const result = await new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      input: 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?code=ucc.ABC',
    }))
    const req = {
      url: '/api/teleagent-pool/accounts/add',
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield body },
    }
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status) { this.statusCode = status },
      end(text) { this.body = text; resolve(this) },
    }
    registered[0].handler(req, res)
  })

  assert.equal(result.statusCode, 400)
  const payload = JSON.parse(result.body)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /Network/u)
})

test('未知接口返回 404（而不是挂住）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-int-'))
  const registered = []
  const world = fakeContext({ services: { webServer: fakeServer(registered) } })
  applyHost(world.ctx, { dataHome: home })

  const result = await new Promise((resolve) => {
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status) { this.statusCode = status },
      end(text) { this.body = text; resolve(this) },
    }
    registered[0].handler({ url: '/api/teleagent-pool/nope', method: 'GET', async *[Symbol.asyncIterator]() {} }, res)
  })
  assert.equal(result.statusCode, 404)
})

test('有 credentials 服务时 token 走凭据库，状态标记为 credentials', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-int-'))
  const stored = new Map()
  const credentials = {
    async resolve(ref) {
      return stored.has(ref) ? { value: stored.get(ref), source: 'test' } : undefined
    },
    async set(ref, value) { stored.set(ref, value) },
    async unset(ref) { stored.delete(ref) },
  }
  const world = fakeContext({ services: { credentials } })
  applyHost(world.ctx, { dataHome: home })

  const poolFile = path.join(home, 'teleagent-pool', 'pool.json')
  assert.equal(fs.existsSync(poolFile), true)
  const state = JSON.parse(fs.readFileSync(poolFile, 'utf8'))
  assert.equal(state.tokenStorage, 'credentials')
  // 设备级值只生成一次并落盘（不是每账号一份）。
  assert.match(state.deviceId, /^[0-9a-f]{16}$/u)
  assert.ok(state.signKey.length > 20)
})
