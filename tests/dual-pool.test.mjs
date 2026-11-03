/**
 * 双号池接线测试：两个 provider 各注册一条路由、各自的开关互不串、
 * AutoClaw 的「无签到」如实透出、`?pool=` 选择器正确。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply as applyHost } from '../index.js'

function fakeContext(options = {}) {
  const effects = []
  const adapters = new Map()
  const log = []
  const ctx = {
    logger: {
      info: (message) => log.push(['info', message]),
      warn: (message) => log.push(['warn', message]),
    },
    effect(factory) {
      const disposer = factory()
      effects.push({ disposer })
      return () => { if (typeof disposer === 'function') disposer() }
    },
    inject(deps, callback) {
      const available = options.services ?? {}
      if (!deps.every((dep) => available[dep] !== undefined)) return
      callback({ ...ctx, ...available })
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        const handle = () => {
          for (const provider of providers) adapters.delete(provider)
        }
        handle.replace = () => {}
        return handle
      },
      registerConfigurableProviders(entries) {
        log.push(['info', `configurable:${entries.map((entry) => entry.provider).join('+')}`])
      },
    },
  }
  ctx.get = (service) => (options.services ?? {})[service]
  return { ctx, adapters, effects, log }
}

/** 直接调 handler，返回 `{ status, payload, raw }`。 */
async function callApi(registered, urlPath, body) {
  return new Promise((resolve) => {
    const req = {
      url: urlPath,
      method: body === undefined ? 'GET' : 'POST',
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      statusCode: 0,
      raw: '',
      writeHead(status) { this.statusCode = status },
      end(text) { this.raw = text; resolve({ status: this.statusCode, payload: JSON.parse(text), raw: text }) },
    }
    registered[0].handler(req, res)
  })
}

test('apply 同时注册 teleagent 与 autoclaw 两条路由', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const world = fakeContext()
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })

  assert.equal(world.adapters.has('teleagent'), true)
  assert.equal(world.adapters.has('autoclaw'), true)
  assert.equal(world.adapters.get('autoclaw').providerInfo('autoclaw').name, 'AutoClaw (智谱)')

  for (const effect of world.effects) {
    if (typeof effect.disposer === 'function') effect.disposer()
  }
  assert.equal(world.adapters.size, 0)
})

test('两个 provider 都进可配置目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const world = fakeContext()
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })
  const line = world.log.map(([, message]) => message).find((message) => message.startsWith('configurable:'))
  assert.ok(line.includes('teleagent'))
  assert.ok(line.includes('autoclaw'))
})

test('state 同时给出两家摘要，AutoClaw 签到能力如实为 false', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const registered = []
  const world = fakeContext({
    services: { webServer: { register(route) { registered.push(route); return () => {} } } },
  })
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })

  const { payload } = await callApi(registered, '/api/teleagent-pool/state')
  assert.equal(payload.pools.teleagent.checkin.supported, true)
  assert.equal(payload.pools.teleagent.checkin.scheduleHourUtc8, 9)
  assert.equal(payload.pools.autoclaw.checkin.supported, false)
  assert.ok(Array.isArray(payload.pools.autoclaw.channels))
})

test('autoclaw 的 checkin/claim 明确返回 unsupported，而不是假装成功', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const registered = []
  const world = fakeContext({
    services: { webServer: { register(route) { registered.push(route); return () => {} } } },
  })
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })

  const { payload } = await callApi(registered, '/api/teleagent-pool/checkin/claim', { pool: 'autoclaw' })
  assert.equal(payload.ok, false)
  assert.equal(payload.unsupported, true)
  assert.match(payload.message, /没有/u)
})

test('accounts/add 对 autoclaw 号池给出「不用粘 token」的解释', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const registered = []
  const world = fakeContext({
    services: { webServer: { register(route) { registered.push(route); return () => {} } } },
  })
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })

  const { status, payload } = await callApi(registered, '/api/teleagent-pool/accounts/add', {
    pool: 'autoclaw',
    input: 'whatever',
  })
  assert.equal(status, 400)
  assert.match(payload.error, /扫描本机账号/u)
})

test('设定只改自己那家：teleagent 的 strategy 不动 autoclaw', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const registered = []
  const world = fakeContext({
    services: { webServer: { register(route) { registered.push(route); return () => {} } } },
  })
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })

  await callApi(registered, '/api/teleagent-pool/settings', { pool: 'teleagent', strategy: 'round-robin' })
  const after = await callApi(registered, '/api/teleagent-pool/state')
  assert.equal(after.payload.pools.teleagent.settings.strategy, 'round-robin')
  assert.equal(after.payload.pools.autoclaw.settings.strategy, 'balance-desc')

  await callApi(registered, '/api/teleagent-pool/settings', { pool: 'autoclaw', autoScan: false })
  const final = await callApi(registered, '/api/teleagent-pool/state')
  assert.equal(final.payload.pools.autoclaw.settings.autoScan, false)
  // teleagent 没有 autoScan 这个设置，也不该被写进去
  assert.equal('autoScan' in final.payload.pools.teleagent.settings, false)
})

test('autoclaw/scan 在没有 AutoClaw 目录时返回 0 个（不报错）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dual-'))
  const registered = []
  const world = fakeContext({
    services: { webServer: { register(route) { registered.push(route); return () => {} } } },
  })
  applyHost(world.ctx, { dataHome: home, autoclawDir: path.join(home, 'no-autoclaw') })

  const { status, payload } = await callApi(registered, '/api/teleagent-pool/autoclaw/scan', {})
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.scanned, 0)
  assert.equal(payload.added, 0)
})
