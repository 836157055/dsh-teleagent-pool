/**
 * AutoClaw 号池测试：凭据解密、签报头、余额、目录、扫描去重、能力如实报告。
 *
 * 全部用**临时目录 + 假 fetch/假凭据文件**，不碰真机凭据、不碰网络。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { decryptCredentialFile, stripBearer, userDataDir } from '../src/autoclaw/credential.js'
import { signedHeaders } from '../src/autoclaw/api.js'
import { AutoClawPool } from '../src/autoclaw/pool.js'
import { AutoClawStore, sanitizeState } from '../src/autoclaw/store.js'
import { buildPromptText, createAutoClawAdapter, mapModelNameToConnectionId } from '../src/autoclaw/adapter.js'
import { PROVIDER_ID } from '../src/autoclaw/product.js'
import { CLIENT_ID, ENVELOPE_VERSION, newSecret, open, seal } from '../src/autoclaw/bridge.js'

function tempDir(prefix = 'tap-zai-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造一个 v10 格式的凭据文件（与 Electron safeStorage 同形）。 */
function writeCredentialFile(file, masterKey, payload) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([Buffer.from('v10', 'ascii'), iv, ciphertext, tag]), { mode: 0o600 })
}

/** 造一个最小 AutoClaw 用户目录（无 Local State ⇒ 走不到 DPAPI，测的是纯解密）。 */
function seedAutoClawDir(root) {
  const key = crypto.randomBytes(32)
  const accountKey = 'abc123hash'
  const dir = path.join(root, 'accounts', accountKey)
  writeCredentialFile(path.join(dir, 'account-credentials.enc'), key, {
    schemaVersion: 1,
    // ⚠️ 实测值自带 "Bearer " 前缀 —— 这里刻意保留，验证我们必须剥掉
    accessToken: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    refreshToken: 'Bearer refresh-token-value',
    tokenType: 'Bearer',
  })
  fs.writeFileSync(path.join(dir, 'account-profile.json'), JSON.stringify({
    schemaVersion: 1,
    profile: { accountId: 'acc-0001', phone: '19000007948', numericUserId: 900629 },
  }))
  fs.writeFileSync(path.join(root, 'device', 'active-product-account.json'), '{')
  return { key, accountKey }
}

// ── 凭据解密 ────────────────────────────────────────────────────────────

test('decryptCredentialFile 解得 v10 AES-GCM，并剥掉 Bearer 前缀', () => {
  const root = tempDir()
  const key = crypto.randomBytes(32)
  const file = path.join(root, 'account-credentials.enc')
  writeCredentialFile(file, key, {
    accessToken: 'Bearer eyJhbGciOi.abc.def',
    refreshToken: 'Bearer refresh-xyz',
    tokenType: 'Bearer',
  })
  const cred = decryptCredentialFile(key, file)
  assert.equal(cred.accessToken, 'eyJhbGciOi.abc.def')
  assert.equal(cred.refreshToken, 'refresh-xyz')
  assert.equal(cred.tokenType, 'Bearer')
})

test('decryptCredentialFile 对错误密钥/坏前缀返回 undefined（不抛错）', () => {
  const root = tempDir()
  const key = crypto.randomBytes(32)
  const file = path.join(root, 'account-credentials.enc')
  writeCredentialFile(file, key, { accessToken: 'Bearer x' })
  assert.equal(decryptCredentialFile(crypto.randomBytes(32), file), undefined)

  const bad = path.join(root, 'bad.enc')
  fs.writeFileSync(bad, Buffer.from('v11' + 'x'.repeat(40)))
  assert.equal(decryptCredentialFile(key, bad), undefined)
  assert.equal(decryptCredentialFile(key, path.join(root, 'missing.enc')), undefined)
})

test('stripBearer 只剥前缀，且拒绝空值', () => {
  assert.equal(stripBearer('Bearer abc'), 'abc')
  assert.equal(stripBearer('bearer   abc'), 'abc')
  assert.equal(stripBearer('Bearer Bearer abc'), 'abc')
  assert.equal(stripBearer('abc'), 'abc')
  assert.equal(stripBearer('Bearer   '), undefined)
  assert.equal(stripBearer(undefined), undefined)
})

