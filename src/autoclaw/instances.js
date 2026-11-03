/**
 * 多桌面端实例发现。
 *
 * ## 为什么「换号」只能走这条路
 *
 * 已实测确认三个硬约束：
 *
 * 1. **`ready` 帧的账号来自桌面端当前激活账号**
 *    （`accountSnapshot()` → `productAccount.account.snapshot()`），
 *    与池里有几个账号**无关**。池里多存账号并不会让对话换号。
 * 2. **本地协议没有切号操作**：`hds` 的 operation 白名单共 31 项
 *    （`bootstrap`/`chat`/`bind-model`/…），**没有任何一项能切换账号**。
 * 3. **桌面端切号必须重启进程**：失败码 `account_switch_requires_restart`
 *    （类 `ProductAccountSwitchRequiresRestartError`）就是专门为此定义的。
 *
 * ⇒ 想真正「换号」，只能在**实例层面**换：同一个账号体系下再开一个
 * AutoClaw 实例（不同 userData 目录 → 不同 `bootstrapToken`/端口 → 各自登录不同账号），
 * 我们分别配对、按额度顺序轮换。
 *
 * ## 发现策略
 *
 * 每个实例把自己写在 `3917` 或之后的端口上；不同实例的 `userData` 不同，
 * 所以 `Local State` 里的凭据也各自独立。这里扫描一段端口区间，
 * 逐个读 `GET /` 的发现文档，按 `instanceId` 去重。
 *
 * ⚠️ 单实例（最常见）时这里只返回 1 个结果，退化为「只用当前激活账号」——
 * 那时**换号不可用**，UI 必须如实说明，不能假装能换。
 *
 * @module dsh-teleagent-pool/src/autoclaw/instances
 */

import { DISCOVERY_PORT } from './bridge.js'

/** 扫描区间：主端口 + 后续若干个（实例会顺延占端口）。 */
export const SCAN_PORTS = Object.freeze(
  Array.from({ length: 8 }, (_, offset) => DISCOVERY_PORT + offset),
)

/**
 * 探测单个端口上的 office-plugin 实例。
 *
 * @param {number} port
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object | undefined>} 发现文档；不是本服务则 `undefined`
 */
export async function probeInstance(port, options = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    if (payload?.service !== 'autoclaw-office-plugin') return undefined
    return { ...payload, discoveryPort: port }
  } catch {
    return undefined
  }
}

/**
 * 扫描本机所有 AutoClaw 桌面端实例。
 *
 * @param {{ ports?: number[], timeoutMs?: number }} [options]
 * @returns {Promise<Array<object>>} 按端口升序、按 instanceId 去重
 */
export async function discoverInstances(options = {}) {
  const ports = options.ports ?? SCAN_PORTS
  const found = await Promise.all(
    ports.map((port) => probeInstance(port, { timeoutMs: options.timeoutMs })),
  )
  const seen = new Set()
  const out = []
  for (const instance of found) {
    if (instance === undefined) continue
    const id = String(instance.instanceId ?? '')
    if (id !== '' && seen.has(id)) continue
    if (id !== '') seen.add(id)
    out.push(instance)
  }
  out.sort((left, right) => left.discoveryPort - right.discoveryPort)
  return out
}
