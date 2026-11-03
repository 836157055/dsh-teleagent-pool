# dsh-teleagent-pool

把**两个** AI 号池接进 DeepSeek Harness，并在设置页里用 **Tab 切换**各自管理：

| Tab | 产品 | 登录方式 | 积分 | 每日签到 | 推理 |
|---|---|---|---|---|---|
| **TeleAgent (电信)** | 星辰超级智能体 | 手工取一次 token | ✅ | ✅ **每天 09:00（UTC+8）自动全量** | ⚠ **3.0.0 起被签名校验挡住**（§1.3） |
| **AutoClaw (智谱)** | Zhipu AI 桌面端（内部代号 `zwork`） | **零手工**（读本机登录态） | ✅ | ✗ **服务端没有此功能** | ⚠ 目录可用、推流被 scope 握手挡住（§2.3） |

> AutoClaw 的**对话已实测跑通**（经桌面端本地配对协议转发，不是直连上游）。
> TeleAgent 的对话仍受阻于客户端内存里的签名密钥。

---

## 一、TeleAgent

### 加账号

TeleAgent 的 token 拿不到自动化（回调地址是服务端常量，`code` 一次性，自定义协议注册不了）。**这是协议限制，不是懒**：

1. 设置页 →「AI 号池」→ TeleAgent Tab →「打开登录页」；
2. 天翼账号登录；
3. **F12 → Network → 勾选「保留日志」→ 重新完成一次授权**；
4. 点开那条 `cowork/auth?code=…`，在 **`Location` 响应头**或**响应体**里找 `token=`；
5. 粘贴 →「完成登录」。

⚠️ 地址栏和 Console 里都**没有** token（两条路都被实测证伪），只有 Network 面板能看到。

### ⚠️ 1.3 推理（推流）在 3.0.0 客户端下不可用

本机现在装的是 **TeleAgent 3.0.0-rc.1**（不是取证时的 2.5.3）。两者在签名上**行为不同**：

| 项 | 2.5.3（取证版） | 3.0.0-rc.1（本机实测） |
|---|---|---|
| `X-SA-*` 签名 | 发，sessionKey 由客户端 `randomBytes(32)` 自造 | **仍发**，但 sessionKey 只活在**主进程内存** |
| `X-SuperAgent-Signature` | 发 | **不发**（全 asar 0 命中该头名） |
| `X-SuperAgent-*` | 时间戳+nonce+device+install，全部 | 只留 Timestamp/Nonce/Device-Id/Install-Id |
| `Authorization` | `Bearer <内置 apiKey>` | `Basic base64("super-agent:<进程内随机串>")`（本地 IPC 用，不是上游凭据） |

用真实 token + 真实 `deviceId`/`installId` 实测三种组合：

| 发什么 | 上游返回 |
|---|---|
| 两组签名齐全 + `Bearer <2.5.3 apiKey>` | `40104 unsupported sign version` |
| 只发 `X-SA-*`（缺 `X-SuperAgent-*`） | `40101 missing super agent security headers` |
| 完全不发 `X-SA-*` | `40105 您的请求疑似攻击请求` |

⇒ **服务端确实校验了 `X-SA-Signature` 的真实性**。2.5.3 时代「自造 key 也能过」的结论
在 3.0.0 上已经不成立，而真正的 sessionKey 只经 `SUPER_AGENT_LOCAL_SESSION_KEY`
环境变量交给客户端自己的 Go 子进程 —— 落盘没有、进程外读不到。

所以插件**不再伪造签名**：没拿到真实 key 时，在发请求**之前**就抛出说明清楚的 AUTH，
而不是发一组必然被拒的头去换来一个看起来像配置错误的 401。

**积分与签到仍完全可用**（那是业务端点，只认 `X-Token`，不需要签名）。
一旦能拿到真实 sessionKey，把它放进账号的 `sign_key` 并把 `trustedSignKey` 置 `true`
即可恢复推流 —— 算法已经在 `src/protocol.js` 里，不用改别处。

### 每日 09:00 自动签到

| 时机 | 作用 |
|---|---|
| **每天 09:00（UTC+8）** 一次性定时器 | 到点全量签，签完自续到明天 |
| **每 10 分钟巡检**（仅 09:00 后） | 覆盖「09:00 没开机」—— 一过点就签 |
| **启动后 20 秒补签** | 昨天没开、今天早开时立刻补 |

池内闸门保证**既不漏签也不重复签**：


- 当天**成功**一次即停（含「今日无活动项」—— 活动 10:00 才刷新，把 09:30 的「暂无活动」算失败会让你当天再也签不到）；
- 失败最多 3 次；UTC+8 跨天归零。

