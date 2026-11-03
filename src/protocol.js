/**
 * TeleAgent 协议层：凭据形状、身份头、签名头、登录输入解析、JWT 过期解析。
 *
 * 全部是**纯函数**（或只依赖 node:crypto 的确定性函数），方便单测，也方便
 * 在 host 侧被多个模块共享。
 *
 * ## 四条实测事实（改代码前必须记住）
 *
 * 1. **身份头是 `X-Token`，不是 `Authorization: Bearer <token>`**。
 *    推理请求的 Bearer 放的是内置渠道 apiKey，用户身份另走 `X-Token`。
 * 2. **推理端点需要签名头，业务端点不需要**。缺签名 → `40301`（文案谎称
 *    「客户端版本过低」，与版本号无关）或 `40104 unsupported sign version`。
 * 3. 两套签名头的时间戳**单位不同**：`X-SA-*` 是毫秒，`X-SuperAgent-*` 是秒。
 * 4. `sessionKey` 是客户端**本地随机**生成的（`randomBytes(32)`，不经服务端注册）
 *    ⇒ 服务端只能校验「头存在 + 版本合法 + 时间戳新鲜」，故我们生成一次并持久化。
 *
 * @module dsh-teleagent-pool/src/protocol
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  APP_VERSION,
  API_BASE,
  INFER_API_KEY,
  INFER_PATH,
  ROUTE_TARGET,
  SIGN_HEADERS,
  SIGN_HEADERS_SUPER,
  SIGN_VERSION,
} from './product.js'

/** 读非空字符串（trim 后）。 */
export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 生成插件侧 deviceId。
 *
 * ⚠️ **16 位 hex**：实测官方客户端 `app-auth/device-meta.json` 里是
 * `"deviceId": "e88088715b6f"`（12 位）。12 位与 16 位在服务端都不被内容校验
 *（它只看「有没有这个头」），本插件取 16 位 hex（8 字节随机）以避免与
 * 账号 id 混淆，同时保持纯 hex 形态。
 */
export function generateDeviceId() {
  return randomBytes(8).toString('hex')
}

/** 生成安装标识（UUID 形态，与官方客户端一致）。 */
export function generateInstallId() {
  return randomUUID()
}

/**
 * 生成签名会话密钥。
 *
 * 官方客户端：`randomBytes(32).toString('base64url')`，**每进程启动新建**。
 * 我们生成一次并持久化在账号池文件里（设备级，全账号共用）。
 */
export function generateSignKey() {
  return randomBytes(32).toString('base64url')
}

/**
 * 从 JWT 解出 `exp`（毫秒）。
 *
 * ⚠️ token 形如 `Em9xR4:eyJhbGci….sig`（首段是 tenant 前缀 + 冒号），
 * 所以**不能**直接 `split('.')` —— 要先剥掉冒号前缀。
 * 解不出返回 `undefined`（调用方**必须**把未知当未过期，否则每次调用都会先触发
 * 一次必然无效的「续期」）。
 */
export function decodeJwtExpMs(token) {
  const body = typeof token === 'string' && token.includes(':') ? token.slice(token.indexOf(':') + 1) : (token ?? '')
  const segments = String(body).split('.')
  if (segments.length !== 3 || segments[1] === undefined) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    const exp = payload?.exp
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
    const ms = exp * 1000
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  } catch {
    return undefined
  }
}

/** 凭据过期时刻（毫秒）；`undefined` = 未知。 */
export function credentialExpiresAtMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw)
    const ms = value > 1_000_000_000_000 ? value : value * 1000
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return decodeJwtExpMs(credential?.token)
}

/** 凭据是否已过期（**无过期信息时保守视为未过期**）。 */
export function isExpired(credential, nowMs = Date.now()) {
  const at = credentialExpiresAtMs(credential)
  return at !== undefined && nowMs >= at
}

/**
 * 解析登录输入 → token。
 *
 * 宽容三种形态：`teleai-cowork://auth?token=…`、`…/cowork/auth?token=…`、裸 token。
 * 含空白的整句话会被拒绝（地址栏复制必带换行，粘贴前已 trim，仍有空白说明粘错了）。
 *
 * @returns `{ token }` 或 `{ reason }`
 */
