/**
 * OpenAI 兼容层的两个纯函数：消息序列化 与 SSE → `StreamChunk` 投影。
 *
 * TeleAgent 的推理端点是**标准 OpenAI chat/completions**（SSE 响应，无加密、
 * 无 WASM 签名），所以这一层是「薄」的：不需要 provider 私有的事件词汇。
 *
 * ## StreamChunk 契约（dsh-llm）
 *
 * 扁平的带索引块协议：每个块先 `block-start`，再用 delta 喂，最后 `block-end`
 * 带组装好的块。`usage` 在终止 `finish` 之前，之后不得再有任何块。
 * ⚠️ 块的 `block-end` 允许延迟到流结束（DeepSeek 适配器就是这么做的）——
 * 用户能实时看到文字靠的是 `text-delta`，不是 `block-end`。
 *
 * ## 为什么必须抛错而不是静默返回空流
 *
 * 静默结束的流在 UI 上表现为「干净地停止、没有任何报错」，是最难排查的一类缺陷。
 * 上游错误帧、`[DONE]` 缺失、解析失败**一律抛 `LlmError`**，由 `LlmRuntime`
 * 归一成终止失败块。
 *
 * @module dsh-teleagent-pool/src/compat
 */

/** 把 DSH 的 content 块里的文字拼起来。 */
export function contentToText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** content 里是否含图片块（含 tool-result 里的嵌套图片）。 */
export function contentHasImage(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!block) continue
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && contentHasImage(block.content)) return true
  }
  return false
}

/**
 * 把 DSH 消息序列化成 OpenAI wire messages。
 *
 * - `tool-result` 块展开成独立的 `{role:'tool', tool_call_id, content}` 消息
 *   （DSH 把每个工具结果放在自己的 user 角色消息里）。
 * - assistant 的 `tool-call` 块 → `tool_calls[]`。
 * - **不回传推理内容**：标准 OpenAI 不接受 `reasoning_content`，而 TeleAgent
 *   走的就是标准形状；擅自加字段只会让上游 400。
 *
 * @param {ReadonlyArray<object>} messages - DSH 消息
 * @returns {Array<object>} wire messages
 */