---

## 二、AutoClaw（智谱）

### 加账号：不用粘任何东西

AutoClaw 的 token 就在本机加密文件里，插件直接解出来：

```
Local State 的 os_crypt.encrypted_key   → DPAPI（Windows，同用户）→ 32 字节 AES 主密钥
accounts/<hash>/account-credentials.enc → v10 + AES-256-GCM     → { accessToken, refreshToken }
```

- 在 AutoClaw 桌面端登录一次 → 设置页点「**扫描本机账号**」即可（启动时也会自动扫一次）。
- 同一个服务端账号重复扫描会**复用**原条目，不会分裂成两行。
- ⚠️ 换 Windows 用户 / 换机器解不开 —— 这是 safeStorage 的设计，不是缺陷：能解才说明是本人在用本机登录态。

### ⚠️ 「积分不显示」的两种成因（别都当成 bug）

面板上积分显示为 **不可读**（而不是 `0`）时，只有两种可能：

| 现象 | 成因 | 处置 |
|---|---|---|
| `积分 不可读` + 「没有凭据文件」 | 该账号在 AutoClaw 里**从未真正登录过**（只剩一个账号目录，没有 `account-credentials.enc`） | 在 AutoClaw 里登录该账号一次 → 重新扫描 |
| `积分 不可读` + 「token 可能失效」 | token 过期 | 重开 AutoClaw（凭据会被重写）→ 重新扫描 |

本机真实遇到过第一种：`190****7948` 有账号目录但无凭据文件，而 AutoClaw 当前激活的是
`182****3513`（15000 分，能读）。**这不是插件读不到，是本机没有那份凭据可读**。

### 实测可用


| 能力 | 端点 | 实测结果 |
|---|---|---|
| 积分余额 | `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` | ✅ **15000 分**，含奖励/每日/订阅/加油包分项 |
| 积分过期 | `GET /agent-assetmgr/api/v1/points/expiring` | ✅ 3 天窗口 |
| 模型目录（推理用） | `accounts/<hash>/runtime/model-catalog/remote-snapshot.json` | ✅ **5 条** `zai_*` / `zaicoding_*` |
| 第三方渠道（仅展示） | `GET /autoclaw-proxy/proxy/third-party-provider-config` | ✅ 5 渠道 17 模型（**BYOK，不能推理**） |
| token 刷新 | `POST /userapi/v1/refresh` → 回退 `/api/v1/agent-refresh` | ✅ 有 refresh_token |

### ⚠️⚠️ 模型名有两个数据源，混用就会「非法模型」

这是最容易踩、且代价最高（每次对话都失败）的一处：

| 数据源 | 内容 | 能否喂推理 |
|---|---|---|
| 账号级 `remote-snapshot.json` | `zai_auto` / `zai_auto-fast` / `zaicoding_glm-5.3` / `zai_glm-5.3-flash` / `zai_glm-5.3-flashx-legal` | ✅ **网关认这套** |
| `third-party-provider-config` | `glm-5.3` / `glm-5.2` / `deepseek-v4-pro` / `minimax-…` | ❌ `400 非法模型`（**BYOK 清单**，自己的账号无权） |

实测分辨标记：
```
zai_auto / zaicoding_glm-5.3 / zai_glm-5.3-flash  -> 406  ← 名字对，只差 scope 握手
glm-5.3 / glm-5.2 / deepseek-v4-pro               -> 400 {"message":"非法模型"}
```

⇒ 插件现在从**账号级目录**取模型，`third-party-provider-config` 只用于展示渠道信息。

### ⚠️ 两个必须知道的实测事实

**1. 两类端点把 token 放在不同的头里（正反相反）**

| 端点族 | token 头 | 放错的表现 |
|---|---|---|
| 业务（`/agent-assetmgr/*`、`third-party-provider-config`） | `Authorization` | 放进 `X-Authorization` → `410000 用户未登录` |
| 推理（`/autoclaw-proxy/proxy/autoclaw/chat/completions`） | `X-Authorization` | 放进 `Authorization` → `401001 Invalid token` |

**2. 直连上游推理端点必然 406 —— 但对话本身已经跑通了**

我先试了 20+ 组合直连 `/autoclaw-proxy/proxy/autoclaw/chat/completions`：
`X-Protocol` / `Accept` / `Content-Type` / WAF cookie(`acw_tc`) / `User-Agent` /
`X-Request-Id` / `X-Query-Id` / `x_trace_id` / Anthropic body / 4 条不同 path —— **全部 406**。

根因是上游要求客户端的 `client_sign` 握手：签名密钥在握手期建立，**只在客户端进程内存里**，
纯 HTTP 侧拿不到。所以直连这条路没有出路。

