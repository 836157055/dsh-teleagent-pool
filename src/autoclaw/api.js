/**
 * AutoClaw 的业务端点：签报头、余额、积分过期、模型目录、token 刷新。
 *
 * ## 两个凭据在两个不同的头上（与 TeleAgent 同型的坑）
 *
 * ```
 * X-Auth-Sign: md5(appId & timestamp & appKey)   ← 客户端身份（硬编码）
 * X-Authorization: Bearer <用户 accessToken>     ← 用户身份
 * ```
 * ⚠️ 把用户 token 放进 `Authorization` 会被判 `401001 Invalid token`
 * （实测：`Authorization` 与 `X-Authorization` 同时带 token 会走另一分支）。
 *
 * ## 实测矩阵（已跑通/已验证）
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` | **200**，`data.total_balance` |
 * | `GET /agent-assetmgr/api/v1/points/expiring` | **200** |
 * | `GET /autoclaw-proxy/proxy/third-party-provider-config` | **200**，含 `supportedModels` |
 *
 * @module dsh-teleagent-pool/src/autoclaw/api
 */

import crypto from 'node:crypto'
import {
  AGENT_REFRESH_PATH,
  API_BASE,
  APP_ID,
  APP_KEY,
  CHANNEL,
  CLIENT_VERSION,
  EXPIRING_PATH,
  PRODUCT,
  PROVIDER_CONFIG_PATH,
  REFRESH_PATH,
  REQUEST_TIMEOUT_MS,
  WALLET_PATH,
} from './product.js'
import { fetchWithTimeout, readJson } from '../http.js'
import { stripBearer } from './credential.js'

/**
 * 计算签报头。
 *
 * 原文（`main.cjs` 的 `HSe`）：
 * ```
 * X-Auth-Sign = md5(`${appId}&${seconds}&${appKey}`)
 * ```
 * ⚠️ 时间戳是**秒**；写成毫秒会被判越界。
 *
 * ## ⚠️⚠️ 两类端点把 token 放在**不同**的头里（实测，别搞反）
 *
 * | 端点族 | token 头 | 放错的表现 |
 * |---|---|---|
 * | **业务端点**（`/agent-assetmgr/*`、`/autoclaw-proxy/proxy/third-party-provider-config`） | `Authorization` | 放进 `X-Authorization` → `410000 用户未登录` |
 * | **推理端点**（`/autoclaw-proxy/proxy/autoclaw/chat/completions`） | `X-Authorization` | 放进 `Authorization` → `401001 Invalid token` |
 *
 * 两个头**同时带**是安全的（业务端点仍然 200，因为 `Authorization` 优先）。
 * 但为了不掩盖「放错头」这类缺陷，默认行为按调用方明确指定。
 *
 * @param {string} token
 * @param {{ nowSec?: number, tokenHeader?: 'Authorization' | 'X-Authorization' }} [options]
 */
export function signedHeaders(token, options = {}) {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000)
  const tokenHeader = options.tokenHeader ?? 'Authorization'
  const headers = {
    'X-Version': CLIENT_VERSION,
    // 原文 `GSe(platform)`：win32 → 'win'，darwin → 'mac'，其它原样
    'X-Tm': process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform,
    'X-Product': PRODUCT,
    'X-Auth-Appid': APP_ID,
    'X-Auth-TimeStamp': String(nowSec),
    'X-Auth-Sign': crypto.createHash('md5').update(`${APP_ID}&${nowSec}&${APP_KEY}`).digest('hex'),
    'X-Lang': 'zh-CN',
    'X-Channel': CHANNEL,
  }
  const clean = stripBearer(token)
  if (clean !== undefined) headers[tokenHeader] = `Bearer ${clean}`
  return headers
}

/** 业务 GET，返回 `{ ok, status, payload }`（不抛错）。 */
async function getJson(path, token, options = {}) {
  try {
    const response = await fetchWithTimeout(
      `${API_BASE}${path}`,
      {
        method: 'GET',
        headers: { ...signedHeaders(token, options), Accept: 'application/json' },
        signal: options.signal,
      },
      REQUEST_TIMEOUT_MS,
    )
    const { payload, text } = await readJson(response)
    return { ok: response.ok, status: response.status, payload, text }
  } catch (error) {
    return { ok: false, status: 0, payload: undefined, text: error instanceof Error ? error.message : String(error) }
  }
}

/** 取业务码（信封 `code`）。 */
function businessCode(payload) {
  const code = payload?.code
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined
}

/**
 * 查询积分余额。
 *
 * ⚠️ 取不到字段时返回 `null`（**查询失败**），不是 0 —— 报 0 会让用户以为积分清零。
 *
 * @returns {{ total: number, wallets: Array<{type: string, name: string, balance: number}> } | null}
 */