export function serializeMessages(messages) {
  const wire = []
  for (const message of messages ?? []) {
    if (!message) continue
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = contentToText(message.content)
      const toolCalls = (message.content ?? [])
        .filter((block) => block && block.type === 'tool-call')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments ?? '{}' },
        }))
      const row = { role: 'assistant', content: text }
      if (toolCalls.length > 0) row.tool_calls = toolCalls
      // 完全空的 assistant 消息会被上游拒（content 与 tool_calls 都空）——
      // 跳过它是安全的：它不携带任何模型可见信息。
      if (text.length === 0 && toolCalls.length === 0) continue
      wire.push(row)
      continue
    }

    const toolResults = (message.content ?? []).filter((block) => block && block.type === 'tool-result')
    const text = contentToText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: contentToText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** wire 的 `finish_reason` → DSH 的 `FinishReason`。 */
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${String(reason)}`, code: String(reason ?? 'unknown').toUpperCase() },
      }
  }
}

/** wire usage → DSH 的 disjoint TokenUsage。 */
function mapUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const prompt = Number(usage.prompt_tokens)
  const completion = Number(usage.completion_tokens)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens)
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens)
  const cacheRead = Number.isFinite(cached) && cached >= 0 ? Math.min(cached, prompt) : undefined
  return {
    // DSH 约定：inputTokens 是**未命中缓存**的输入，缓存命中单列。
    inputTokens: Math.max(0, prompt - (cacheRead ?? 0)),
    outputTokens: completion,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(Number.isFinite(reasoning) && reasoning >= 0 ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * 找下一个事件边界（`\n\n` 或 `\r\n\r\n`）。
 *
 * ⚠️ 不能只找 `\n\n`：SSE 规范允许 CRLF，而不同的反向代理会改写换行。
 * 只认 `\n\n` 会在某些链路上把整段响应当成一个巨大的未完成事件。
 * @returns `{ index, length }`；没有边界返回 `-1`
 */
function nextBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return { index: -1, length: 0 }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/** 从一个 SSE 事件块里取出 `data:` 行拼成的载荷。 */
function dataOf(eventBlock) {
  const lines = eventBlock.split('\n')
  let out = ''
  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (!trimmed.startsWith('data:')) continue
    const value = trimmed.slice(5)
    out += value.startsWith(' ') ? value.slice(1) : value
  }
  return out
}

/**
 * 消费 OpenAI SSE 响应体，产出 `StreamChunk`。
 *
 * @param {Response} response - 已确认 `ok` 的响应
 * @param {{ signal?: AbortSignal, firstTokenTimeoutMs?: number, chunkTimeoutMs?: number }} options
 * @param {{ LlmError: Function, CallId: Function, label?: string }} deps - 由适配器注入，避免这里硬依赖包版本
 */
export async function* consumeOpenAiSse(response, options, deps) {
  const { LlmError, CallId } = deps
  const label = deps.label ?? 'teleagent'
  if (response.body === null) throw new LlmError(`${label}: 响应缺少 body`, 'EMPTY_RESPONSE')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let nextIndex = 0
  /** @type {Array<{index:number, kind:string, text:string, id?:string, name?:string}>} */
  const order = []
  let pendingUsage
  let pendingFinish
  let sawAnyBlock = false
  let sawDone = false

  const openBlock = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    sawAnyBlock = true
    return block
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 事件以空行分隔；末尾不完整的一段留在 buffer 里等下一块。
      let boundary = nextBoundary(buffer)
      while (boundary.index !== -1) {
        const eventBlock = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        boundary = nextBoundary(buffer)

        const payload = dataOf(eventBlock)
        if (payload.length === 0) continue
        if (payload === '[DONE]') {
          sawDone = true
          break
        }

        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          throw new LlmError(`${label}: SSE 载荷无法解析：${payload.slice(0, 200)}`, 'MALFORMED_RESPONSE')
        }

        // 上游在 200 的 SSE 里塞错误对象是常见形态 —— 必须抛错，不能静默。
        if (parsed && typeof parsed === 'object' && parsed.error !== undefined) {
          const message = typeof parsed.error === 'string'
            ? parsed.error
            : (parsed.error?.message ?? JSON.stringify(parsed.error))
          throw new LlmError(`${label}: 上游返回错误帧：${String(message).slice(0, 300)}`, 'SERVER', { status: 200 })
        }

        const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined
        if (choice !== undefined) {
          const delta = choice.delta ?? {}
          const reasoning = typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : (typeof delta.reasoning === 'string' ? delta.reasoning : '')
          if (reasoning.length > 0) {
            const existing = order.find((block) => block.kind === 'reasoning')
            const block = existing ?? openBlock('reasoning')
            if (existing === undefined) yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            block.text += reasoning
            yield { type: 'reasoning-delta', index: block.index, text: reasoning }
          }

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            const existing = order.find((block) => block.kind === 'text')
            const block = existing ?? openBlock('text')
            if (existing === undefined) yield { type: 'block-start', index: block.index, blockType: 'text' }
            block.text += delta.content
            yield { type: 'text-delta', index: block.index, text: delta.content }
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const key = call?.index ?? call?.id ?? 0
              let block = order.find((item) => item.kind === 'tool-call' && item.key === key)
              if (block === undefined) {
                block = openBlock('tool-call')
                block.key = key
                block.id = CallId(call?.id ?? `call_${block.index}_${Date.now().toString(36)}`)
                block.name = call?.function?.name ?? ''
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              } else {
                if (typeof call?.id === 'string' && call.id.length > 0) block.id = CallId(call.id)
                if (typeof call?.function?.name === 'string' && call.function.name.length > 0) {
                  block.name = call.function.name
                }
              }
              const argsDelta = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
              if (argsDelta.length > 0) {
                block.text += argsDelta
                yield { type: 'tool-call-delta', index: block.index, id: block.id, argumentsDelta: argsDelta }
              }
            }
          }

          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            pendingFinish = mapFinishReason(choice.finish_reason)
          }
        }

        const usage = mapUsage(parsed?.usage)
        if (usage !== undefined) pendingUsage = usage
      }
      if (sawDone) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 已结束；取消失败不影响结果
    }
  }

  // 尾块（没有以空行结尾的事件）。
  if (!sawDone) {
    const tail = dataOf(buffer)
    if (tail.length > 0) {
      if (tail === '[DONE]') sawDone = true
      else {
        try {
          const parsed = JSON.parse(tail)
          const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined
          if (choice !== undefined && choice.finish_reason !== undefined && choice.finish_reason !== null) {
            pendingFinish = mapFinishReason(choice.finish_reason)
          }
          const usage = mapUsage(parsed?.usage)
          if (usage !== undefined) pendingUsage = usage
        } catch {
          // 尾块解析失败：不因为一段残片判死整个流（正文已经拿到）
        }
      }
    }
  }

  for (const block of order) {
    if (block.kind === 'tool-call') {
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.id,
          name: block.name ?? '',
          // 参数为空时给合法 JSON：空字符串会让下游 JSON.parse 直接炸。
          arguments: block.text.length > 0 ? block.text : '{}',
        },
      }
      continue
    }
    if (block.kind === 'reasoning') {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      continue
    }
    yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
  }

  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }

  const reason = pendingFinish ?? { kind: 'stop' }
  if (reason.kind === 'stop' && !sawAnyBlock) {
    // 退化完成：什么都没产出。静默地「成功」是 UI 上最难排查的形态。
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `${label}: 上游返回了空回复（没有任何内容块）`, code: 'EMPTY_RESPONSE' },
      },
    }
    return
  }
  // ⚠️ 没等到 `[DONE]` 说明流被截断：模型调用结果不可信，必须报错。
  if (!sawDone && reason.kind === 'stop') {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `${label}: SSE 流在 [DONE] 之前结束（响应被截断）`, code: 'STREAM_CLOSED' },
      },
    }
    return
  }
  yield { type: 'finish', reason }
}