test('userDataDir 默认指向 %APPDATA%/AutoClaw-official，可覆盖', () => {
  assert.match(userDataDir(), /AutoClaw-official$/u)
  assert.equal(userDataDir('C:/tmp/x'), path.resolve('C:/tmp/x'))
})

// ── 签报头 ──────────────────────────────────────────────────────────────

test('signedHeaders 用秒级时间戳 + md5 签名；token 头按端点族选择', () => {
  const headers = signedHeaders('Bearer tok-123', { nowSec: 1_700_000_000 })
  assert.equal(headers['X-Auth-TimeStamp'], '1700000000')
  assert.equal(
    headers['X-Auth-Sign'],
    crypto.createHash('md5').update('100003&1700000000&38d2391985e2369a5fb8227d8e6cd5e5').digest('hex'),
  )
  // 业务端点：Authorization（放进 X-Authorization 会得到 410000 用户未登录）
  assert.equal(headers.Authorization, 'Bearer tok-123')
  assert.equal(headers['X-Authorization'], undefined)
  assert.equal(headers['X-Product'], 'autoclaw')

  // 推理端点：X-Authorization（放进 Authorization 会得到 401001 Invalid token）
  const infer = signedHeaders('Bearer tok-123', { nowSec: 1_700_000_000, tokenHeader: 'X-Authorization' })
  assert.equal(infer['X-Authorization'], 'Bearer tok-123')
  assert.equal(infer.Authorization, undefined)
})

// ── 存储 ────────────────────────────────────────────────────────────────

test('sanitizeState 收敛脏数据，且 inline 才保留 token', () => {
  const state = sanitizeState({
    tokenStorage: 'credentials',
    settings: { strategy: 'weird', failureCooldown: 999, autoScan: false },
    accounts: [
      { id: 'bad id!', identity: 'x' },           // 非法 id → 丢弃
      { id: 'zai_ok', identity: 'a1', token: 'SECRET' },
      { id: 'zai_ok', identity: 'a2' },           // 重复 → 丢弃
    ],
  })
  assert.equal(state.settings.strategy, 'balance-desc')
  assert.equal(state.settings.failureCooldown, 20)
  assert.equal(state.settings.autoScan, false)
  assert.deepEqual(state.accounts.map((row) => row.id), ['zai_ok'])
  // credentials 模式下 token 不落这个文件
  assert.equal(state.accounts[0].token, '')
})

test('AutoClawStore 读写往返，快照不含 token', () => {
  const home = tempDir()
  const store = new AutoClawStore(home)
  store.state.tokenStorage = 'inline'
  const account = store.addAccount({ identity: 'a1', nickname: '智谱 7948', token: 'SECRET' })
  store.updateAccount(account.id, { balance: 15000, balanceAt: Date.now() })
  store.save()

  const reopened = new AutoClawStore(home)
  const row = reopened.findAccount(account.id)
  assert.equal(row.balance, 15000)
  assert.equal(JSON.stringify(reopened.publicSnapshot()).includes('SECRET'), false)
})

// ── 账号池 ──────────────────────────────────────────────────────────────

/** 造一个注入了假 fetch 的池。 */
function fakePool(home, overrides = {}) {
  const pool = new AutoClawPool({ home })
  pool.store.state.tokenStorage = 'inline'
  return pool
}

test('selectableAccounts 只看启用开关；orderedAccounts 余额优先', () => {
  const home = tempDir()
  const pool = fakePool(home)
  const a = pool.store.addAccount({ identity: 'a', token: 't1' })
  const b = pool.store.addAccount({ identity: 'b', token: 't2' })
  pool.store.updateAccount(a.id, { balance: 10 })
  pool.store.updateAccount(b.id, { balance: 900 })
  assert.deepEqual(pool.orderedAccounts().map((row) => row.identity), ['b', 'a'])
  pool.store.updateAccount(b.id, { enabled: false })
  assert.deepEqual(pool.orderedAccounts().map((row) => row.identity), ['a'])
})

