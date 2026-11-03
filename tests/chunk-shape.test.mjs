/**
 * StreamChunk 形状的回归测试 —— 用**真实内核的 BlockAssembler** 当裁判。
 *
 * ## 这两个 bug 值得单独钉死
 *
 * 它们都是「结构字段名写错」，且在插件自己的单测里**看不出来**
 * （自造断言怎么写都能通过），但真实客户端会当场报错：
 *
 * | 错误写法 | 报错 | 发生位置 |
 * |---|---|---|
 * | `block-start` 用 `kind` 而非 `blockType` | `Cannot read properties of undefined (reading 'type')` | **客户端** `emptyAssistantBlock(chunk.blockType)` |
 * | `block-end` 只带 `index`，不带 `block` | 同上 | **内核** `this.ensure(chunk.index, chunk.block.type)` |
 *
 * 而且第二个 bug 的表现极具误导性：**报错在 DSH，但 AutoClaw 那边明明回复成功了** ——
 * 因为对话早就跑完，只是在投影回 DSH 时炸了。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/** 找内核里的 assembler（多用例共享，只加载一次）。 */
function findAssembler() {
  const roots = [
    path.join('D:', 'APP', 'deep seek', 'resources', 'app.asar.unpacked', 'dsh'),
    path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles'),
  ]
  for (const root of roots) {
    const candidate = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'types', 'assembler.js')
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

const ASSEMBLER = findAssembler()

/** 把一组 chunk 灌进真实内核，返回组装结果或抛出的错误。 */
async function assemble(chunks) {
  const { BlockAssembler } = await import(pathToFileURL(ASSEMBLER).href)
  const assembler = new BlockAssembler()
  try {
    for (const chunk of chunks) assembler.push(chunk)
    return { ok: true, message: assembler.message(), finish: assembler.finish }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

test('block-start 必须用 blockType（用 kind 会让客户端读到 undefined.type）', { skip: ASSEMBLER === undefined }, async () => {
  const withKind = await assemble([
    { type: 'block-start', index: 0, kind: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  // 复现原始报错。
  // ⚠️ 内核层与客户端层报的是**同一件事**，但文案不同：
  //   内核：`cannot assemble incomplete block of type "undefined"`
  //   客户端：`Cannot read properties of undefined (reading 'type')`
  // 所以断言放宽到「提到 undefined 或读 type」，别把文案钉死。
  assert.equal(withKind.ok, false)
  assert.match(withKind.error, /undefined/u)

  const withBlockType = await assemble([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(withBlockType.ok, true)
  assert.equal(withBlockType.message.content[0].type, 'text')
  assert.equal(withBlockType.message.content[0].text, 'hi')
})

test('block-end 必须带 block（只给 index 会让内核读 undefined.type）', { skip: ASSEMBLER === undefined }, async () => {
  const missingBlock = await assemble([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0 },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(missingBlock.ok, false)
  assert.match(missingBlock.error, /undefined|Cannot read properties/u)

  const withBlock = await assemble([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(withBlock.ok, true)
})

test('Multi-block：reasoning 与 text 各自独立组装（顺序与 index 对应）', { skip: ASSEMBLER === undefined }, async () => {
  const result = await assemble([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想一下' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '答案是' },
    { type: 'text-delta', index: 1, text: '42' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '答案是42' } },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一下' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.message.content.length, 2)
  assert.equal(result.message.content[0].type, 'reasoning')
  assert.equal(result.message.content[0].text, '想一下')
  assert.equal(result.message.content[1].type, 'text')
  assert.equal(result.message.content[1].text, '答案是42')
})

test('不关闭 block 也能组装（内核允许 delta-only）', { skip: ASSEMBLER === undefined }, async () => {
  const result = await assemble([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.message.content[0].text, 'hi')
})

test('适配器源码里没有 block-start 用 kind 的残留', () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//u, ''))
  const source = fs.readFileSync(path.join(here, '..', 'src', 'autoclaw', 'adapter.js'), 'utf8')
  const blockStarts = source.match(/type: 'block-start'[^\n]*/gu) ?? []
  assert.ok(blockStarts.length >= 2, `应至少有正文/思考两个 block-start，实际 ${blockStarts.length}`)
  for (const line of blockStarts) {
    assert.match(line, /blockType:/u, `block-start 必须带 blockType：${line}`)
    assert.equal(/[{,] kind: /u.test(line), false, `block-start 不该用 kind：${line}`)
  }
})