export function parseLoginInput(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) return { reason: '粘贴内容为空' }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    let url
    try {
      url = new URL(raw)
    } catch {
      return { reason: '无法解析为 URL' }
    }
    const token = url.searchParams.get('token')
    if (token !== null && token.trim().length > 0) return { token: token.trim() }
    if (url.hash.includes('?')) {
      const hashToken = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)).get('token')
      if (hashToken !== null && hashToken.trim().length > 0) return { token: hashToken.trim() }
    }
    if (url.searchParams.get('code') !== null) {
      return {
        reason: '这一跳只给了 code，而 code 是一次性的（那次授权已经把它用掉了）。'
          + '请在登录页按 F12 → Network → 勾选「保留日志」→ 重新完成一次授权 → '
          + '点开那条 cowork/auth?code=… 请求，从 Location 响应头或响应体里找到 token=，'
          + '把整条含 token 的链接（或 token 本身）粘进来。',
      }
    }
    return { reason: 'URL 里没有 token 参数' }
  }

  if (/\s/u.test(raw)) {
    return { reason: '无法识别：请粘贴含 token= 的回调链接，或直接粘贴 token 本身' }
  }
  return { token: raw }
}

/**
 * 身份头（`X-Token` + 秒级时间戳 + nonce + 设备标识 + 路由目标 + 版本）。
 *
 * ⚠️ `X-SuperAgent-Timestamp` 是**秒级**；Timestamp/Nonce 每次请求都要重算。
 */
export function identityHeaders(credential, pool = {}, nowSec = Math.floor(Date.now() / 1000), nonce = randomUUID()) {
  const headers = {
    'X-Token': credential.token,
    'X-SuperAgent-Timestamp': String(nowSec),
    'X-SuperAgent-Nonce': nonce,
    'X-Route-Target': ROUTE_TARGET,
    'X-App-Version': APP_VERSION,
    'X-OS-Type': process.platform,
  }
  const deviceId = nonEmptyString(pool.deviceId)
  if (deviceId !== undefined) headers[SIGN_HEADERS_SUPER.deviceId] = deviceId
  const installId = nonEmptyString(pool.installId)
  if (installId !== undefined) headers[SIGN_HEADERS_SUPER.installId] = installId
  return headers
}

/**
 * 推理端点的签名头（两套都要发，时间戳单位不同）。
 *
 * ## ⚠️⚠️ 这一层的结论被**客户端升级**推翻过，改前必读
 *
 * 取证时用的是客户端 **2.5.3**，结论是「两组 HMAC 签名头都要发，sessionKey 由客户端
 * `randomBytes(32)` 自造、服务端不校验内容」。那份代码里确实有：
 * ```js
 * const wee = "local-v1", tPt = "X-SA-Sign-Version", …;
 * signRequest(e) {
 *   const r = this.sessionKey;                       // randomBytes(32).toString('base64url')
 *   const s = String(Date.now()), o = randomBytes(12).hex;
 *   const a = [wee, method, path, s, o].join("\n");
 *   return { "X-SA-Sign-Version": wee, …, "X-SA-Signature": HMAC(key, a) };
 * }
 * ```
 *
 * **但本机现在装的是 3.0.0-rc.1**，实测它：
 * - 仍发 `X-SA-Sign-Version` / `X-SA-Timestamp` / `X-SA-Nonce` / `X-SA-Signature`；
 * - **不再发** `X-SuperAgent-Signature`（全 asar 0 命中该头名）；
 * - `X-SuperAgent-*` 只留 `Timestamp`（秒）/ `Nonce`(UUID) / `Device-Id` / `Install-Id`；
 * - `Authorization` 换成 `Basic base64("super-agent:<进程内随机串>")` —— 那是**本地 IPC**
 *   认证用的，不是上游凭据。
 *
 * 实测三种组合（真实 token + 真实 deviceId/installId）：
 *
 * | 发什么 | 上游返回 |
 * |---|---|
 * | 两组签名齐全 + `Authorization: Bearer <2.5.3 apiKey>` | `40104 unsupported sign version` |
 * | 只发 `X-SA-*`（缺 `X-SuperAgent-*`） | `40101 missing super agent security headers` |
 * | 完全不发 `X-SA-*` | `40105 您的请求疑似攻击请求` |
 *
 * ⇒ **服务端确实校验了 `X-SA-Signature` 的真实性**，「自造 key 也能过」的旧结论在
 * 3.0.0 上不成立；而真正的 `sessionKey` 只活在**客户端主进程内存**里
 * （它经 `SUPER_AGENT_LOCAL_SESSION_KEY` 环境变量交给自己的 Go 子进程，
 * 落盘没有、进程外拿不到）。
 *
 * 因此这里**不再伪造签名**：发一组服务端必然判为伪造的签名，只会换来
 * `40104/40105`，比诚实报错更难排查。算法仍保留在下面 —— 一旦将来能拿到真实
 * sessionKey（比如客户端开了可读的 IPC 出口），把它放进 `pool.signKey` 并置
 * `pool.trustedSignKey = true` 即可，无需改别处。
 *
 * 算法（客户端原文）：
 * ```
 * X-SA-*        msg = ["local-v1", METHOD, pathWithQuery, 毫秒时间戳, 12字节hex nonce].join("\n")
 *               sig = HMAC-SHA256(sessionKey, msg).digest("base64url")
 * X-SuperAgent-*（3.0.0 已不发 Signature；2.5.3 是 ["秒时间戳", UUID].join("\n")）
 * ```
 */
