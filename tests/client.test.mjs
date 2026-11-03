/**
 * 浏览器半身的**契约**测试：模拟 `dsh-client-modules` 的加载路径。
 *
 * 真实链路是：
 *   1. `<script src>` 执行 bundle → **只**调用 `window.__ModuleLoader__.load({id, factory})`
 *      完成注册（此时模块体一行都不跑）；
 *   2. 首次 materialize 时 `factory(require)` 执行，返回 `{ apply, inject }`；
 *   3. 内核把 `apply(ctx, config)` 交给 cordis fiber。
 *
 * 这里就是按这个顺序验的 —— 特别锁死三条会静默失效的约定：
 * - **顶层不得有 React/DOM 访问**（否则 script 执行期就炸，页面白屏）；
 * - `react` 必须由 `require` 给出（自带第二个实例会让 hooks 失效）；
 * - 注册失败必须被吞掉（设置页是别人家的 slot，挂坏了不该让别人白屏）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = path.join(import.meta.dirname, '..', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

/** 造一个只够跑 client.js 的浏览器环境。 */
function browserEnv(options = {}) {
  const handlers = new Map()
  const styleTags = []
  const fetchCalls = []

  const document = {
    head: { append: (node) => styleTags.push(node) },
    getElementById: (id) => styleTags.find((node) => node.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '', setAttribute(name, value) { this[`attr:${name}`] = value } }),
    visibilityState: 'visible',
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    TextEncoder,
    TextDecoder,
    JSON,
    Math,
    Date,
    Promise,
    fetch: (url, init) => {
      fetchCalls.push({ url, init })
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          ok: true,
          provider: { id: 'teleagent', name: 'TeleAgent (电信)' },
          loginUrl: 'https://example.test/login',
          models: [],
          accounts: [],
          settings: { autoCheckin: true, strategy: 'balance-desc', failureCooldown: 3 },
          checkin: { attempts: 0, succeeded: false, lastRunAt: null, lastResults: [] },
        })),
      })
    },
    document,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    window: {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.__ModuleLoader__ = {
    load(handoff) {
      if (handlers.has(handoff.id)) throw new Error('duplicate registration')
      handlers.set(handoff.id, handoff.factory)
    },
  }
  sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__

  return { sandbox, handlers, styleTags, fetchCalls }
}

/** 极简 require：只给 react 与已知服务。 */
function makeRequire(overrides = {}) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
  return (spec) => {
    if (spec in overrides) return overrides[spec]
    if (spec === 'react') return react
    throw new Error(`unexpected require(${spec})`)
  }
}

test('bundle 执行期只注册 factory，不访问 DOM / React（否则 script 一加载就炸）', () => {
  // 去掉 document / navigator 与 react 能力，只留 __ModuleLoader__。
  const strict = {
    console,
    __ModuleLoader__: {
      load(handoff) {
        assert.equal(handoff.id, 'dsh-teleagent-pool')
        assert.equal(typeof handoff.factory, 'function')
      },
    },
  }
  strict.window = strict
  assert.doesNotThrow(() => vm.runInNewContext(SOURCE, strict))
})

test('materialize 后导出 apply + inject；inject 声明 slots 与 layout', () => {
  const env = browserEnv()
  vm.runInNewContext(SOURCE, env.sandbox)
  const factory = env.handlers.get('dsh-teleagent-pool')
  const exports = factory(makeRequire())
  assert.equal(typeof exports.apply, 'function')
  // `slots` 决定能不能挂面板，`layout` 决定侧栏那一行点了能不能切过去。
  // 两者都是侧栏导航的硬需求；跨 realm 的数组原型不同，比较值不比引用。
  assert.equal(JSON.stringify(Array.from(exports.inject)), JSON.stringify(['slots', 'layout']))
})