export async function fetchBalance(token, options = {}) {
  const result = await getJson(`${WALLET_PATH}?biz_app_id=${PRODUCT}`, token, options)
  if (!result.ok) return null
  if (businessCode(result.payload) !== 0) return null
  const data = result.payload?.data
  const total = Number(data?.total_balance)
  if (!Number.isFinite(total)) return null
  const wallets = Array.isArray(data?.wallets)
    ? data.wallets
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        type: String(row.public_wallet_type ?? ''),
        name: String(row.display_name ?? ''),
        balance: Number(row.balance) || 0,
        visible: row.display === true,
      }))
    : []
  return { total: Math.round(total * 100) / 100, wallets }
}

/** 即将过期积分。 */
export async function fetchExpiring(token, options = {}) {
  const result = await getJson(EXPIRING_PATH, token, options)
  if (!result.ok || businessCode(result.payload) !== 0) return null
  const data = result.payload?.data
  const expiring = Number(data?.expiring_points)
  const total = Number(data?.total_points)
  if (!Number.isFinite(total)) return null
  return {
    expiring: Number.isFinite(expiring) ? expiring : 0,
    total,
    windowValue: Number(data?.expire_time_value) || 0,
    windowUnit: String(data?.expire_time_type ?? ''),
  }
}

/**
 * 拉**第三方渠道**清单（智谱 / DeepSeek / MiniMax / 金源…）。
 *
 * ⚠️⚠️ **这不是推理用的模型目录**（这一点我搞错过，代价是每次对话回 `400 非法模型`）。
 *
 * | 数据源 | 用途 |
 * |---|---|
 * | 本函数（`third-party-provider-config`） | **BYOK 第三方**清单：用户自带 key 才能用。AutoClaw 自己的账号对它**无权**。展示用，不可喂推理端点。 |
 * | `readAccountModelCatalog()`（账号级 `remote-snapshot.json`） | **托管网关**真正接受的 model 名，5 条 `zai_*` / `zaicoding_*`。推理必须用它。 |
 *
 * 实测：把这里的 `glm-5.3` 发给推理端点 → `400 {"message":"非法模型"}`；
 * 换成账号级目录的 `zaicoding_glm-5.3` → `406`（名字对了，只差 scope 握手）。
 */
export async function fetchProviderConfig(token, options = {}) {
  const result = await getJson(PROVIDER_CONFIG_PATH, token, options)
  if (!result.ok || businessCode(result.payload) !== 0) return null
  const providers = result.payload?.data?.providers
  if (!Array.isArray(providers)) return null

  const channels = []
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue
    const id = typeof provider.id === 'string' ? provider.id : ''
    const endpoints = Array.isArray(provider.endpoints) ? provider.endpoints : []
    if (id === '' || endpoints.length === 0) continue
    if (provider.enabled === false) continue
    channels.push({
      id,
      name: typeof provider.name === 'string' ? provider.name : id,
      accessType: typeof provider.accessType === 'string' ? provider.accessType : '',
      endpoints: endpoints
        .filter((row) => row && typeof row.baseUrl === 'string')
        .map((row) => ({ protocol: String(row.protocol ?? ''), baseUrl: row.baseUrl })),
      models: Array.isArray(provider.supportedModels) ? provider.supportedModels.length : 0,
      /** 这些 id **只能**给 BYOK 用，不要拿去推理。 */
      byokModelIds: Array.isArray(provider.supportedModels)
        ? provider.supportedModels
          .filter((row) => row && typeof row.id === 'string')
          .map((row) => row.id)
        : [],
    })
  }
  return { channels }
}

/**
 * 刷新 access token。
 *
 * 原文（`main.cjs` 的 `k4e.refresh`）：先打 `/userapi/v1/refresh`，
 * 业务码 `400002` 时回退 `/userapi/v1/agent-refresh`。
 *
 * ⚠️ 两个端点都**没有**在插件侧验证过真实刷新（需要真过期才能触发）；
 * 失败时返回 `undefined`，调用方据此把账号标成「需重新打开 AutoClaw 登录」。
 *
 * @returns {{ accessToken: string, refreshToken: string } | undefined}
 */
export async function refreshToken(refreshTokenValue, options = {}) {
  const clean = stripBearer(refreshTokenValue)
  if (clean === undefined) return undefined
  const deviceId = options.deviceId ?? ''
  const body = { refresh_token: clean, source_id: PRODUCT, device_id: deviceId }

  for (const path of [REFRESH_PATH, AGENT_REFRESH_PATH]) {
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}${path}`,
        {
          method: 'POST',
          headers: { ...signedHeaders(undefined, options), 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: options.signal,
        },
        REQUEST_TIMEOUT_MS,
      )
      const { payload } = await readJson(response)
      if (!response.ok) continue
      const code = businessCode(payload)
      if (code !== 0) continue
      const data = payload?.data
      const accessToken = stripBearer(data?.access_token)
      if (accessToken === undefined) continue
      return {
        accessToken,
        refreshToken: stripBearer(data?.refresh_token) ?? clean,
      }
    } catch {
      // 下一个端点
    }
  }
  return undefined
}
