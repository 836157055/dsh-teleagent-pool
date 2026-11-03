/**
 * AutoClaw 本地配对协议客户端（office-plugin v2）。
 *
 * ## 这一层是**实测跑通**的，不是推测
 *
 * ```
 * GET  127.0.0.1:3917/                 → 发现（port / publicKeyPem / bootstrapToken）
 * WS   ws://127.0.0.1:<port>/v1/stream  (subprotocol: autoclaw-office-stream.v1)
 *   ← server.hello{challenge, helloTimeoutMs, maxFrameBytes}
 *   → client.pair{challenge, encryptedSecret, envelope}           ← RSA-OAEP(SHA256) + AES-256-CBC 信封
 *   ← ready{connectionId, accountId, config}                      ← 配对成功，拿到连接 id
 *   → request{operation:"bootstrap"}   ← 拿 models / projects / agents
 *   → subscribe{documentId}            ← **帧类型**，不是 operation
 *   → request{operation:"chat", payload:{document:{...}, message, modelId}}
 *   ← run.events{events:[...]}         ← 流式：block.started / block.delta / block.completed
 *   ← run.terminal{snapshot:{status}}
 * ```
 *
 * ## 踩过的五个坑（每个都实测过，别再踩回去）
 *
 * | # | 症状 | 真因 |
 * |---|---|---|
 * | 1 | `4001 unsupported_protocol_version` | 把**传输层**帧（`{kind:"client.pair"}`）当成逻辑帧发 |
 * | 2 | `4001 unknown_frame_type` | 反过来把逻辑帧当成传输层帧发（两个方向都错过） |
 * | 3 | `4001 wrong_connection` | 信封里的 `connectionId` 必须是 **`null`**（认证前不许带） |
 * | 4 | `4002 sequence_replay` | `sequence` 是**整条连接**的单调计数，`ready` 已用掉 1 ⇒ 下一帧必须是 2 |
 * | 5 | `unknown_operation: subscribe` | `subscribe` 是**帧类型**，不是 `request` 的 operation |
 * | 6 | `office_document_invalid` | `chat.payload` 必须有 **`document` 对象**（`documentId` 匹配 `^[A-Za-z0-9._-]{8,160}$`），不是裸 id |
 *
 * ## 信封（AES-256-CBC + HMAC-SHA256）
 * ```js
 * encKey  = HMAC-SHA256(secret, "autoclaw-office-plugin/v1/encryption")
 * authKey = HMAC-SHA256(secret, "autoclaw-office-plugin/v1/authentication")
 * mac     = HMAC-SHA256(authKey, `${version}|${clientId}|${createdAt}|${nonce}|${iv}|${ciphertext}`)
 * ```
 * `version` 固定 2；`nonce` 24 字节；`iv` 16 字节；消息时效 120 秒。
 *
 * @module dsh-teleagent-pool/src/autoclaw/bridge
 */

import crypto from 'node:crypto'

export const DISCOVERY_PORT = 3917
export const DISCOVERY_URL = `http://127.0.0.1:${DISCOVERY_PORT}/`
export const SUBPROTOCOL = 'autoclaw-office-stream.v1'
export const ENVELOPE_VERSION = 2
export const STREAM_PATH = '/v1/stream'

const ENC_LABEL = 'autoclaw-office-plugin/v1/encryption'
const AUTH_LABEL = 'autoclaw-office-plugin/v1/authentication'

/** 信封/消息时效（客户端常量 `Ycs = 120s`）。 */
export const MESSAGE_TTL_MS = 120_000

/**
 * 本次实现用作 `clientId`。客户端要求 `/^[A-Za-z0-9._-]{8,128}$/`。
 */
export const CLIENT_ID = 'dsh-autoclaw-pool'

/** 生成 32 字节共享密钥（base64）。 */
export function newSecret() {
  return crypto.randomBytes(32)
}

function deriveKeys(secret) {
  return {
    encryptionKey: crypto.createHmac('sha256', secret).update(ENC_LABEL, 'utf8').digest(),
    authenticationKey: crypto.createHmac('sha256', secret).update(AUTH_LABEL, 'utf8').digest(),
  }
}

