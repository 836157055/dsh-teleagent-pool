/**
 * 账号切换模块测试：指针读写、可切换判定、非法输入拒绝。
 *
 * 这些用例锁的是**「谁能切、切了有没有用」**：
 * 只有 `account-credentials.enc` 存在的账号才值得切，空壳目录切过去是白切。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  POINTER_FILE,
  listSwitchableAccounts,
  readActiveAccountKey,
  writeActiveAccountKey,
} from '../src/autoclaw/switch.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

/** 造一个假的 AutoClaw 用户目录。 */
function fakeUserData({ activeKey, accounts }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acw-switch-'))
  for (const account of accounts) {
    const dir = path.join(root, 'accounts', account.key)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'account-profile.json'),
      JSON.stringify({ schemaVersion: 1, profile: { phone: account.phone ?? '' } }),
    )
    if (account.hasCredential) {
      fs.writeFileSync(path.join(dir, 'account-credentials.enc'), 'v10fake')
    }
  }
  if (activeKey !== undefined) {
    fs.mkdirSync(path.join(root, 'device'), { recursive: true })
    fs.writeFileSync(
      path.join(root, POINTER_FILE),
      JSON.stringify({ schemaVersion: 1, accountKey: activeKey }),
    )
  }
  return root
}

test('readActiveAccountKey 读出 64 位 hex key；形状不对则返回 undefined', () => {
  const root = fakeUserData({
    activeKey: KEY_A,
    accounts: [{ key: KEY_A, hasCredential: true }],
  })
  assert.equal(readActiveAccountKey({ userDataDir: root }), KEY_A)

  // 指针不存在
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'acw-none-'))
  assert.equal(readActiveAccountKey({ userDataDir: empty }), undefined)

  // schemaVersion 错
  fs.mkdirSync(path.join(empty, 'device'), { recursive: true })
  fs.writeFileSync(path.join(empty, POINTER_FILE), JSON.stringify({ schemaVersion: 2, accountKey: KEY_A }))
  assert.equal(readActiveAccountKey({ userDataDir: empty }), undefined)

  // key 形状错（大写/长度不对）
  fs.writeFileSync(path.join(empty, POINTER_FILE), JSON.stringify({ schemaVersion: 1, accountKey: 'ABC' }))
  assert.equal(readActiveAccountKey({ userDataDir: empty }), undefined)
})

test('listSwitchableAccounts：只有带凭据的账号才算 switchable', () => {
  const root = fakeUserData({
    activeKey: KEY_A,
    accounts: [
      { key: KEY_A, hasCredential: true, phone: '182****3513' },
      // 空壳：只有 profile，没有凭据（本机 7948 就是这个状态）
      { key: KEY_B, hasCredential: false, phone: '190****7948' },
    ],
  })

  const rows = listSwitchableAccounts({ userDataDir: root })
  assert.equal(rows.length, 2)

  const active = rows.find((row) => row.accountKey === KEY_A)
  assert.equal(active.active, true)
  assert.equal(active.hasCredential, true)
  // 自己不用切自己
  assert.equal(active.switchable, false)

  const shell = rows.find((row) => row.accountKey === KEY_B)
  assert.equal(shell.active, false)
  assert.equal(shell.hasCredential, false)
  // ⚠️ 关键：缺凭据 ⇒ 不可切（切过去没有凭据可用）
  assert.equal(shell.switchable, false)
  assert.equal(shell.phone, '190****7948')
})

test('listSwitchableAccounts：两个都有凭据时，非激活的那个可切', () => {
  const root = fakeUserData({
    activeKey: KEY_A,
    accounts: [
      { key: KEY_A, hasCredential: true },
      { key: KEY_B, hasCredential: true },
    ],
  })
  const rows = listSwitchableAccounts({ userDataDir: root })
  assert.equal(rows.find((row) => row.accountKey === KEY_B).switchable, true)
  assert.equal(rows.find((row) => row.accountKey === KEY_A).switchable, false)
})

test('writeActiveAccountKey：拒绝非法 key，拒绝无凭据账号', () => {
  const root = fakeUserData({
    activeKey: KEY_A,
    accounts: [
      { key: KEY_A, hasCredential: true },
      { key: KEY_B, hasCredential: false },
    ],
  })

  // 形状不合法
  assert.equal(writeActiveAccountKey('not-hex', { userDataDir: root }).ok, false)
  assert.equal(writeActiveAccountKey(KEY_A.toUpperCase(), { userDataDir: root }).ok, false)
  assert.equal(writeActiveAccountKey('', { userDataDir: root }).ok, false)

  // 无凭据文件 ⇒ 拒绝（否则切过去要重新登录，等于失败）
  const noCred = writeActiveAccountKey(KEY_B, { userDataDir: root })
  assert.equal(noCred.ok, false)
  assert.match(noCred.reason, /凭据/u)

  // 指针没被改动
  assert.equal(readActiveAccountKey({ userDataDir: root }), KEY_A)
})

test('writeActiveAccountKey：合法切换会原子写入并可读回', () => {
  const root = fakeUserData({
    activeKey: KEY_A,
    accounts: [
      { key: KEY_A, hasCredential: true },
      { key: KEY_B, hasCredential: true },
    ],
  })

  const result = writeActiveAccountKey(KEY_B, { userDataDir: root })
  assert.equal(result.ok, true)
  assert.equal(readActiveAccountKey({ userDataDir: root }), KEY_B)

  // 写出来的必须是客户端能读的明文 JSON（无签名）
  const raw = JSON.parse(fs.readFileSync(path.join(root, POINTER_FILE), 'utf8'))
  assert.deepEqual(raw, { schemaVersion: 1, accountKey: KEY_B })

  // 没有残留临时文件
  const leftovers = fs.readdirSync(path.join(root, 'device')).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('switchAvailable 判据：至少 2 个带凭据账号', () => {
  const one = fakeUserData({
    activeKey: KEY_A,
    accounts: [{ key: KEY_A, hasCredential: true }, { key: KEY_B, hasCredential: false }],
  })
  const rowsOne = listSwitchableAccounts({ userDataDir: one })
  assert.equal(rowsOne.filter((row) => row.hasCredential).length, 1)
  assert.equal(rowsOne.filter((row) => row.hasCredential).length >= 2, false)

  const two = fakeUserData({
    activeKey: KEY_A,
    accounts: [{ key: KEY_A, hasCredential: true }, { key: KEY_B, hasCredential: true }],
  })
  const rowsTwo = listSwitchableAccounts({ userDataDir: two })
  assert.equal(rowsTwo.filter((row) => row.hasCredential).length >= 2, true)
})