test('apply 把设置页注册到 settings.section，label 可用', () => {
  const env = browserEnv()
  vm.runInNewContext(SOURCE, env.sandbox)
  const exports = env.handlers.get('dsh-teleagent-pool')(makeRequire())

  const registered = []
  let injected = ''
  const slots = {
    injected: [],
    inject(name, callback) { this.injected.push(name); callback() },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  }

  exports.apply({ get: (service) => (service === 'slots' ? slots : undefined) })

  // 三个 slot：设置页一段 + 侧栏那一行 + 主区那个页面
  assert.deepEqual(slots.injected.sort(), ['main', 'settings.section', 'sidebar.panellist'])
  assert.equal(registered.length, 3)

  const section = registered.find((row) => row.options.name === 'settings.section')
  assert.ok(section !== undefined, '应注册 settings.section')
  assert.equal(section.options.id, 'teleagent-pool')
  assert.equal(typeof section.options.label, 'function')
  // 双号池共用一个设置页，标题要同时点出两家。
  assert.match(section.options.label(), /电信/u)
  assert.match(section.options.label(), /智谱/u)
  assert.equal(typeof section.component, 'function')

  // ⚠️ 号池是日常入口，不能只藏在设置里 —— 侧栏要有导航项（显示在「插件」下方）
  const row = registered.find((row) => row.options.name === 'sidebar.panellist')
  assert.ok(row !== undefined, '应注册 sidebar.panellist（侧栏导航项）')
  assert.match(row.options.label(), /号池/u)
  assert.equal(typeof row.component, 'function')

  // ⚠️⚠️ 页面用 `main` + `key` 绑定，`key` 必须与导航项的 `id` **完全一致**，
  // 否则点了打不开，或者页面根本挂不上。
  const page = registered.find((row) => row.options.name === 'main')
  assert.ok(page !== undefined, '应注册 main（页面本体）')
  assert.equal(page.options.key, row.options.id, 'main.key 必须等于 sidebar.panellist.id')
  assert.equal(typeof page.component, 'function')

  // 样式一次性注入，并打上 plugin 标（HMR 回收靠它）
  assert.equal(env.styleTags.length, 1)
  assert.equal(env.styleTags[0]['attr:data-plugin'], 'dsh-teleagent-pool')
})

test('slots 缺席时 apply 静默返回（不抛错 —— 那是降级，不是故障）', () => {
  const env = browserEnv()
  vm.runInNewContext(SOURCE, env.sandbox)
  const exports = env.handlers.get('dsh-teleagent-pool')(makeRequire())
  assert.doesNotThrow(() => exports.apply({ get: () => undefined }))
})

test('register 抛错被吞掉（设置页是别人家的 slot，不该连带白屏）', () => {
  const env = browserEnv()
  vm.runInNewContext(SOURCE, env.sandbox)
  const exports = env.handlers.get('dsh-teleagent-pool')(makeRequire())
  const slots = {
    inject: (_name, callback) => callback(),
    register: () => { throw new Error('slot 冲突') },
  }
  assert.doesNotThrow(() => exports.apply({ get: () => slots }))
})

test('面板组件能渲染（React 替身跑一遍，确保没有 hooks 顺序/类型错误）', async () => {
  const env = browserEnv()
  vm.runInNewContext(SOURCE, env.sandbox)
  const exports = env.handlers.get('dsh-teleagent-pool')(makeRequire())

  // 现在注册三个 slot：拿到 settings.section 的 Panel 与侧栏 page
  let panel
  let row
  let page
  const slots = {
    inject: (_name, callback) => callback(),
    register: (options, element) => {
      if (options.name === 'settings.section') panel = element
      else if (options.name === 'sidebar.panellist') row = element
      else if (options.name === 'main') page = element
      return () => {}
    },
  }
  exports.apply({ get: () => slots })
  assert.equal(typeof panel, 'function', '应拿到 settings.section 的组件')
  assert.equal(typeof row, 'function', '应拿到 sidebar.panellist 的组件')
  assert.equal(typeof page, 'function', '应拿到 main 的组件')

  const tree = panel()
  assert.equal(tree.type, 'div')
  assert.ok(Array.isArray(tree.children))
  // 根节点把子元素作为**一个数组**传进来（对应 `h('div', p, [..])`），
  // 所以要先摊平再取 key。
  const flat = tree.children.flat(2).filter(Boolean)
  const keys = flat.map((child) => (child.props && child.props.key) ?? child.key)
  // 两个号池共用一个面板：Tab 条 + 加号卡片（TeleAgent）+ 号池卡片。
  assert.ok(keys.includes('tabs'), `keys = ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('pool'), `keys = ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('add'), `keys = ${JSON.stringify(keys)}`)
})
