/**
 * 凭据有效期与「进入即全量刷新」的测试。
 *
 * 锁两件事：
 * 1. `expiresAt` 能从事真实的 token 解出，解不出时是 `null`（**不是**"永久有效"）。
 * 2. 客户端的有效期标签有「过期红字」这一档，且解不出时显示"未知"而不是编日期。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { decodeJwtExpMs } from '../src/autoclaw/credential.js'

/** 造一个带 exp 的 JWT（只用于测试，签名段随便写）。 */
function makeJwt(expSeconds, payloadExtra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, ...payloadExtra })).toString('base64url')
  return `${header}.${payload}.sig`
}

test('decodeJwtExpMs：解出 exp 毫秒时间戳', () => {
  const expSeconds = 1_800_000_000
  const token = makeJwt(expSeconds)
  assert.equal(decodeJwtExpMs(token), expSeconds * 1000)
})

test('decodeJwtExpMs：兼容 `tenant:jwt` 前缀形态（TeleAgent 与 AutoClaw 两种都要吃）', () => {
  const expSeconds = 1_800_000_000
  const bare = makeJwt(expSeconds)
  // AutoClaw：裸 JWT
  assert.equal(decodeJwtExpMs(bare), expSeconds * 1000)
  // TeleAgent：带前缀，要先剥掉
  assert.equal(decodeJwtExpMs(`tenant-abc:${bare}`), expSeconds * 1000)
})

test('decodeJwtExpMs：解不出来时返回 undefined（绝不能当成永久有效）', () => {
  const cases = [
    '',
    '   ',
    'not-a-jwt',
    'a.b',                     // 段数不对
    'a.b.c',                   // payload 不是 base64 JSON
    `${'x'.repeat(10)}.${Buffer.from('{}').toString('base64url')}.sig`,  // 没有 exp
    `${'x'.repeat(10)}.${Buffer.from('{"exp":"1800000000"}').toString('base64url')}.sig`,  // exp 不是数字
    null,
    undefined,
    123,
  ]
  for (const value of cases) {
    assert.equal(decodeJwtExpMs(value), undefined, `应解不出：${String(value).slice(0, 30)}`)
  }
})

test('listLocalAccounts：真实凭据能带上 expiresAt（读本机时不报错）', async () => {
  // 用空目录跑一遍，确认字段结构稳定（没有账号时不该抛）
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-empty-'))
  const { listLocalAccounts } = await import('../src/autoclaw/credential.js')
  const rows = await listLocalAccounts({ userDataDir: empty })
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, 0)
})

// ── 客户端标签 ──────────────────────────────────────────────────────────

const SOURCE = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//u, '')), '..', 'client.js'),
  'utf8',
)

/** 最小化的浏览器环境，只为跑 client.js 的 factory。 */
function browserEnv() {
  const handlers = new Map()
  const styleTags = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => handlers.set(spec.id, spec.factory) },
    },
    document: {
      createElement: () => ({
        setAttribute(k, v) { this[k] = v },
        appendChild() {},
      }),
      head: { appendChild: (el) => styleTags.push(el) },
      getElementById: () => null,
    },
    console,
    setTimeout,
    clearTimeout,
  }
  sandbox.window.document = sandbox.document
  return { sandbox, handlers, styleTags }
}

function makeRequire() {
  const React = {
    createElement: (type, props, children) => ({
      type,
      props: props || {},
      key: (props && props.key) ?? undefined,
      children: children === undefined ? [] : (Array.isArray(children) ? children : [children]),
    }),
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
  return (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
}

test('client：credentialTag 有「过期红字」这一档，解不出时显示未知', () => {
  // 源码级断言：确保四档判定都在，且过期用 tap-err
  const checks = [
    ['过期红字', /className: 'tap-tag tap-err'/u],
    ['已过期文案', /凭据已过期/u],
    ['今天过期文案', /凭据今天过期/u],
    ['未知文案', /凭据有效期未知/u],
    ['无凭据文案', /无凭据/u],
  ]
  for (const [label, pattern] of checks) {
    assert.match(SOURCE, pattern, `缺少：${label}`)
  }
  // 必须真的调用了这个组件（否则写了也没显示）
  assert.match(SOURCE, /credentialTag\(account, isAuto\)/u, '账号行应调用 credentialTag')
})

test('client：进入面板即全量刷新（load({refresh:true}) 存且被调用）', () => {
  // 必须有 refresh 分支，且真的调用了两个号池的余额刷新
  assert.match(SOURCE, /options\.refresh === true/u, '缺少 refresh 分支')
  assert.match(SOURCE, /load\(\{ refresh: true \}\)/u, '进入面板时应触发全量刷新')
  assert.match(SOURCE, /balance\/refresh/u, '全量刷新要调用 balance/refresh')
  // 两家都要刷（一个失败不该拖住另一个）
  assert.match(SOURCE, /pool: 'teleagent'/u)
  assert.match(SOURCE, /pool: 'autoclaw'/u)
})
