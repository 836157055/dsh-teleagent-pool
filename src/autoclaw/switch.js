/**
 * AutoClaw 账号切换 —— 「自动换号」的真正实现。
 *
 * ## 结论先说：**做得到，但每次换号都要重启 AutoClaw 进程**
 *
 * 三条实测事实（都来自 `main.cjs` 原文，不是推测）：
 *
 * 1. **本地配对协议没有切号操作**：`hds` 的 31 项 operation 里没有任何一项能换账号。
 * 2. **切号必须重启 AutoClaw**：
 *    ```js
 *    commitLogin(profile, credentials) {
 *      const n = this.snapshot()
 *      if (n.status === "authenticated")
 *        return n.account.accountId === r.accountId
 *          ? { ok: true }
 *          : { ok: false, failure: "account_switch_requires_restart" }
 *    }
 *    ```
 * 3. **但账号指针是明文、无签名**：
 *    ```js
 *    class Pointer {
 *      readUnlocked() {
 *        const e = JSON.parse(await readFile(this.filePath, "utf8"))
 *        if (e.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(e.accountKey)) throw …
 *        return e.accountKey          // ← 只校验格式，没有 HMAC/签名
 *      }
 *      write(key) { … JSON.stringify({ schemaVersion: 1, accountKey: key }) … }
 *    }
 *    ```
 *    ⇒ 改写 `device/active-product-account.json` 再重启客户端，账号就换过去了。
 *
 * ## 所以「自动换号」的完整流程是
 *
 * ```
 * 额度耗尽
 *   → 找池里另一个**有凭据**的账号
 *   → 改写账号指针
 *   → 重启 AutoClaw（必须）
 *   → 等它重新拉起 office-plugin
 *   → 重新配对
 *   → 用新账号重试
 * ```
 *
 * ⚠️ 代价很大：重启客户端要十几秒、会打断用户正在做的事。
 * 所以它**不能**做成「悄悄在后台换」—— 必须由用户明确开启（默认关闭）。
 *
 * @module dsh-teleagent-pool/src/autoclaw/switch
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ACCOUNTS_DIR, CREDENTIAL_FILE, USER_DATA_DIR } from './product.js'
import { backupCredential, restoreCredential } from './vaultkeeper.js'

/** 指针文件的相对路径（客户端常量 `device/active-product-account.json`）。 */
export const POINTER_FILE = 'device/active-product-account.json'

/** 账号 key 的合法形状（客户端 `oPt` 同款正则）。 */
const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/u

/** 客户端主进程的可执行文件名（用于重启）。 */
const DESKTOP_EXE_CANDIDATES = ['AutoClaw2.exe', 'AutoClaw.exe']

/** 用户数据目录。 */
export function userDataDir(override) {
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override.trim())
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, USER_DATA_DIR)
}