⇒ **真正的解法：不直连，改走桌面端自己的本地配对协议。**
AutoClaw 在 `127.0.0.1:3917` 暴露了 `autoclaw-office-plugin`（protocol v2），
它是**为外部客户端（Word 插件）设计的正式 API**，桌面端自己完成上游握手，我们只消费结果。

```
GET  127.0.0.1:3917/                      发现：port / publicKeyPem / bootstrapToken
WS   ws://127.0.0.1:<port>/v1/stream      子协议 autoclaw-office-stream.v1
  ← server.hello{challenge}
  → client.pair{challenge, encryptedSecret, envelope}   RSA-OAEP(SHA256) + AES-256-CBC
  ← ready{connectionId, accountId, config}              配对完成
  → request{operation:"bootstrap"}                      拿 models / projects
  → subscribe{documentId}                               ← 帧类型，不是 operation
  → request{operation:"chat", payload:{document:{…}, message, modelId}}
  ← run.events{events:[…]}       block.started / block.delta / block.completed
  ← run.terminal{snapshot:{status:"completed"}}
```

**实测结果**（GLM-5.3）：`1+1 等于 2。`、`8+9 等于 17。`、`2+3 等于 5。` —— 正文与思考链正确分离。

### 实现这一层踩过的六个坑（每个都实测过）

| # | 症状 | 真因 |
|---|---|---|
| 1 | `4001 unsupported_protocol_version` | 把**传输层**帧（`{kind:"client.pair"}`）当成逻辑帧发 |
| 2 | `4001 unknown_frame_type` | 反过来把逻辑帧当成传输层帧发（两个方向都错过） |
| 3 | `4001 wrong_connection` | 信封里的 `connectionId` 必须是 **`null`**（认证前不许带） |
| 4 | `4002 sequence_replay` | `sequence` 是**整条连接**的单调计数，`ready` 已用掉 1 ⇒ 下一帧必须是 2 |
| 5 | `unknown_operation: subscribe` | `subscribe` 是**帧类型**，不是 `request` 的 `operation` |
| 6 | `office_document_invalid` | `chat.payload` 必须有 **`document` 对象**（`documentId` 匹配 `^[A-Za-z0-9._-]{8,160}$`） |

另外两个只有实跑才会暴露的坑：

- **`run.terminal` 会早于最后一批 `run.events` 到达**。一收到就 `return` 会把正文 delta 丢掉
  ——表现是「块刚开到 text 就结束，一个字都没有」。必须把 terminal 只当作标记，**把队列排空再退出**。
- **`documentId` 必须每轮唯一**。复用同一个 id 会让后续轮次进入「该文档已有任务」状态，
  产出 **0 个 chunk**（直调能出 48 块、走 adapter 却是 0 的诡异现象就来自这里）。

### ⚠️ 模型名有两套标识，不能混

| 标识 | 来源 | 给谁用 |
|---|---|---|
| `zai_auto` / `zaicoding_glm-5.3` | 账号级 `remote-snapshot.json` | **DSH 模型选择器**（可读名） |
| UUID（`76348186-…`） | `bootstrap` 返回的 model connection | **本地协议 `chat.modelId`** |

适配器用 `mapModelNameToConnectionId()` 在两者之间映射（剥 `zaicoding_`/`zai_` 前缀后按可读名匹配）。

---

## 三、安装

```sh
dsh plugin --profile desktop add link:C:/Users/Administrator/.dsh/plugins/dsh-teleagent-pool
```

`cordis.patch.yml` 会自动并入 profile 的 bundle 层。**重启 DSH** 生效。

卸载：`dsh plugin --profile desktop remove dsh-teleagent-pool`

---

## 四、数据与安全

| 内容 | 位置 |
|---|---|
| TeleAgent token | `ctx.credentials`（`TELEAGENT_TOKEN_<ACCID>`） |
| AutoClaw token | `ctx.credentials`（`AUTOCLAW_TOKEN_<ACCID>`） |
| TeleAgent 元数据 | `$DSH_HOME/teleagent-pool/pool.json`（0600） |
| AutoClaw 元数据 | `$DSH_HOME/teleagent-pool/autoclaw.json`（0600） |
| 设备标识 / 签名密钥 | 各自池文件（**设备级**、全账号共用一份） |

- 两个池**分文件**存：账号形状不同（AutoClaw 有 `accountKey`/`refresh_token`、无签到记录）。
- 没有 `credentials` 服务的组合会降级为内联存储，`/state` 返回 `tokenStorage: "inline"`，设置页明确警告 —— 不假装安全。
- 脱敏：`/state` 永不含 `signKey` / `deviceId` / `installId` / `accessToken` / `refresh_token`（有测试钉死）。

