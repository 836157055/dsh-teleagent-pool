/**
 * TeleAgent（星辰超级智能体 / 中国电信天翼 AI）的**产品常量单一真相源**。
 *
 * 所有常量都来自对官方桌面端安装包的取证，出处见
 * `docs/teleagent-protocol-notes.md`（dsh-codearts-auth 仓库）。**不要凭空改这里的值**：
 * 每一个都对应一条实测事实，改错的表现是 401/40301 这类看起来完全不相干的错误。
 *
 * @module dsh-teleagent-pool/src/product
 */

/** provider 路由名（注册到 ctx.llm 的 id，也是面板分组名）。 */
export const PROVIDER_ID = 'teleagent'

/** 面板/模型选择器里的展示名。 */
export const PROVIDER_NAME = 'TeleAgent (电信)'

/** API base（推理 + 业务端点共用）。asar 原文 `const go = "https://agent.teleai.com.cn/superCowork/sapi"`。 */
export const API_BASE = 'https://agent.teleai.com.cn/superCowork/sapi'

/** 推理路径（OpenAI 兼容，POST，SSE 响应）。 */
export const INFER_PATH = '/api/v1/chat/completions'

/** 用户信息（GET，取 accountId / accountName / phone / avatar）。 */
export const USER_INFO_PATH = '/cowork/user_info'

/** 积分余额（GET，取 `current_points_balance`）。 */
export const USER_CENTER_PATH = '/user/portal/companyStore/userCenter'

/** 签到面板（GET，取 `daily_task.*`）。 */
export const DAY_TASK_PATH = '/user/portal/companyStore/v2/checkDayTask'

/** 领取每日签到（**GET**，不是 POST；响应形状不解析，领取后重查面板）。 */
export const CHECK_TASK_PATH = '/user/portal/companyStore/checkTask'

/** 签到类型参数（asar 原文 `.../checkTask?type=daily_login`）。 */
export const CHECK_TASK_TYPE = 'daily_login'

/**
 * 推理请求 `Authorization: Bearer` 用的**内置渠道 apiKey**（asar 硬编码）。
 *
 * ⚠️ 这不是用户凭据。用户身份走 `X-Token` 头 —— 两个凭据在**两个不同的头**上，
 * 把用户 token 塞进 Bearer 会 401（网关按 Bearer 分支校验渠道 key 形状）。
 */
export const INFER_API_KEY = 'sk-qvp4m6h9g20uM6PgYP7E'

/** 固定路由头（asar `TBe = { "X-Route-Target": "ops-gateway" }`）。 */
export const ROUTE_TARGET = 'ops-gateway'

/** 客户端版本（进 `X-App-Version`，服务端不强校验）。 */
export const APP_VERSION = '2.5.3'

/** 签名版本常量（asar `const hZ = "local-v1"`）。 */
export const SIGN_VERSION = 'local-v1'

/** `X-SA-*` 头名（renderer 侧 `LocalAuthService.signRequest`，时间戳**毫秒**）。 */
export const SIGN_HEADERS = Object.freeze({
  version: 'X-SA-Sign-Version',
  timestamp: 'X-SA-Timestamp',
  nonce: 'X-SA-Nonce',
  signature: 'X-SA-Signature',
})

/** `X-SuperAgent-*` 头名（Go 引擎侧，时间戳**秒**）。 */
export const SIGN_HEADERS_SUPER = Object.freeze({
  version: 'X-SuperAgent-Sign-Version',
  timestamp: 'X-SuperAgent-Timestamp',
  nonce: 'X-SuperAgent-Nonce',
  signature: 'X-SuperAgent-Signature',
  deviceId: 'X-SuperAgent-Device-Id',
  installId: 'X-SuperAgent-Install-Id',
})

/** 请求超时（业务端点）。 */
export const REQUEST_TIMEOUT_MS = 30_000

/** 推理首帧等待上限（任务型对话的思考可能很久）。 */
export const INFER_FIRST_TOKEN_TIMEOUT_MS = 180_000

/** 推理块间静默上限。 */
export const INFER_CHUNK_TIMEOUT_MS = 180_000

/**
 * 兜底模型目录。
 *
 * `chat-nano` / `chat-lite` 取自 asar 种子表 `KG`；`chat-pro` 取自 Go 引擎示例会话里
 * 真实出现过的 `modelID`（`providerID:"NewApi"`）。三档窗口统一 100K / 输出 16384
 * —— asar 注释写明「预置模型上下文长度（预置档位共享一份配置）」。
 *
 * ⚠️ `supportsImage` 恒 `false` 是**未实测的保守取值**（引擎日志只证明了
 * `chat-lite` 的 `Image:false`）⇒ 有图时**报错而不是静默丢图**。
 * ⚠️ **不声明思考档位**：种子表里没有 `thinking_config` / `effort_options`，
 * 服务端目录缓存的下发端点至今未定位，编档位就是造假。
 */
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'chat-nano', name: '轻速', contextWindow: 100_000, maxTokens: 16_384, supportsImage: false }),
  Object.freeze({ id: 'chat-lite', name: '轻量', contextWindow: 100_000, maxTokens: 16_384, supportsImage: false }),
  Object.freeze({ id: 'chat-pro', name: '专业', contextWindow: 100_000, maxTokens: 16_384, supportsImage: false }),
])

/** 登录页（UPMS 统一认证；⚠️ 不是 `meter/teleagent-login/login` 那个白屏空壳页）。 */
export const LOGIN_PAGE = 'https://www.teleai.com.cn/teleai-api/upms/public/auth/authorize'
  + '?client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi'
  + '&redirect_uri=https%3A%2F%2Fagent.teleai.com.cn%2FsuperCowork%2Fsapi%2Fcowork%2Fauth'

/** 服务端账期时区偏移（每日签到按 UTC+8 自然日刷新，写死不取本机时区）。 */
export const BILLING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/** 同一自然日内最多自动尝试次数（永久性失败的兜底，避免每次启动都发一轮无效请求）。 */
export const AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY = 3

/** 自动签到巡检间隔。 */
export const AUTO_CHECKIN_TICK_MS = 10 * 60_000

/** 插件数据目录名（放在 `$DSH_HOME` 下）。 */
export const DATA_DIR_NAME = 'teleagent-pool'
