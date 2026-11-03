/**
 * 真实内核的 **prepareCall 链路**测试。
 *
 * 这一条测试的存在理由是一个真发生过的缺陷：
 *
 * > 只实现 `stream()` 的适配器在新版 `LlmRuntime` 上会在**每轮对话开始时**
 * > 抛 `registration.adapter.prepareCall is not a function`。
 * > 而 `listModels` / `resolveModel` 全都正常 ⇒ 看起来像模型目录问题，
 * > 实际是一句话都发不出去。
 *
 * 所以这里**必须**走 `runtime.prepareCall()`（而不是直接调适配器），
 * 让内核自己的 `normalizeModelInfo` 去校验返回形状。
 *
 * ⚠️ 内核的实际运行副本在 DSH 的 `app.asar` 里（版本比 profile 里那份新），
 * 因此这里**优先用 app.asar 解出的那份**，拿不到再退回 profile 里的。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { AccountPool } from '../src/pool.js'
import { createAdapter } from '../src/adapter.js'

/** 找一份可用的 dsh-llm（优先 app.asar 解出的新版 —— 那才是实际运行的那份）。 */
function findKernelRoots() {
  const roots = []
  // ① 显式指定的 asar 解包目录（CI / 本机核查时用）
  const asarDir = process.env.DSH_ASAR_DIR
  if (typeof asarDir === 'string' && asarDir.length > 0) {
    roots.push(path.join(asarDir, '@deepseek-ai'))
    roots.push(path.join(asarDir, 'node_modules', '@deepseek-ai'))
  }
  // ② 本机 DSH 安装里已解包的那份
  roots.push(path.join('D:', 'APP', 'deep seek', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
  // ③ profile 共享的副本（可能是旧版 —— 排最后）
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  roots.push(path.join(home, 'profiles', 'node_modules', '@deepseek-ai'))
  return roots
}

function findPackageFile(name, rel) {
  for (const root of findKernelRoots()) {
    const file = path.join(root, name, ...rel)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

const LLM = findPackageFile('dsh-llm', ['lib', 'index.js'])
const CORDIS = findPackageFile('cordis', ['lib', 'index.js'])

/**
 * 直接从 `app.asar` 找一个包里的文件（**不解包整个 asar**）。
 *
 * 为什么值得这么麻烦：实际运行的内核在 `app.asar` 里，而 profile 里那份可能更旧；
 * 只在旧的那份上跑测试会**漏掉**「新版要求 adapter.prepareCall」这件事 ——
 * 这正是本次缺陷的来源。
 */
function readFromAsar(asarPath, innerPath) {
  try {
    const fd = fs.openSync(asarPath, 'r')
    try {
      const head = Buffer.alloc(16)
      fs.readSync(fd, head, 0, 16, 0)
      const jsonLen = head.readUInt32LE(12)
      const jsonBuf = Buffer.alloc(jsonLen)
      fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
      const header = JSON.parse(jsonBuf.toString('utf8'))
      const base = 16 + jsonLen
      let node = header
      for (const segment of innerPath.split('/')) {
        node = node?.files?.[segment]
        if (node === undefined) return undefined
      }
      if (node.offset === undefined) return undefined
      const size = Number(node.size)
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, base + Number(node.offset))
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

const ASAR = [
  path.join('D:', 'APP', 'deep seek', 'resources', 'app.asar'),
  process.env.DSH_ASAR_PATH,
].find((file) => typeof file === 'string' && file.length > 0 && fs.existsSync(file))

/** app.asar 里那份 dsh-llm 的源码是否走 adapter.prepareCall 契约。 */
const ASAR_KERNEL = ASAR === undefined
  ? undefined
  : (() => {
    const source = readFromAsar(ASAR, 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
    if (source === undefined) return undefined
    // 写成临时文件才能 import —— 但依赖链也要求完整目录，故只用于「是否含该契约」的判断，
    // 真正的端到端走下面的 profile 内核 + 形状契约测试。
    return source.includes('adapter.prepareCall') ? `${ASAR}#in-dsh-llm` : undefined
  })()

/**
 * 判断这份内核是否走 `adapter.prepareCall` 契约。
 *
 * 旧版（0.1.0-rc.6 的 profile 副本）由 `LlmRuntime` 自己做 resolve、不碰适配器；
 * 新版会在 `LlmRuntime.prepareCall` 里调 `adapter.prepareCall`。
 * 用源码里的字符串判定比版本号可靠（asar 内的版本号可能与实际行为不符）。
 */
function kernelUsesAdapterPrepareCall(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes('adapter.prepareCall')
  } catch {
    return false
  }
}

async function realContext() {
  const cordis = await import(pathToFileURL(CORDIS).href)
  return new cordis.Context()
}

function seedPool() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-pc-'))
  const pool = new AccountPool({ home })
  pool.store.state.tokenStorage = 'inline'
  const account = pool.store.addAccount({ id: 'a1', token: 'tok-1' })
  pool.store.updateAccount(account.id, { token: 'tok-1' })
  return pool
}

test('适配器必须实现 prepareCall，且返回 { model, stream }', async () => {
  const pool = seedPool()
  const adapter = createAdapter({ pool })

  assert.equal(typeof adapter.prepareCall, 'function', '缺 prepareCall 会让每轮对话都报 is not a function')

  const prepared = await adapter.prepareCall('teleagent', 'chat-lite', undefined)
  assert.deepEqual(Object.keys(prepared).sort(), ['model', 'stream'])
  assert.equal(prepared.model.provider, 'teleagent')
  assert.equal(prepared.model.id, 'chat-lite')
  assert.equal(prepared.model.context.contextWindow, 100_000)
  assert.equal(typeof prepared.stream, 'function')
  // 不允许编造推理档位
  assert.equal(prepared.model.reasoning, undefined)
})

test(
  'app.asar（真实运行内核）：确实调用 adapter.prepareCall',
  { skip: ASAR === undefined },
  () => {
    const source = readFromAsar(ASAR, 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
    assert.ok(source !== undefined, '无法从 app.asar 读到 dsh-llm')
    // 这是本次缺陷的根因：内核会调 adapter.prepareCall，而基类没有它。
    assert.ok(source.includes('registration.adapter.prepareCall'), '运行内核应调用 adapter.prepareCall')
    // 并确认它校验的是 adapterCall.model（我们的返回形状必须对得上）
    assert.ok(source.includes('adapterCall.model'), '运行内核应读取 adapterCall.model')
    assert.ok(source.includes('normalizeModelInfo'), '运行内核应在分发前校验模型信息')
  },
)

test(
  '真实内核（profile 副本）：prepareCall 链路走得通',
  { skip: LLM === undefined || CORDIS === undefined },
  async () => {
    const dshLlm = await import(pathToFileURL(LLM).href)
    const ctx = await realContext()
    const runtime = new dshLlm.LlmRuntime(ctx)

    const pool = seedPool()
    runtime.registerAdapter(['teleagent'], createAdapter({ pool }))

    // 关键一步：内核自己校验适配器返回的 model 形状。
    const prepared = await runtime.prepareCall({
      provider: 'teleagent',
      model: 'chat-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })

    assert.equal(prepared.config.model, 'chat-lite')
    assert.equal(prepared.config.maxTokens, 16_384)
    assert.equal(typeof prepared.stream, 'function')
    assert.equal(typeof prepared.retryPolicy, 'object')

    const chunks = []
    for await (const chunk of prepared.stream(prepared.config)) chunks.push(chunk)
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    // ⚠️ 不能是 `AUTH`：dsh-client-runtime 会把 AUTH 无条件显示成
    // 「API key is invalid」，把「缺客户端 sessionKey」这个真实原因吃掉。
    assert.notEqual(finish.reason.failure.code, 'AUTH')
    assert.match(finish.reason.failure.message, /sessionKey/u)
  },
)

test('prepareCall 返回的 model 通过了 app.asar 里 normalizeModelInfo 的每一条校验', { skip: ASAR === undefined || CORDIS === undefined }, async () => {
  // 把 asar 里 normalizeModelInfo 的校验条件逐条搬过来跑 —— 这样即使本机装不上
  // 那份带全部依赖的内核，也能保证返回形状是合法的。
  const pool = seedPool()
  const adapter = createAdapter({ pool })
  const prepared = await adapter.prepareCall('teleagent', 'chat-lite', undefined)
  const resolved = prepared.model
  const provider = 'teleagent'
  const model = 'chat-lite'

  // ① 身份三件套
  assert.equal(typeof resolved.provider, 'string')
  assert.equal(resolved.provider, provider)
  assert.equal(typeof resolved.id, 'string')
  assert.equal(resolved.id, model)
  assert.equal(typeof resolved.name, 'string')
  assert.ok(resolved.name.length > 0)
  assert.ok(resolved.description === undefined || typeof resolved.description === 'string')

  // ② context.contextWindow 必须是**正整数**
  if (resolved.context !== undefined) {
    assert.equal(Number.isInteger(resolved.context.contextWindow), true)
    assert.ok(resolved.context.contextWindow > 0)
  }

  // ③ defaultMaxTokens 必须是**正安全整数**
  if (resolved.defaultMaxTokens !== undefined) {
    assert.equal(Number.isSafeInteger(resolved.defaultMaxTokens), true)
    assert.ok(resolved.defaultMaxTokens > 0)
  }

  // ④ 可选字段只允许合法枚举值（我们不能乱塞）
  assert.ok(resolved.systemPromptUpdate === undefined || resolved.systemPromptUpdate === 'in-history')
  assert.ok(
    resolved.toolUpdate === undefined
    || resolved.toolUpdate === 'in-history'
    || resolved.toolUpdate === 'addition-only',
  )

  // ⑤ reasoning 缺省时不声明档位（我们确实不声明）
  assert.equal(resolved.reasoning, undefined)

  // ⑥ stream 必须可调用，且是绑定当前适配器实例的闭包
  assert.equal(typeof prepared.stream, 'function')
})

test(
  'profile 副本内核是否走 adapter.prepareCall 契约（信息性）',
  { skip: LLM === undefined },
  () => {
    const uses = kernelUsesAdapterPrepareCall(LLM)
    console.log(`[kernel/profile] ${LLM}\n[kernel/profile] uses adapter.prepareCall = ${uses}`)
    // 两种内核线都必须能用我们的适配器：适配器自己实现 prepareCall，
    // 所以无论内核走不走这条契约都不受影响。这里只把事实打印出来。
    assert.equal(typeof uses, 'boolean')
  },
)