---

## 五、排错

| 现象 | 原因与处置 |
|---|---|
| 模型选择器没有「TeleAgent (电信)」 | 该池为空（无账号时分组隐藏）→ 先加账号 |
| 模型选择器没有「AutoClaw (智谱)」 | 该池为空 → 在 AutoClaw 登录后点「扫描本机账号」 |
| TeleAgent 403 +「客户端版本过低」/ `40104` | **签名头**问题，与版本号无关。别改 `X-App-Version` |
| TeleAgent `AUTH` + token 过期 | 无续期端点，重新登录 |
| AutoClaw 余额「用户未登录」 | token 过期 → 重开 AutoClaw（凭据文件会被重写）→ 重新扫描 |
| AutoClaw 点模型发消息报 406 | scope 握手（见上），非配置问题 |
| AutoClaw 扫描到 0 个 | 没装/没登录 AutoClaw，或 dataDir 不对（设置页会显示路径） |
| 设置页看不到「AI 号池」 | 该 profile 没有 `slots` 服务 → 用 `/teleagent` 命令 |

---

## 六、开发

```sh
node --test tests/*.test.mjs
```

| 文件 | 覆盖 |
|---|---|
| `tests/prepare-call.test.mjs` | **`prepareCall` 契约**（含从 `app.asar` 静态验证运行内核确实调它） |
| `tests/unit.test.mjs` | 协议纯函数、选号、签到闸门、SSE 投影、失败转移 |
| `tests/autoclaw.test.mjs` | AES-GCM 解密、签报头、目录归一、406 翻译、扫描 |
| `tests/schedule.test.mjs` | 09:00 UTC+8 窗口、跨天、时区无关性 |
| `tests/dual-pool.test.mjs` | 双 provider 注册、`?pool=` 路由、设置互不串 |
| `tests/integration.test.mjs` | `apply()` 接线、API 端点、脱敏 |
| `tests/client.test.mjs` | 浏览器半身加载契约（顶层无 React/DOM、只声明 `slots`） |
| `tests/kernel.test.mjs` | 真实 `@deepseek-ai/dsh-llm` + `cordis` 契约与失败码穿透 |

### 接线红线

1. **`inject` 只放硬依赖**：host 只写 `llm`，client 只写 `slots` —— Cordis 会让 fiber 在缺席服务上**永久 pending**。
2. **适配器必须实现 `prepareCall(provider, model, signal)`**：新版 `LlmRuntime` 会调
   `registration.adapter.prepareCall(...)`，而 `LlmAdapter` 基类**没有**它。只实现
   `stream()` 的表现是「选了模型、发一句话就报
   `registration.adapter.prepareCall is not a function`」——而 `listModels` 一切正常，
   极易误判成模型目录问题。返回值必须是 `{ model, stream }`，且 `model` 要通过内核的
   `normalizeModelInfo` 校验（`provider`/`id`/`name` 三件套一致、`contextWindow` 是正整数、
   `defaultMaxTokens` 是正安全整数）。注意它是 `(provider, model, signal)`，
   **不是**内核同名方法 `llm.prepareCall(config, signal)`。
3. **前缀判断必须写在解码之后**：`os_crypt.encrypted_key` 是 base64，`DPAPI` 前缀在解码后的字节里。在 base64 串上判前缀会**静默**拿不到主密钥（这个 bug 真发生过）。
4. **空回复 / 截断 / 上游错误帧必须抛错**：静默结束在 UI 上是「干净地停止、没有任何报错」，最难排查。
5. **能力不支持的，如实说不支持**：AutoClaw 没有每日签到 —— 给按钮就是骗人。

### ⚠️⚠️ 绝对不要用 `AUTH` 作为失败码（除非真的是密钥错）

`dsh-client-runtime` 的 `displayFailureMessage` 有一行：

```js
if (record.code === "AUTH") return "API key is invalid";
```

它把 `AUTH` **无条件**替换成这句固定文案，你精心写的 `message` **一个字都到不了界面**。
「选了电信模型 → 回复：API 密钥无效」就是这么来的 —— 真正的原因是缺客户端 sessionKey，
跟密钥毫无关系，但用户看到的是密钥错误，于是去反复检查密钥（永远查不出结果）。

⇒ 凡不是密钥问题的失败，用 **`UNSUPPORTED_CONTENT`**（能力不可用）或 **`SERVER`**（上游拒绝）。
这两者都不在特判名单里，原文会如实透出。只有「token 真的过期/真的错了」才用 `AUTH`。
