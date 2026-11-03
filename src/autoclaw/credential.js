/**
 * 从 AutoClaw 桌面端**本地**读 token（这是它比 TeleAgent 好用的地方：零手工）。
 *
 * ## 链路（两步，都已实测跑通）
 *
 * 1. `Local State` 的 `os_crypt.encrypted_key` 是 `DPAPI` + 该用户的 DPAPI blob
 *    → `ProtectedData.Unprotect` 得到 **32 字节 AES 主密钥**；
 * 2. `accounts/<hash>/account-credentials.enc` 是 `v10` + 12B IV + 密文 + 16B tag
 *    → `AES-256-GCM` 解出 JSON：`{ accessToken, refreshToken, tokenType, … }`。
 *
 * ⚠️ 第 1 步的 DPAPI 只能在**同一个 Windows 用户**下解 —— 这是设计如此（Electron
 * safeStorage 就是这么保护凭据的）。换个用户或换台机器解不开，这是**正确行为**，
 * 不是缺陷：能解才说明是本人在用本机登录态的账号。
 *
 * ⚠️ `accessToken` 的值**自带 `Bearer ` 前缀**（实测），用之前必须剥掉 ——
 * 不剥会导致 `Authorization: Bearer Bearer eyJ…` 这种必然 401 的请求。
 *
 * @module dsh-teleagent-pool/src/autoclaw/credential
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  ACCOUNTS_DIR,
  ACTIVE_ACCOUNT_FILE,
  CREDENTIAL_FILE,
  LOCAL_STATE_FILE,
  MODEL_CATALOG_FILE,
  PROFILE_FILE,
  USER_DATA_DIR,
} from './product.js'

/** 用户数据目录（`%APPDATA%/AutoClaw-official`）。 */
export function userDataDir(override) {
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override.trim())
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, USER_DATA_DIR)
}

/**
 * 读**账号级**模型目录（推理网关真正认的那几条）。
 *
 * 路径：`accounts/<hash>/runtime/model-catalog/remote-snapshot.json`，形状：
 * ```json
 * { "models": [{ "id":"zaicoding_glm-5.3", "name":"GLM-5.3",
 *              "contextWindow":1048576, "maxTokens":307200,
 *                "reasoning":true, "input":["text"], "reasoningLevels":["low","high","max"] }] }
 * ```
 *
 * ⚠️⚠️ **这才是推理用的模型名**。另一个数据源
 * （`third-party-provider-config` 的 `glm-5.3` / `deepseek-v4-pro`…）是 **BYOK 第三方**
 * 清单，AutoClaw 自己的账号对它无权 —— 拿它去推理会得到 `400 非法模型`（实测）。
 *
 * ⚠️ 该文件由**桌面端自己**在登录后拉取缓存；本插件只读不改。
 * 用户还没在客户端里成功对话过时文件可能不存在，那时回落到兜底表。
 *
 * @param {{ userDataDir?: string }} [options]
 * @returns {Array<{ id: string, name: string, contextWindow: number, maxTokens: number,
 *   supportsImage: boolean, reasoning: boolean }>}
 */
export function readAccountModelCatalog(options = {}) {
  const root = userDataDir(options.userDataDir)
  let accountKeys
  try {
    accountKeys = fs.readdirSync(path.join(root, ACCOUNTS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }

  /** @type {Map<string, object>} */
  const seen = new Map()
  for (const accountKey of accountKeys) {
    const snapshot = readJson(path.join(root, ACCOUNTS_DIR, accountKey, MODEL_CATALOG_FILE))
    const rows = Array.isArray(snapshot?.models) ? snapshot.models : []
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || row.id.length === 0) continue
      if (seen.has(row.id)) continue
      const input = Array.isArray(row.input) ? row.input : []
      seen.set(row.id, {
        id: row.id,
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
        contextWindow: Number(row.contextWindow) > 0 ? Number(row.contextWindow) : 0,
        maxTokens: Number(row.maxTokens) > 0 ? Number(row.maxTokens) : 0,
        supportsImage: input.includes('image'),
        reasoning: row.reasoning === true,
      })
    }
  }
  return [...seen.values()]
}

/** 读 JSON（缺文件返回 undefined，不抛错）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 从 JWT 的 `exp` 解出有效期（毫秒时间戳）。
 *
 * ⚠️ AutoClaw 的 accessToken 是**标准三段 JWT**（实测 `exp` 约 30 天），
 * 与 TeleAgent 的 `tenant:jwt` 形态不同（那个要先去前缀）。这里两种都容错：
 * 带 `xxx:` 前缀就剥掉，否则直接用。
 *
 * 解不出来返回 `undefined` —— 界面显示「未知」，**不编造日期**。
 */
