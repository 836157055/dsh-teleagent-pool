/**
 * 凭据保管测试：切号前备份、切回时还原、不覆盖更新的凭据。
 *
 * ## 为什么这一层存在
 *
 * AutoClaw 切号时会**物理删除**旧账号凭据：
 * ```js
 * clearForUserSignOut() { await rm(this.filePath, { force: true }) }
 * ```
 * 所以「切回去不用重新登录」的前提是**切走前备份了**。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  backupCredential,
  dropBackup,
  listBackups,
  restoreCredential,
} from '../src/autoclaw/vaultkeeper.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const CRED = 'account-credentials.enc'

/** 造一个客户端目录 + 一个保管目录。 */
function setup(accounts = []) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-user-'))
  const keepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-keep-'))
  for (const account of accounts) {
    const dir = path.join(userDataDir, 'accounts', account.key)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'account-profile.json'), JSON.stringify({ profile: { phone: account.phone ?? '' } }))
    if (account.hasCredential) {
      fs.writeFileSync(path.join(dir, CRED), account.content ?? 'v10-fake-credential')
    }
  }
  return { userDataDir, keepRoot }
}

test('backupCredential：复制密文到保管目录并留元数据', () => {
  const { userDataDir, keepRoot } = setup([{ key: KEY_A, hasCredential: true, content: 'v10-aaa' }])
  const result = backupCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  assert.equal(result.ok, true)
  assert.ok(result.bytes > 0)

  // 备份文件内容与源一致（保存的是**密文本身**，不是解出来的 token）
  const backup = path.join(keepRoot, `${KEY_A}.enc`)
  assert.equal(fs.readFileSync(backup, 'utf8'), 'v10-aaa')

  // 元数据存在且有 savedAt
  const meta = JSON.parse(fs.readFileSync(path.join(keepRoot, `${KEY_A}.json`), 'utf8'))
  assert.equal(meta.accountKey, KEY_A)
  assert.ok(meta.savedAt > 0)

  // 没有残留临时文件
  const leftovers = fs.readdirSync(keepRoot).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('backupCredential：源不存在时明确失败（不造空备份）', () => {
  const { userDataDir, keepRoot } = setup([{ key: KEY_A, hasCredential: false }])
  const result = backupCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有凭据/u)
  // 不该留下任何 .enc
  assert.deepEqual(listBackups(keepRoot), [])
})

test('restoreCredential：目标为空时还原成功（这就是「切回去免登录」）', () => {
  const { userDataDir, keepRoot } = setup([{ key: KEY_A, hasCredential: true, content: 'v10-aaa' }])

  // 先备份，再模拟客户端切号把凭据删掉
  assert.equal(backupCredential({ userDataDir, keepRoot, accountKey: KEY_A }).ok, true)
  fs.rmSync(path.join(userDataDir, 'accounts', KEY_A, CRED))
  assert.equal(fs.existsSync(path.join(userDataDir, 'accounts', KEY_A, CRED)), false)

  // 还原
  const result = restoreCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, undefined)
  assert.equal(fs.readFileSync(path.join(userDataDir, 'accounts', KEY_A, CRED), 'utf8'), 'v10-aaa')
})

test('restoreCredential：目标已有凭据时**不覆盖**（客户端刷新过的更新）', () => {
  const { userDataDir, keepRoot } = setup([{ key: KEY_A, hasCredential: true, content: 'v10-old' }])
  assert.equal(backupCredential({ userDataDir, keepRoot, accountKey: KEY_A }).ok, true)

  // 客户端自己写了更新的凭据
  fs.writeFileSync(path.join(userDataDir, 'accounts', KEY_A, CRED), 'v10-NEW')

  const result = restoreCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true, '应跳过而不是覆盖')
  // 留下的必须是新的那份
  assert.equal(fs.readFileSync(path.join(userDataDir, 'accounts', KEY_A, CRED), 'utf8'), 'v10-NEW')
})

test('restoreCredential：没有备份时明确失败', () => {
  const { userDataDir, keepRoot } = setup([{ key: KEY_A, hasCredential: false }])
  const result = restoreCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有该账号的备份/u)
})

test('listBackups：按 savedAt 倒序列出，元数据缺失也能列出', () => {
  const { userDataDir, keepRoot } = setup([
    { key: KEY_A, hasCredential: true, content: 'v10-aaa' },
    { key: KEY_B, hasCredential: true, content: 'v10-bbb' },
  ])

  backupCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  // 等一下确保时间戳有差异（同一毫秒也不会出错，只是顺序不定）
  backupCredential({ userDataDir, keepRoot, accountKey: KEY_B })

  const rows = listBackups(keepRoot)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.accountKey === KEY_A || row.accountKey === KEY_B))

  // 删掉一个元数据，凭据仍在 ⇒ 仍能列出（savedAt 归 0）
  fs.rmSync(path.join(keepRoot, `${KEY_B}.json`))
  const after = listBackups(keepRoot)
  assert.equal(after.length, 2)
  assert.equal(after.find((row) => row.accountKey === KEY_B).savedAt, 0)
})

test('dropBackup：删掉备份（用户想彻底清掉时）', () => {
  const { userDataDir, keepRoot } = setup([{ key: KEY_A, hasCredential: true }])
  backupCredential({ userDataDir, keepRoot, accountKey: KEY_A })
  assert.equal(listBackups(keepRoot).length, 1)

  assert.equal(dropBackup(keepRoot, KEY_A), true)
  assert.equal(listBackups(keepRoot).length, 0)
  // 源凭据不受影响
  assert.equal(fs.existsSync(path.join(userDataDir, 'accounts', KEY_A, CRED)), true)

  // 再删一次是 no-op
  assert.equal(dropBackup(keepRoot, KEY_A), false)
})
