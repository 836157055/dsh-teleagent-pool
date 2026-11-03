/**
 * AutoClaw 凭据保管：切号时**备份**凭据，切回时**还原**。
 *
 * ## 为什么需要这一层（实测事实）
 *
 * AutoClaw 切号时会**物理删除**旧账号的 `account-credentials.enc`：
 * ```js
 * clearForUserSignOut() {
 *   await rm(this.filePath, { force: true })   // ← 直接 rm，不是移动
 *   return true
 * }
 * ```
 * 所以切走之后旧账号就变成「有 profile、无凭据」的空壳 —— 界面上那条
 * 「没有凭据文件」是**真实**的，不是误报。
 *
 * ## 但凭据是可以救回来的
 *
 * vault 按 accountKey 分目录存放（客户端原文）：
 * ```js
 * accountStores(partition) {
 *   return { vault: new Vault(join(partition.accountRoot, "account-credentials.enc"), ...) }
 * }
 * ```
 * ⇒ **切号前把该文件复制到我们的保管目录**，切回来时**复制回去**，凭据就回来了。
 *
 * ## 边界（必须说清楚）
 *
 * - 备份的是**加密后的文件本身**（`v10` AES-256-GCM）。它不是明文 token，
 *   仍受 DPAPI 主密钥保护，换用户/换机器解不开 —— 和其它账号凭据同等安全级别。
 * - token 有有效期。保管的是「切号那一刻的快照」，隔太久切回来可能已过期，
 *   那时客户端会要求重新登录。这一步**不能**替代真正的重新登录。
 * - 因此这里的定位是：**短期来回切号不用重新登录**，不是永久凭据仓库。
 *
 * @module dsh-teleagent-pool/src/autoclaw/vaultkeeper
 */

import fs from 'node:fs'
import path from 'node:path'

import { ACCOUNTS_DIR, CREDENTIAL_FILE } from './product.js'

/** 保管目录名（放在插件自己的数据目录下，不污染客户端）。 */
export const KEEP_DIR_NAME = 'autoclaw-credential-backup'

/** 备份文件名：`<accountKey>.enc` + 一份元数据。 */
function backupPath(keepRoot, accountKey) {
  return path.join(keepRoot, `${accountKey}.enc`)
}

function metaPath(keepRoot, accountKey) {
  return path.join(keepRoot, `${accountKey}.json`)
}

/**
 * 把一个账号的凭据备份到保管目录。
 *
 * @param {object} options
 * @param {string} options.userDataDir - 客户端 userData 目录
 * @param {string} options.keepRoot - 保管目录（插件数据目录下）
 * @param {string} options.accountKey
 * @returns {{ ok: boolean, reason?: string, bytes?: number }}
 */
export function backupCredential(options) {
  const source = path.join(options.userDataDir, ACCOUNTS_DIR, options.accountKey, CREDENTIAL_FILE)
  if (!fs.existsSync(source)) {
    return { ok: false, reason: '该账号目录里没有凭据文件（无可备份）' }
  }
  try {
    fs.mkdirSync(options.keepRoot, { recursive: true })
    const target = backupPath(options.keepRoot, options.accountKey)
    // 先写临时文件再 rename：避免半截文件顶掉一份好备份
    const tmp = `${target}.${process.pid}.tmp`
    fs.copyFileSync(source, tmp)
    fs.renameSync(tmp, target)
    const bytes = fs.statSync(target).size
    fs.writeFileSync(
      metaPath(options.keepRoot, options.accountKey),
      `${JSON.stringify({ accountKey: options.accountKey, savedAt: Date.now(), bytes })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    return { ok: true, bytes }
  } catch (error) {
    return { ok: false, reason: `备份失败：${error?.message ?? String(error)}` }
  }
}

/**
 * 把保管的凭据还原到账号目录。
 *
 * ⚠️ 只在**目标位置没有凭据**时还原：客户端自己的凭据更新（token 刷新）
 * 永远优先，别用旧快照覆盖它。
 *
 * @returns {{ ok: boolean, reason?: string, skipped?: boolean }}
 */
export function restoreCredential(options) {
  const backup = backupPath(options.keepRoot, options.accountKey)
  if (!fs.existsSync(backup)) {
    return { ok: false, reason: '没有该账号的备份' }
  }
  const target = path.join(options.userDataDir, ACCOUNTS_DIR, options.accountKey, CREDENTIAL_FILE)
  if (fs.existsSync(target)) {
    // 已有更"新"的凭据（客户端自己写的），保留它
    return { ok: true, skipped: true }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    fs.copyFileSync(backup, tmp)
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, target)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `还原失败：${error?.message ?? String(error)}` }
  }
}

/** 列出保管目录里有哪些账号的备份（供 UI 展示「可还原」）。 */
export function listBackups(keepRoot) {
  try {
    return fs.readdirSync(keepRoot)
      .filter((name) => name.endsWith('.enc'))
      .map((name) => {
        const accountKey = name.slice(0, -4)
        let savedAt = 0
        let bytes = 0
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath(keepRoot, accountKey), 'utf8'))
          savedAt = Number(meta.savedAt) || 0
          bytes = Number(meta.bytes) || 0
        } catch {
          // 元数据缺失不影响凭据本身
        }
        return { accountKey, savedAt, bytes }
      })
      .sort((left, right) => right.savedAt - left.savedAt)
  } catch {
    return []
  }
}

/** 删掉某个账号的备份（用户想彻底清掉时用）。 */
export function dropBackup(keepRoot, accountKey) {
  let removed = false
  for (const file of [backupPath(keepRoot, accountKey), metaPath(keepRoot, accountKey)]) {
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true })
        removed = true
      }
    } catch {
      // 删不掉就留着，不抛
    }
  }
  return removed
}