test('orderedAccounts 全在冷却时仍然返回（宁可尝试也不凭空拒绝）', () => {
  const home = tempDir()
  const pool = fakePool(home)
  const a = pool.store.addAccount({ identity: 'a', token: 't1' })
  pool.store.updateAccount(a.id, { coolDownUntil: Date.now() + 60_000 })
  assert.equal(pool.orderedAccounts().length, 1)
})

test('checkinCapability 如实报告「不支持每日签到」并给出理由', () => {
  const pool = fakePool(tempDir())
  const capability = pool.checkinCapability()
  assert.equal(capability.supported, false)
  assert.match(capability.reason, /没有/u)
  assert.match(capability.reason, /每日签到/u)
  assert.match(capability.day, /^\d{4}-\d{2}-\d{2}$/u)
})

test('scanLocalAccounts 在无 AutoClaw 目录时返回空数组（不抛错）', async () => {
  const pool = new AutoClawPool({ home: tempDir(), autoClawDir: path.join(tempDir(), 'nope') })
  assert.deepEqual(await pool.scanLocalAccounts({ skipBalance: true }), [])
})

// ── 适配器 ──────────────────────────────────────────────────────────────

test('listModels 空池返回空数组；resolveModel 用**账号级**模型名且不编造 reasoning', async () => {
  const home = tempDir()
  const pool = fakePool(home)
  const adapter = createAutoClawAdapter({ pool })

  assert.deepEqual(await adapter.listModels(PROVIDER_ID), [])

  // 加一个账号后再问：走兜底表（本机没有账号级目录时）
  pool.store.addAccount({ identity: 'a', token: 't1' })
  const models = await adapter.listModels(PROVIDER_ID)
  assert.ok(models.length >= 3)
  assert.ok(models.every((row) => row.provider === PROVIDER_ID))

  // ⚠️ 兜底表必须是**推理网关认的名字**（`zaicoding_*` / `zai_*`），
  // 不是第三方 BYOK 目录里的 `glm-5.3` —— 后者会得到 `400 非法模型`。
  const ids = models.map((row) => row.id)
  assert.ok(ids.includes('zaicoding_glm-5.3'), `ids = ${JSON.stringify(ids)}`)
  assert.equal(ids.includes('glm-5.3'), false, '不能把 BYOK 目录 id 当推理模型名')

  const resolved = await adapter.resolveModel(PROVIDER_ID, 'zaicoding_glm-5.3')
  assert.equal(resolved.reasoning, undefined)
  assert.equal(resolved.context.contextWindow, 1_048_576)
  assert.equal(resolved.defaultMaxTokens, 307_200)
})

test('providerRetryPolicy 是已解析的完整对象', () => {
  const pool = fakePool(tempDir())
  const policy = createAutoClawAdapter({ pool }).providerRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
  assert.ok(policy.retryableCodes.length > 0)
  assert.ok(Number.isFinite(policy.initialDelayMs))
})

test('stream：空账号池抛出可执行错误（且**不用** AUTH —— 那会被 UI 显示成「API 密钥无效」）', async () => {
  const pool = fakePool(tempDir())
  const adapter = createAutoClawAdapter({ pool })
  await assert.rejects(async () => {
    const iterator = adapter.stream({ provider: PROVIDER_ID, model: 'zaicoding_glm-5.3', messages: [] })
    // eslint-disable-next-line no-unreachable-loop
    for await (const _ of iterator) { /* 不应产出任何块 */ }
  }, (error) => {
    // ⚠️ 关键：`AUTH` 会被 dsh-client-runtime 无条件翻译成「API key is invalid」，
    // 把真实原因（池里没账号）全部吃掉。
    assert.notEqual(error.code, 'AUTH')
    assert.match(error.message, /账号池为空/u)
    return true
  })
})