/** 读当前激活账号的 key（读不到返回 `undefined`）。 */
export function readActiveAccountKey(options = {}) {
  try {
    const pointer = JSON.parse(
      fs.readFileSync(path.join(userDataDir(options.userDataDir), POINTER_FILE), 'utf8'),
    )
    if (pointer?.schemaVersion !== 1) return undefined
    const key = pointer?.accountKey
    return typeof key === 'string' && ACCOUNT_KEY_PATTERN.test(key) ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * 列出本机所有账号，标注「能不能切」。
 *
 * ⚠️ **`hasCredential === false` 的账号切过去毫无意义**：
 * 那个目录只是登录尝试留下的空壳（`account-profile.json` 在、`account-credentials.enc` 不在），
 * 切过去以后客户端会要求重新登录。本机 190****7948 就是这种状态。
 */
export function listSwitchableAccounts(options = {}) {
  const root = userDataDir(options.userDataDir)
  const activeKey = readActiveAccountKey({ userDataDir: root })
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, ACCOUNTS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
  } catch {
    return []
  }

  return entries.map((entry) => {
    const dir = path.join(root, ACCOUNTS_DIR, entry.name)
    const hasCredential = fs.existsSync(path.join(dir, CREDENTIAL_FILE))
    let phone = ''
    try {
      phone = JSON.parse(fs.readFileSync(path.join(dir, 'account-profile.json'), 'utf8'))?.profile?.phone ?? ''
    } catch {
      // 读不到就是空
    }
    return {
      accountKey: entry.name,
      phone,
      hasCredential,
      active: entry.name === activeKey,
      switchable: hasCredential && entry.name !== activeKey,
    }
  })
}

/**
 * 改写账号指针（**不重启**，纯文件操作）。
 *
 * ## 切号前会自动保管两个凭据
 *
 * 客户端切号时会**物理删除**旧账号的 `account-credentials.enc`
 * （`clearForUserSignOut` 里是 `rm(filePath, {force:true})`）。所以这里在改指针**之前**：
 *
 * 1. 备份**当前**激活账号的凭据（否则切走就没了）；
 * 2. 如果**目标**账号的凭据正好在保管里、而它的目录是空的，先还原回去
 *    —— 这样「切回去」不用重新登录。
 *
 * @param {string} accountKey
 * @param {{
 *   userDataDir?: string,
 *   keepRoot?: string,
 * }} [options]
 * @returns {{ ok: true, backups?: object } | { ok: false, reason: string }}
 */
export function writeActiveAccountKey(accountKey, options = {}) {
  if (typeof accountKey !== 'string' || !ACCOUNT_KEY_PATTERN.test(accountKey)) {
    return { ok: false, reason: '账号 key 形状不合法（应为 64 位小写 hex）' }
  }

  const root = userDataDir(options.userDataDir)
  const keepRoot = options.keepRoot
  const targetCredential = path.join(root, ACCOUNTS_DIR, accountKey, CREDENTIAL_FILE)

  // ① 目标账号的凭据：目录里没有但保管里有 ⇒ 先还原（切回去免登录）
  let restored = false
  if (keepRoot !== undefined && !fs.existsSync(targetCredential)) {
    const restoredResult = restoreCredential({ userDataDir: root, keepRoot, accountKey })
    restored = restoredResult.ok === true && restoredResult.skipped !== true
  }

  if (!fs.existsSync(targetCredential)) {
    return {
      ok: false,
      reason: restored
        ? '还原凭据失败（备份文件可能损坏）'
        : '该账号没有凭据文件，也没有可还原的备份（需先在 AutoClaw 里登录一次）',
    }
  }

  // ② 切走前：把**当前**激活账号的凭据备份好，否则客户端 rm 之后就再也回不来
  let backup
  if (keepRoot !== undefined) {
    const current = readActiveAccountKey({ userDataDir: root })
    if (current !== undefined && current !== accountKey) {
      backup = backupCredential({ userDataDir: root, keepRoot, accountKey: current })
    }
  }

  const file = path.join(root, POINTER_FILE)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 与客户端同款：原子写 + 0600
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, accountKey })}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, restored, backup }
  } catch (error) {
    return { ok: false, reason: `写指针失败：${error?.message ?? String(error)}` }
  }
}

/**
 * 重启 AutoClaw 桌面端。
 *
 * ⚠️ 这一步是**必须**的（`account_switch_requires_restart`），也是这个特性最大的成本：
 * 客户的会话窗口会被关掉，重新起来要十几秒。
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export function restartAutoClaw(options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000
  return new Promise((resolve) => {
    // 先找进程与可执行文件路径
    execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        '$p = Get-Process -Name "AutoClaw2","AutoClaw" -ErrorAction SilentlyContinue | Select-Object -First 1',
        'if (-not $p) { "NOT_RUNNING"; exit }',
        '$path = $p.Path',
        'Stop-Process -Name "AutoClaw2","AutoClaw" -Force -ErrorAction SilentlyContinue',
        'Start-Sleep -Milliseconds 800',
        'Start-Process -FilePath $path',
        '"RESTARTED:" + $path',
      ].join('\n'),
    ], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      const text = String(stdout ?? '')
      if (error) {
        resolve({ ok: false, reason: `重启失败：${error.message}` })
        return
      }
      if (text.includes('NOT_RUNNING')) {
        resolve({ ok: false, reason: 'AutoClaw 当前没有运行（无需切换：下次启动会自动用新账号）' })
        return
      }
      if (text.includes('RESTARTED:')) {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, reason: `重启结果不明：${text.trim().slice(0, 200)}` })
    })
  })
}

/** 可执行文件是否存在（用于给出更准确的错误信息）。 */
export function desktopExecutableHint() {
  for (const name of DESKTOP_EXE_CANDIDATES) {
    for (const dir of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'D:\\APP', 'C:\\Program Files']) {
      if (typeof dir !== 'string') continue
      const candidate = path.join(dir, 'AutoClaw2', name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return undefined
}
