/**
 * AutoClaw（智谱桌面端，内部代号 `zwork`）的**产品常量单一真相源**。
 *
 * 全部来自对 `D:\APP\AutoClaw2\resources\app\dist\main.cjs`（v2.3.0）的逐字取证，
 * 每一处都标注了原文出处。**不要凭空改**：这些值错了的表现是 401/406 这类
 * 看起来和身份无关的错误。
 *
 * @module dsh-teleagent-pool/src/autoclaw/product
 */

/** provider 路由名。 */
export const PROVIDER_ID = 'autoclaw'

/** 面板展示名。 */
export const PROVIDER_NAME = 'AutoClaw (智谱)'

/**
 * 服务端主域。
 *
 * 原文（`main.cjs` 的部署常量 `N`）：
 * `httpOrigin:"https://autoglm-acceleration-api.zhipuai.cn"`
 */
export const API_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'

/**
 * 客户端身份常量（原文 `LDo = { appId:"100003", appKey:"38d…", product:"autoclaw" }`）。
 *
 * ⚠️ 这不是用户凭据，而是**签报头**用的固定 appId/appKey —— 用于
 * `X-Auth-Sign = md5(appId & timestamp & appKey)`。用户身份另走 `X-Authorization`。
 */
export const APP_ID = '100003'
export const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
export const PRODUCT = 'autoclaw'

/** 渠道（原文 `x3 = "official"`）。 */
export const CHANNEL = 'official'

/** 客户端版本（进 `X-Version`）。 */
export const CLIENT_VERSION = '2.3.0'

/** 用户目录名（`%APPDATA%` 下）。 */
export const USER_DATA_DIR = 'AutoClaw-official'

/** DPAPI 包裹的 AES 主密钥所在文件。 */
export const LOCAL_STATE_FILE = 'Local State'

/** 账号凭据目录。 */
export const ACCOUNTS_DIR = 'accounts'

/** 单个账号的加密凭据文件名。 */
export const CREDENTIAL_FILE = 'account-credentials.enc'

/**
 * 账号级模型目录（**推理网关真正认的 model 名**在这里）。
 *
 * 与 `third-party-provider-config` 的区别见 `FALLBACK_MODELS` 的注释 —— 两者混用
 * 会得到 `400 非法模型`。
 */
export const MODEL_CATALOG_FILE = 'runtime/model-catalog/remote-snapshot.json'

/** 账号档案（含 phone / accountId / numericUserId）。 */
export const PROFILE_FILE = 'account-profile.json'

/** 当前激活账号指针。 */
export const ACTIVE_ACCOUNT_FILE = 'device/active-product-account.json'

/** 积分钱包（**实测 200**，`data.total_balance` 为总积分）。 */
export const WALLET_PATH = '/agent-assetmgr/api/v2/wallets'

/** 即将过期积分（**实测 200**）。 */
export const EXPIRING_PATH = '/agent-assetmgr/api/v1/points/expiring'

/** 第三方渠道 + 模型目录（**实测 200**，`data.providers[].supportedModels`）。 */
export const PROVIDER_CONFIG_PATH = '/autoclaw-proxy/proxy/third-party-provider-config'

/** 推理路径（鉴权可达，但需服务端 scope 握手，见 `docs`/README）。 */
export const INFER_PATH = '/autoclaw-proxy/proxy/autoclaw/chat/completions'

/** 刷新 access token（首选）。 */
export const REFRESH_PATH = '/userapi/v1/refresh'

/** 刷新 access token（回退，原文 `refresh()` 里 `businessCode === 400002` 时切换）。 */
export const AGENT_REFRESH_PATH = '/userapi/v1/agent-refresh'

/** 本地 token 服务端口（桌面端给子进程用的，需同族进程才放行）。 */
export const LEGACY_TOKEN_PORT = 18432

/** 请求超时。 */
export const REQUEST_TIMEOUT_MS = 30_000

/** 推理首帧/块间上限（GLM 思考可能很久）。 */
export const INFER_TIMEOUT_MS = 180_000

/**
 * 兜底模型表。
 *
 * ⚠️ 这些是**服务端目录里真实的 wire 模型名**（来自 `supportedModels[].id`，
 * 与目录 UI 上的 `zaicoding_*` 别名不同）。实测：发 `zaicoding_glm-5.3` 会 406，
 * 而发 `glm-5.3` 走到「非法模型」判定 —— 说明 wire 名不带 `zaicoding_` 前缀。
 * 兜底表只在目录拉取失败时使用。
 *
 * ## ⚠️⚠️ 这里必须是**推理网关认的 model 名**，不是「第三方渠道目录」里的 id
 *
 * 两个数据源很容易搞混，我一开始就搞混了，代价是每次对话都回 `400 非法模型`：
 *
 * | 数据源 | 内容 | 能不能喂给推理端点 |
 * |---|---|---|
 * | `GET /autoclaw-proxy/proxy/third-party-provider-config` | 5 个渠道 × 各自模型（智谱 `glm-5.3`/`glm-5.2`/…、DeepSeek `deepseek-v4-pro`、MiniMax…） | **不能** —— 那是**BYOK 第三方**清单，用户要自带 key 才能用，AutoClaw 自己的账号对它无权 |
 * | `accounts/<hash>/runtime/model-catalog/remote-snapshot.json` | **账号级**目录，5 条：`zai_auto` / `zai_auto-fast` / `zaicoding_glm-5.3` / `zai_glm-5.3-flash` / `zai_glm-5.3-flashx-legal` | **能** —— 这才是托管网关接受的 id |
 *
 * 实测（真实 token，逐个打推理端点）：
 * ```
 * zai_auto                  -> 406  可路由（scopes 未握手）
 * zai_auto-fast             -> 406
 * zaicoding_glm-5.3         -> 406
 * zai_glm-5.3-flash         -> 406
 * zai_glm-5.3-flashx-legal  -> 406
 * glm-5.3 / glm-5.2 / …     -> 400 非法模型
 * ```
 *
 * 406 是「名字对了、但 scope 握手还没做」；400 是「网关根本不认这个 model」。
 * ⇒ 兜底表按**账号级**那 5 条来。
 */
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'zai_auto', name: 'Auto（自动选模型）', contextWindow: 1_048_576, maxTokens: 393_216, supportsImage: true }),
  Object.freeze({ id: 'zai_auto-fast', name: 'Auto-Fast（速度优先）', contextWindow: 1_048_576, maxTokens: 131_072, supportsImage: true }),
  Object.freeze({ id: 'zaicoding_glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 307_200, supportsImage: false }),
  Object.freeze({ id: 'zai_glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_048_576, maxTokens: 131_072, supportsImage: true }),
  Object.freeze({ id: 'zai_glm-5.3-flashx-legal', name: 'GLM-5.3-FlashX-Legal', contextWindow: 1_048_576, maxTokens: 307_200, supportsImage: true }),
])

/** 北京时间偏移（积分/账期按 UTC+8）。 */
export const BILLING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