export function signHeaders(method, pathWithQuery, pool = {}, nowMs = Date.now()) {
  // ⚠️ 只有**真实** sessionKey 才发签名。自造 key 会被 40104/40105 拒 ——
  // 那正是「服务端校验了内容」的证据。
  const signKey = nonEmptyString(pool.signKey)
  if (signKey === undefined || pool.trustedSignKey !== true) return {}

  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`

  const saTs = String(nowMs)
  const saNonce = randomBytes(12).toString('hex')
  const saMsg = [SIGN_VERSION, String(method).toUpperCase(), path, saTs, saNonce].join('\n')
  const saSig = createHmac('sha256', signKey).update(saMsg).digest('base64url')

  const supTs = String(Math.floor(nowMs / 1000))
  const supNonce = randomUUID()
  const supSig = createHmac('sha256', signKey).update([supTs, supNonce].join('\n')).digest('base64url')

  return {
    [SIGN_HEADERS.version]: SIGN_VERSION,
    [SIGN_HEADERS.timestamp]: saTs,
    [SIGN_HEADERS.nonce]: saNonce,
    [SIGN_HEADERS.signature]: saSig,
    [SIGN_HEADERS_SUPER.version]: SIGN_VERSION,
    [SIGN_HEADERS_SUPER.timestamp]: supTs,
    [SIGN_HEADERS_SUPER.nonce]: supNonce,
    [SIGN_HEADERS_SUPER.signature]: supSig,
  }
}

/**
 * 业务端点请求头（**不设 `Authorization`**）。
 *
 * 业务端点只认 `X-Token`；加一个假的 Bearer 会让网关走错校验分支。
 */
export function businessHeaders(credential, pool = {}) {
  return {
    ...identityHeaders(credential, pool),
    Accept: 'application/json',
  }
}

/**
 * 推理请求头。
 *
 * `Authorization: Bearer <内置渠道 apiKey>`（渠道身份）+ `X-Token`（用户身份）
 * + 两套签名头。
 */
export function inferHeaders(credential, pool = {}, options = {}) {
  const method = options.method ?? 'POST'
  const pathWithQuery = options.pathWithQuery ?? INFER_PATH
  return {
    Authorization: `Bearer ${INFER_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...identityHeaders(credential, pool),
    ...signHeaders(method, pathWithQuery, pool),
  }
}

/** 拼接绝对 URL。 */
export function absoluteUrl(path) {
  return `${API_BASE}${path}`
}

/**
 * 解析 `user_info` 响应 → `{ accountId, accountName, phone, avatar }`。
 *
 * 信封约定：`code === 0 || code === 200 || success === true` 时取 `data`；
 * 这里同时容忍「已剥信封」与「套 data」两种形状。
 * 拿不到 `accountId` ⇒ `undefined`（**不编造**：它是账号去重的唯一稳定判据）。
 */
export function parseUserInfo(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const data = typeof payload.data === 'object' && payload.data !== null && !Array.isArray(payload.data)
    ? payload.data
    : payload
  const accountId = nonEmptyString(data.accountId) ?? nonEmptyString(data.account_id) ?? nonEmptyString(data.uid)
  if (accountId === undefined) return undefined
  return {
    accountId,
    accountName: nonEmptyString(data.accountName) ?? nonEmptyString(data.account_name) ?? '',
    phone: nonEmptyString(data.phone) ?? nonEmptyString(data.mobile) ?? '',
    avatar: nonEmptyString(data.avatar) ?? '',
  }
}

/** 构造可区分的账号展示名（优先手机号尾号）。 */
export function displayNickname(info) {
  const phone = nonEmptyString(info?.phone)
  if (phone !== undefined && phone.length >= 4) return `电信 ${phone.slice(-4)}`
  const name = nonEmptyString(info?.accountName)
  if (name !== undefined) return `电信 ${name}`
  return `电信 ${String(info?.accountId ?? '').slice(-6)}`
}