test('stream：桌面端不可达时给出可执行提示（不是裸的网络错）', async () => {
  const home = tempDir()
  const pool = fakePool(home)
  pool.store.addAccount({ identity: 'a', token: 'tok' })
  const adapter = createAutoClawAdapter({ pool })

  // 让「发现端点」连不上，模拟 AutoClaw 没开
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3917')
  }
  try {
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({
        provider: PROVIDER_ID,
        model: 'zaicoding_glm-5.3',
        callId: 'call-x',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* 不应产出 */ }
    }, (error) => {
      // ⚠️ 不能是 `AUTH`（UI 会显示成「API key is invalid」，与事实不符）
      assert.notEqual(error.code, 'AUTH')
      // 必须点明「确认桌面端在运行」这个可执行动作
      assert.match(error.message, /AutoClaw/u)
      assert.match(error.message, /桌面端/u)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

test('mapModelNameToConnectionId：目录名 → bootstrap UUID', () => {
  const bootstrap = [
    { id: '76348186-df27-42da-83d2-a2b6361a54be', name: 'GLM-5.3' },
    { id: 'e67d63e8-b7dc-4b31-b0a5-eb7eaa9062b9', name: 'GLM-5.3-Flash' },
    { id: '2232da27-f5a8-44b2-9f2d-50184380b97f', name: 'Auto' },
  ]
  // `zaicoding_` / `zai_` 前缀要先剥掉才能与可读名对上
  assert.equal(mapModelNameToConnectionId('zaicoding_glm-5.3', bootstrap), bootstrap[0].id)
  assert.equal(mapModelNameToConnectionId('zai_glm-5.3-flash', bootstrap), bootstrap[1].id)
  assert.equal(mapModelNameToConnectionId('zai_auto', bootstrap), bootstrap[2].id)
  // 直接同名也认
  assert.equal(mapModelNameToConnectionId('GLM-5.3', bootstrap), bootstrap[0].id)
  // 认不出时返回 undefined（让服务端用默认模型，不瞎猜 UUID）
  assert.equal(mapModelNameToConnectionId('nonexistent-model', bootstrap), undefined)
  assert.equal(mapModelNameToConnectionId('anything', []), undefined)
})

test('buildPromptText 只转发对话内容，**绝不**转发 system（否则泄露运行时指令）', () => {
  const text = buildPromptText({
    // ⚠️ 这两段都必须被丢掉：转发出去会在对方服务器上留下本机运行时指令，
    // 而且里面的「你是 XXX」会污染对方模型的自我判断。
    system: 'you are helpful <project_instructions>SECRET_RUNTIME</project_instructions>',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '另一段运行时指令' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  })

  // 对话内容按序内联
  assert.match(text, /User: hello/u)
  assert.match(text, /Assistant: hi/u)
  assert.match(text, /User: again/u)

  // 运行时指令一个字都不能出去
  assert.equal(text.includes('SECRET_RUNTIME'), false, 'system 泄露了')
  assert.equal(text.includes('project_instructions'), false, 'system 泄露了')
  assert.equal(text.includes('另一段运行时指令'), false, 'system 轮次泄露了')
  assert.equal(text.includes('you are helpful'), false, 'system 泄露了')
})

test('信封 seal/open 往返，且篡改会被 MAC 拒绝', () => {
  const secret = newSecret()
  const payload = { protocol: 1, dir: 'c2s', connectionId: null, sequence: 1, type: 'pair' }
  const envelope = seal(secret, payload)
  assert.equal(envelope.version, ENVELOPE_VERSION)
  assert.equal(envelope.clientId, CLIENT_ID)

  // 正常往返
  assert.deepEqual(open(secret, envelope), payload)

  // 换密钥 ⇒ MAC 不符
  assert.throws(() => open(newSecret(), envelope), /MAC/u)

  // 改密文 ⇒ MAC 不符
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` }
  assert.throws(() => open(secret, tampered), /MAC/u)

  // 版本不符
  assert.throws(() => open(secret, { ...envelope, version: 3 }), /版本/u)

  // 过期（把 createdAt 推到窗口外）
  const stale = { ...envelope, createdAt: envelope.createdAt - 10 * 60_000 }
  // ⚠️ createdAt 变了 MAC 也要重算才走到过期分支；这里直接验「过期」优先于 MAC
  assert.throws(() => open(secret, stale), /过期/u)
})
