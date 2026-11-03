/**
 * AutoClaw 会话客户端：配对 → bootstrap → subscribe → chat → 收流式事件。
 *
 * 把上面这一长串协议折叠成「一个会话对象」，DSH 适配器只需调
 * `client.chat({ messages, model })` 就能拿到逐块输出。
 *
 * ## 序号规则（实测踩过 `sequence_replay`）
 *
 * `sequence` 是**整条连接上的单调计数**，从 1 开始：
 * - `pair` 帧占 1（服务端 `previousSequence:null` ⇒ 期望 1）；
 * - `ready` 由服务端发出，也占 1（两端各自计数）；
 * - 之后客户端每发一帧 +1 ⇒ **第 2 帧才合法**。
 *
 * ## 事件投影（`run.events` 里的 `events[]`）
 *
 * ```js
 * { type: "run.started", runId, conversationId }
 * { type: "block.started", blockId, kind: "thinking" | "text" | ... }
 * { type: "block.delta", blockId, textDelta }
 * { type: "block.completed", blockId }
 * { type: "tool.requested" } / { type: "question.requested" }
 * { type: "run.completed" } / { type: "run.failed" }
 * ```
 *
 * ⚠️ 文本在 `block.delta.textDelta`，**不是** `evt.text`（我第一版按后者读，
 * 结果一个字都拿不到，但 `run.terminal` 却报 `completed` —— 极容易误判成空回复）。
 * 且必须按 `blockId` 区分 `thinking` 与正文，否则会把思维链当成答案。
 *
 * @module dsh-teleagent-pool/src/autoclaw/session
 */

import crypto from 'node:crypto'
import { PoolError } from '../errors.js'
import {
  CLIENT_ID,
  buildPairMessage,
  discover,
  newSecret,
  open,
  seal,
  STREAM_PATH,
  SUBPROTOCOL,
} from './bridge.js'

/** 未指定文档时用的稳定 id（满足 `^[A-Za-z0-9._-]{8,160}$/`）。 */
const DEFAULT_DOCUMENT_ID = 'dsh-autoclaw-pool-doc'

/**
 * 一个已配对的连接。
 *
 * 生命周期：`open()` → 若干次 `request()` / `chat()` → `close()`。
 * 每次 chat 复用一个连接（配对一次就够；服务端 `resumed` 允许重连复用 secret）。
 */
export class BridgeSession {
  /**
   * @param {object} options
   * @param {Buffer} options.secret - 32 字节共享密钥（持久化后复用）
   * @param {object} [options.discovery] - 若已有发现结果可传入，省一次 HTTP
   * @param {{ warn?: Function, info?: Function }} [options.logger]
   */
  constructor(options = {}) {
    this.secret = options.secret
    this.discovery = options.discovery
    this.logger = options.logger
    this.socket = undefined
    this.connectionId = null
    this.nextSequence = 1
    this.pending = new Map()
    this.subscriptions = new Map()
    this.config = undefined
    this.accountId = ''
  }

