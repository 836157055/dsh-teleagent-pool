/**
 * 凭据 ref 的局部实现。
 *
 * `@deepseek-ai/dsh-credentials` 的 `credentialRef()` 只做一件事：**校验形态并原样
 * 返回**（品牌是纯类型层的零成本包装）。把它抄成三行常量校验，插件就不必在
 * 运行时依赖那个包 —— 而依赖它会在「插件目录不在 profile 的 node_modules 里」
 * 的安装方式下直接 module-not-found。
 *
 * ⚠️ 校验规则必须与内核**逐字一致**（`/^[A-Za-z_][A-Za-z0-9_]*$/`）：
 * 不一致会让一个内核拒收的 ref 在这里通过，然后在 `credentials.set` 处才炸。
 *
 * @module dsh-teleagent-pool/src/refs
 */

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 校验并返回凭据 ref。
 * @param {string} value
 * @returns {string}
 */
export function credentialRef(value) {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref ${JSON.stringify(value)} must match ${String(REF_PATTERN)}`)
  }
  return value
}