function macInput(envelope) {
  return [
    String(envelope.version),
    envelope.clientId,
    String(envelope.createdAt),
    envelope.nonce,
    envelope.iv,
    envelope.ciphertext,
  ].join('|')
}

/**
 * 封装一个信封（与客户端 `oho` 同构）。
 *
 * @param {Buffer} secret - 32 字节共享密钥
 * @param {object} plaintext - 要加密的逻辑帧
 * @param {{ clientId?: string, now?: number }} [options]
 */
export function seal(secret, plaintext, options = {}) {
  const clientId = options.clientId ?? CLIENT_ID
  const now = options.now ?? Date.now()
  const { encryptionKey, authenticationKey } = deriveKeys(secret)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), 'utf8'),
    cipher.final(),
  ])
  const envelope = {
    version: ENVELOPE_VERSION,
    clientId,
    createdAt: now,
    nonce: crypto.randomBytes(24).toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  envelope.mac = crypto.createHmac('sha256', authenticationKey)
    .update(macInput(envelope), 'utf8')
    .digest('base64')
  return envelope
}

/**
 * 解开一个信封并验 MAC（与客户端 `m0e` 同构）。
 *
 * @param {Buffer} secret
 * @param {object} envelope
 * @param {{ now?: number, ttlMs?: number }} [options]
 */
export function open(secret, envelope, options = {}) {
  const now = options.now ?? Date.now()
  const ttl = options.ttlMs ?? MESSAGE_TTL_MS
  if (envelope?.version !== ENVELOPE_VERSION) throw new Error(`信封版本不受支持：${envelope?.version}`)
  if (!Number.isFinite(envelope.createdAt) || Math.abs(now - envelope.createdAt) > ttl) {
    throw new Error('消息已过期（超出时效窗口）')
  }
  const { encryptionKey, authenticationKey } = deriveKeys(secret)
  const expect = crypto.createHmac('sha256', authenticationKey)
    .update(macInput(envelope), 'utf8')
    .digest()
  const actual = Buffer.from(String(envelope.mac ?? ''), 'base64')
  if (actual.length !== expect.length || !crypto.timingSafeEqual(expect, actual)) {
    throw new Error('信封 MAC 校验失败')
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, Buffer.from(envelope.iv, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plain.toString('utf8'))
}

/**
 * 读发现端点。
 *
 * @param {{ port?: number, timeoutMs?: number }} [options]
 */
export async function discover(options = {}) {
  const port = options.port ?? DISCOVERY_PORT
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 4_000),
  })
  if (!response.ok) throw new Error(`AutoClaw 发现端点返回 HTTP ${response.status}`)
  const payload = await response.json()
  if (payload?.service !== 'autoclaw-office-plugin') {
    throw new Error(`这不是 AutoClaw 的 office-plugin（service=${payload?.service}）`)
  }
  return payload
}

/**
 * 建配对帧（`client.pair`，**传输层**消息，信封里必须是完整逻辑帧）。
 *
 * @param {object} hello - `server.hello`
 * @param {object} found - `discover()` 结果
 * @param {Buffer} secret
 */
export function buildPairMessage(hello, found, secret) {
  const encryptedSecret = crypto.publicEncrypt(
    {
      key: found.publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    secret,
  ).toString('base64')

  // ⚠️ connectionId 必须是 null（`qds(frame, null)` 分支明确拒绝非 null）。
  const inner = {
    protocol: 1,
    dir: 'c2s',
    connectionId: null,
    sequence: 1,
    type: 'pair',
    payload: {
      bootstrapToken: found.bootstrapToken,
      pinnedPublicKeySha256: found.publicKeySha256,
      clientId: CLIENT_ID,
      clientName: 'DSH AutoClaw Pool',
      pluginVersion: '1.0.0',
      secret: secret.toString('base64'),
    },
  }

  return {
    kind: 'client.pair',
    challenge: hello.challenge,
    encryptedSecret,
    envelope: seal(secret, inner),
  }
}