  /** 建连并完成配对，返回 `ready` 帧。 */
  async connect(options = {}) {
    if (this.discovery === undefined) this.discovery = await discover(options)
    const url = `ws://127.0.0.1:${this.discovery.port}${STREAM_PATH}`
    this.socket = new WebSocket(url, SUBPROTOCOL)

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 12_000
      const timer = setTimeout(() => reject(new PoolError(
        `autoclaw: 连接 AutoClaw office-plugin 超时（${timeoutMs}ms）`,
        'TRANSPORT',
      )), timeoutMs)

      const settle = (error, value) => {
        clearTimeout(timer)
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      this.socket.addEventListener('message', (event) => {
        let wire
        try {
          wire = JSON.parse(String(event.data))
        } catch {
          return
        }

        // ① 传输层：hello → 发 pair
        if (wire.kind === 'server.hello') {
          if (this.secret === undefined) this.secret = newSecret()
          this.nextSequence = 1
          try {
            this.socket.send(JSON.stringify(buildPairMessage(wire, this.discovery, this.secret)))
          } catch (error) {
            settle(new PoolError(`autoclaw: 配对报文构造失败 —— ${error?.message}`, 'AUTH'))
          }
          return
        }

        // ② 之后一切都是加密信封
        if (wire.envelope === undefined) return
        let frame
        try {
          frame = open(this.secret, wire.envelope)
        } catch (error) {
          this.logger?.warn?.(`[autoclaw] 解信封失败：${error.message}`)
          return
        }

        if (frame.type === 'ready') {
          this.connectionId = frame.connectionId
          this.config = frame.config ?? {}
          this.accountId = frame.accountId ?? ''
          settle(undefined, frame)
          return
        }

        this.dispatch(frame)
      })

      this.socket.addEventListener('error', () => {
        settle(new PoolError('autoclaw: WebSocket 连接失败（AutoClaw 桌面端是否在运行？）', 'TRANSPORT'))
      })
      this.socket.addEventListener('close', (event) => {
        if (event.code === 1000 || event.code === 1005) return
        const hint = event.code === 4001
          ? '（协议不符：检查 AutoClaw 版本）'
          : event.code === 4009
            ? '（配对被拒：bootstrapToken 已过期，重新发现后再试）'
            : `（code=${event.code} reason=${event.reason}）`
        settle(new PoolError(`autoclaw: 连接被关闭${hint}`, 'TRANSPORT'))
      })
    })
  }

  /** 把服务端推来的帧分发给等待者。 */
  dispatch(frame) {
    if (frame.type === 'response') {
      const waiter = this.pending.get(frame.requestId)
      if (waiter !== undefined) {
        this.pending.delete(frame.requestId)
        waiter(frame)
      }
      return
    }
    if (frame.type === 'run.events' || frame.type === 'run.terminal') {
      const key = frame.subscriptionId ?? ''
      const waiter = this.subscriptions.get(key)
      if (waiter !== undefined) waiter(frame)
      return
    }
    if (frame.type === 'config') {
      this.config = { ...this.config, ...(frame.config ?? {}) }
      return
    }
    if (frame.type === 'goaway') {
      this.logger?.warn?.(`[autoclaw] 服务端 goaway：${frame.reason ?? ''}`)
    }
    // pong / tool.request / 其它：由 chat() 内部按需处理
    if (frame.type === 'tool.request' || frame.type === 'tool.cancel') {
      const waiter = this.subscriptions.get('__interaction')
      if (waiter !== undefined) waiter(frame)
    }
  }

  /** 发一个逻辑帧，`sequence` 自增。 */
  send(type, extra = {}) {
    if (this.socket === undefined || this.connectionId === null) {
      throw new PoolError('autoclaw: 连接尚未就绪（未收到 ready）', 'TRANSPORT')
    }
    this.nextSequence += 1
    const frame = {
      protocol: 1,
      dir: 'c2s',
      connectionId: this.connectionId,
      sequence: this.nextSequence,
      type,
      ...extra,
    }
    this.socket.send(JSON.stringify({ kind: 'frame', envelope: seal(this.secret, frame) }))
    return this.nextSequence
  }

  /**
   * 发一个 `request` 并等 `response`。
   *
   * @param {string} operation
   * @param {object} payload
   * @param {{ timeoutMs?: number }} [options]
   */
  async request(operation, payload = {}, options = {}) {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new PoolError(`autoclaw: ${operation} 超时`, 'TIMEOUT'))
      }, options.timeoutMs ?? 30_000)

      this.pending.set(requestId, (frame) => {
        clearTimeout(timer)
        if (frame.ok !== true) {
          reject(new PoolError(
            `autoclaw: ${operation} 被拒 —— ${frame.error?.message ?? frame.error?.code ?? '未知'}`,
            'SERVER',
            { operation, upstream: frame.error },
          ))
          return
        }
        resolve(frame.payload)
      })

      try {
        this.send('request', { requestId, operation, payload })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  /**
   * 跑一轮对话，边收边吐。
   *
   * @param {object} options
   * @param {string} options.message - 用户消息（已拼好的纯文本）
   * @param {string} [options.model] - bootstrap 里那个 **model connection id**
   * @param {string} [options.documentId]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @returns {AsyncGenerator<{ kind: 'text'|'reasoning'|'error'|'status', text?: string, detail?: string }>}
   */
  async *chat(options) {
    const documentId = options.documentId ?? DEFAULT_DOCUMENT_ID
    const subscriptionId = crypto.randomUUID()

    // 事件队列：服务端推来的帧先入队，生成器按序消费
    const queue = []
    let notify = null
    let failure = null

    const push = (item) => {
      queue.push(item)
      if (notify !== null) {
        const resume = notify
        notify = null
        resume()
      }
    }

    this.subscriptions.set(subscriptionId, (frame) => {
      if (frame.type === 'run.terminal') {
        const status = frame.snapshot?.status ?? 'unknown'
        if (status !== 'completed') {
          failure = frame.snapshot?.failureCode ?? frame.errorCode ?? status
        }
        push({ kind: 'terminal', detail: status })
        return
      }
      const events = Array.isArray(frame.events) ? frame.events : []
      for (const event of events) {
        const type = event?.type
        if (type === 'block.started') {
          push({ kind: 'block-start', blockId: event.blockId, blockKind: event.kind })
          continue
        }
        if (type === 'block.delta') {
          // ⚠️ 文本在 textDelta；按 block 的 kind 区分思考与正文
          const text = typeof event.textDelta === 'string' ? event.textDelta : ''
          if (text.length === 0) continue
          push({ kind: 'delta', blockId: event.blockId, text })
          continue
        }
        if (type === 'block.completed') {
          push({ kind: 'block-end', blockId: event.blockId })
          continue
        }
        if (type === 'run.started') {
          push({ kind: 'status', detail: `run 已启动（${String(event.runId ?? '').slice(0, 8)}）` })
          continue
        }
        if (type === 'run.failed') {
          failure = event.errorCode ?? event.failureCode ?? 'run_failed'
          push({ kind: 'error', detail: String(event.message ?? failure) })
          continue
        }
        if (type === 'question.requested' || type === 'tool.requested') {
          push({ kind: 'notice', detail: `${type}（本插件不执行工具）` })
          continue
        }
      }
    })

    try {
      // ① 订阅（帧类型，不是 operation）
      this.send('subscribe', { requestId: crypto.randomUUID(), subscriptionId, documentId })

      // ② 发 chat
      // ⚠️ payload 必须有 document 对象；缺了会 office_document_invalid
      await this.request('chat', {
        document: { documentId, title: 'DSH', context: '' },
        message: options.message,
        messageId: crypto.randomUUID(),
        ...(options.model !== undefined && options.model !== '' ? { modelId: options.model } : {}),
      }, { timeoutMs: options.timeoutMs ?? 30_000 })

      // ③ 消费事件流
      const deadline = Date.now() + (options.timeoutMs ?? 180_000)
      /** blockId → kind（thinking/text/…） */
      const blockKinds = new Map()
      /**
       * 是否已看到 `run.terminal`。
       *
       * ⚠️ terminal 与 events 是**两条独立的推送**，顺序不保证：
       * 它可能在最后一批 `run.events`（含正文 delta）之后到，也可能**先到**。
       * 我第一版一收到 terminal 就 `return`，结果正文 delta 还没消费就结束了
       * —— 表现是「块刚开到 text 就停，一个字都没有」，adapter 于是误报空回复。
       *
       * ⇒ terminal 只标记 `ended`，之后**必须把队列排空**再退出。
       */
      let ended = false

      while (true) {
        if (options.signal?.aborted === true) {
          this.send('request', {
            requestId: crypto.randomUUID(),
            operation: 'cancel-active-run',
            payload: { documentId },
          })
          return
        }
        if (queue.length === 0) {
          // ⚠️ 只有「已收到 terminal」**且**队列真的空了才退出。
          // 再加一个短暂的排空缓冲：terminal 先到、delta 后到的情况实测存在。
          if (ended) {
            const quietMs = options.drainMs ?? 250
            const drained = await new Promise((resolve) => {
              notify = () => resolve(true)
              const guard = setTimeout(() => {
                if (notify !== null) {
                  notify = null
                  resolve(false)
                }
              }, quietMs)
              guard.unref?.()
            })
            if (drained || queue.length > 0) continue
            break
          }
          if (Date.now() > deadline) {
            throw new PoolError('autoclaw: 等待流式输出超时', 'TIMEOUT')
          }
          await new Promise((resolve) => {
            notify = resolve
            const guard = setTimeout(() => {
              if (notify === resolve) {
                notify = null
                resolve()
              }
            }, 5_000)
            guard.unref?.()
          })
          continue
        }

        const item = queue.shift()
        if (item.kind === 'block-start') {
          blockKinds.set(item.blockId, item.blockKind)
          continue
        }
        if (item.kind === 'delta') {
          const isThinking = blockKinds.get(item.blockId) === 'thinking'
          yield { kind: isThinking ? 'reasoning' : 'text', text: item.text }
          continue
        }
        if (item.kind === 'status' || item.kind === 'notice') {
          yield { kind: 'status', detail: item.detail }
          continue
        }
        if (item.kind === 'error') {
          yield { kind: 'error', detail: item.detail }
          continue
        }
        if (item.kind === 'terminal') {
          if (item.detail !== 'completed') {
            // ⚠️ 非 completed 必须抛错 —— 静默结束会让 UI 显示「干净地停止」
            throw new PoolError(`autoclaw: run ${item.detail}（${failure ?? '无详情'}）`, 'SERVER')
          }
          // ⚠️ 收到 terminal **不立刻 return**：`run.terminal` 是独立帧，它可能在
          // 最后几批 `run.events`（含正文 delta）之后才送达，也可能先到。
          // 立刻 return 会把还没消费的 delta 丢掉 —— 我踩过：块刚开到 text 就结束，
          // 正文一个字都没吐出来，adapter 于是误报 EMPTY_RESPONSE。
          // 正确做法是标记 ended，继续把队列排空。
          ended = true
          continue
        }
      }

      // 队列排空后：若 terminated 但还没排空，继续等；直到 finished && queue 空
      if (failure !== null && failure !== undefined) {
        throw new PoolError(`autoclaw: run 失败（${failure}）`, 'SERVER')
      }
      if (!ended) {
        throw new PoolError('autoclaw: 事件流结束但没收到 run.terminal（上游异常中断）', 'SERVER')
      }
    } finally {
      this.subscriptions.delete(subscriptionId)
    }
  }

  /** 关连接。 */
  close() {
    try {
      this.socket?.close()
    } catch {
      // 关不掉也不该抛
    }
    this.socket = undefined
    this.connectionId = null
    this.pending.clear()
    this.subscriptions.clear()
  }
}

export { CLIENT_ID }