export function decodeJwtExpMs(token) {
  const raw = typeof token === 'string' ? token.trim() : ''
  if (raw.length === 0) return undefined
  const body = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
  const segments = body.split('.')
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

/** DPAPI 解主密钥（仅 Windows；用 PowerShell 做一次 Base64 往返）。 */
function unprotectMasterKey(encryptedKeyBase64, timeoutMs = 15_000) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('AutoClaw 凭据用 Windows DPAPI 保护，非 Windows 平台读不了'))
  }
  // ⚠️ 只把 Base64 传给 PowerShell：密钥本身不进命令行，避免出现在进程列表里。
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$blob = [Convert]::FromBase64String('${encryptedKeyBase64}')`,
    'Add-Type -AssemblyName System.Security',
    '$key = [System.Security.Cryptography.ProtectedData]::Unprotect(',
    '  $blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($key)',
  ].join('\n')

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(new Error(`DPAPI 解密失败：${error.message}`))
          return
        }
        const text = String(stdout ?? '').trim()
        if (text.length === 0) {
          reject(new Error('DPAPI 解密返回空值'))
          return
        }
        const key = Buffer.from(text, 'base64')
        if (key.length !== 32) {
          reject(new Error(`DPAPI 解出的主密钥长度异常（${key.length} 字节，应为 32）`))
          return
        }
        resolve(key)
      },
    )
  })
}

/**
 * 解一个 `account-credentials.enc`。
 *
 * @param {Buffer} masterKey - 32 字节 AES 主密钥
 * @param {string} file - 凭据文件路径
 * @returns {{ accessToken: string, refreshToken: string, tokenType: string } | undefined}
 */
export function decryptCredentialFile(masterKey, file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return undefined
  }
  if (buf.length < 3 + 12 + 16) return undefined
  const prefix = buf.subarray(0, 3).toString('ascii')
  if (prefix !== 'v10') return undefined
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, buf.subarray(3, 15))
    decipher.setAuthTag(buf.subarray(buf.length - 16))
    const plain = Buffer.concat([
      decipher.update(buf.subarray(15, buf.length - 16)),
      decipher.final(),
    ]).toString('utf8')
    const parsed = JSON.parse(plain)
    const accessToken = stripBearer(parsed?.accessToken)
    const refreshToken = stripBearer(parsed?.refreshToken)
    if (accessToken === undefined) return undefined
    return {
      accessToken,
      refreshToken: refreshToken ?? '',
      tokenType: typeof parsed?.tokenType === 'string' ? parsed.tokenType : 'Bearer',
    }
  } catch {
    return undefined
  }
}

/** 剥掉 `"Bearer "` 前缀（值本身自带，不剥必然 401）。 */
export function stripBearer(value) {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/^(?:Bearer\s+)+/i, '').trim()
  return text.length > 0 ? text : undefined
}

/**
 * 列出本机所有 AutoClaw 账号（含凭据可用性）。
 *
 * @param {{ userDataDir?: string }} [options]
 * @returns {Promise<Array<{
 *   accountKey: string, accountId: string, phone: string, numericUserId: number,
 *   token: string, refreshToken: string, hasCredential: boolean, active: boolean
 * }>>}
 */
export async function listLocalAccounts(options = {}) {
  const root = userDataDir(options.userDataDir)
  const accountsDir = path.join(root, ACCOUNTS_DIR)
  let entries
  try {
    entries = fs.readdirSync(accountsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
  if (entries.length === 0) return []

  const state = readJson(path.join(root, LOCAL_STATE_FILE))
  const encryptedKey = state?.os_crypt?.encrypted_key
  let masterKey
  if (typeof encryptedKey === 'string' && encryptedKey.length > 0) {
    // ⚠️ `encrypted_key` 是 **base64 字符串**，`DPAPI` 前缀在**解码后的字节**里
    //（base64 形如 `RFBBUEkB…`）。早期版本在 base64 串上判 `startsWith('DPAPI')`，
    // 永远为假 ⇒ 静默拿不到主密钥、所有账号都显示「无凭据」。这是同一类陷阱：
    // **判断前缀必须写在解码之后**。
    const blob = Buffer.from(encryptedKey, 'base64')
    const hasDpapiPrefix = blob.length > 5 && blob.subarray(0, 5).toString('ascii') === 'DPAPI'
    if (hasDpapiPrefix) {
      masterKey = await unprotectMasterKey(blob.subarray(5).toString('base64')).catch(() => undefined)
    } else {
      // 有些构建直接给裸 DPAPI blob（无前缀）—— 也试一次，失败就算了。
      masterKey = await unprotectMasterKey(encryptedKey).catch(() => undefined)
    }
  }

  const activeRaw = readJson(path.join(root, ACTIVE_ACCOUNT_FILE))
  const activeAccountId = typeof activeRaw?.accountId === 'string' ? activeRaw.accountId : ''

  const out = []
  for (const entry of entries) {
    const accountKey = entry.name
    const profile = readJson(path.join(accountsDir, accountKey, PROFILE_FILE))?.profile
    const accountId = typeof profile?.accountId === 'string' ? profile.accountId : ''
    const credential = masterKey === undefined
      ? undefined
      : decryptCredentialFile(masterKey, path.join(accountsDir, accountKey, CREDENTIAL_FILE))
    const token = credential?.accessToken ?? ''
    out.push({
      accountKey,
      accountId,
      phone: typeof profile?.phone === 'string' ? profile.phone : '',
      numericUserId: typeof profile?.numericUserId === 'number' ? profile.numericUserId : 0,
      token,
      refreshToken: credential?.refreshToken ?? '',
      hasCredential: credential !== undefined,
      /**
       * 凭据有效期（毫秒时间戳），从 JWT 的 `exp` 解出。
       *
       * 实测 AutoClaw 的 accessToken 是标准 JWT（`exp` 约 30 天），
       * 但**签发时不带本地缓存**，所以每次都现解 —— 解不出来就是 `null`，
       * 界面显示「未知」而不是编一个日期。
       */
      expiresAt: decodeJwtExpMs(token) ?? null,
      active: activeAccountId !== '' && accountId === activeAccountId,
    })
  }
  // 有凭据的排前面（能用的优先）
  out.sort((left, right) => Number(right.hasCredential) - Number(left.hasCredential))
  return out
}
