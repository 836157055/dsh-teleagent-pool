/**
 * dsh-teleagent-pool — 浏览器半身（设置页「AI 号池」，双 Tab）。
 *
 * ## 形态
 *
 * 手写 CJS bundle，与外挂客户端的 `__ModuleLoader__.load({id, factory})` 约定
 * 逐字一致：执行 bundle 只是**注册** factory；模块体在首次 materialize 时才跑。
 *
 * ## 两个 Tab 是**同一份前端代码**跑两份数据
 *
 * TeleAgent 与 AutoClaw 的账号形状不同（前者要粘 token、有签到；后者零手工扫描、
 * 无签到），但「列表 / 余额 / 开关 / 删除」这一套交互完全一样。
 * 所以 Tab 只切换**数据源**（`?pool=teleagent|autoclaw`），不复制两份界面 ——
 * 复制的那天起，两边就会开始各自漂移。
 *
 * ## 失败必须自限
 *
 * 设置页是别人家的 slot：本插件挂坏了不该让整个面板白屏。注册整体包在 try/catch 里。
 *
 * @module dsh-teleagent-pool/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-teleagent-pool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var API = '/api/teleagent-pool'
    /** 只声明 `slots`：多写一个服务 = 该服务缺席时本 fiber 永久 pending。 */
    /**
     * 硬依赖。
     *
     * ⚠️ 只列**必需**的：`slots` 决定能不能挂面板，`layout` 决定点侧栏那一行能不能切过去。
     * `layout` 缺失时降级为「只挂设置页」，不能让整块插件因为一个可选服务而不加载。
     */
    var inject = ['slots', 'layout']

    /** 侧栏面板的稳定 id（`sidebar.panellist` 的 id 与 `main` 的 key 必须是同一个）。 */
    var PANEL_ID = 'dsh-teleagent-pool'

    var POOLS = [
      { id: 'teleagent', label: 'TeleAgent (电信)', hint: '需要手工取一次 token' },
      { id: 'autoclaw', label: 'AutoClaw (智谱)', hint: '从本机登录态自动读取' },
    ]

    /** 同源 JSON 调用（带超时；错误统一抛 Error）。 */
    function call(action, options) {
      var opts = options || {}
      var init = { method: opts.method || 'GET', headers: { accept: 'application/json' } }
      if (opts.body !== undefined) {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      var controller = new AbortController()
      var timer = setTimeout(function () { controller.abort() }, opts.timeout || 60000)
      init.signal = controller.signal
      return fetch(API + '/' + action, init)
        .then(function (response) {
          return response.text().then(function (text) {
            var payload
            try { payload = text === '' ? {} : JSON.parse(text) } catch (e) { payload = { ok: false, error: text.slice(0, 300) } }
            if (!response.ok || payload.ok === false) {
              throw new Error(payload.error || payload.message || ('HTTP ' + response.status))
            }
            return payload
          })
        })
        .finally(function () { clearTimeout(timer) })
    }

    var STYLE_ID = 'dsh-teleagent-pool-css'
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', 'dsh-teleagent-pool')
      style.textContent = [
        '.tap-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}',
        '.tap-card{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
        '.tap-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.22));padding-bottom:8px}',
        '.tap-tab{border:none;background:transparent;color:inherit;font-size:13px;padding:5px 12px;border-radius:8px 8px 0 0;cursor:pointer;opacity:.62}',
        '.tap-tab:hover{background:rgba(128,128,128,.1);opacity:.85}',
        '.tap-tab.on{opacity:1;font-weight:600;background:rgba(128,128,128,.14);box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary,#2563eb)}',
        '.tap-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.tap-title{font-weight:600;font-size:13px}',
        '.tap-muted{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:1.65}',
        '.tap-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));background:transparent;color:inherit;border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer}',
        '.tap-btn:hover:not(:disabled){background:rgba(128,128,128,.12)}',
        '.tap-btn:disabled{opacity:.5;cursor:default}',
        '.tap-btn-primary{background:var(--dsw-alias-state-business-primary,#2563eb);border-color:transparent;color:#fff}',
        '.tap-btn-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.tap-input,.tap-textarea,.tap-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));border-radius:8px;padding:7px 9px;background:transparent;color:inherit;font-size:12px;font-family:inherit}',
        '.tap-textarea{min-height:66px;resize:vertical}',
        '.tap-account{border-top:1px dashed var(--dsw-alias-border-secondary,rgba(128,128,128,.28));padding-top:10px;margin-top:2px;display:flex;flex-direction:column;gap:6px}',
        '.tap-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}',
        '.tap-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
        '.tap-tag{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32))}',
        '.tap-badge{font-size:11px;border-radius:6px;padding:1px 7px;background:rgba(37,99,235,.14);color:var(--dsw-alias-state-business-primary,#2563eb)}',
      ].join('\n')
      document.head.append(style)
    }

    function num(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return String(Math.round(value * 100) / 100)
    }
    function timeText(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      try { return new Date(ms).toLocaleString() } catch (e) { return '—' }
    }
    function accountLabel(row) {
      if (typeof row.nickname === 'string' && row.nickname.length > 0) return row.nickname
      if (typeof row.phone === 'string' && row.phone.length > 0) return row.phone
      return row.id
    }

    /**
     * 凭据有效期标签。**过期就红字**，快到期给个提醒档。
     *
     * 四档判定：
     * | 剩余 | 显示 | 样式 |
     * |---|---|---|
     * | `<= 0` | `凭据已过期` | 红字（`tap-err`） |
     * | `< 2 天` | `凭据 1 天后过期` | 红字（快过期也是要处理的事） |
     * | `< 7 天` | `凭据 5 天后过期` | 普通 tag |
     * | 其余 | `凭据 2026/12/01` | 淡色 tag |
     * | 解不出 | `凭据有效期未知` | 淡色（**不当成有效**） |
     */
    function credentialTag(account, isAuto) {
      var expiresAt = account && account.expiresAt
      var valid = typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0

      // 没有凭据的账号（AutoClaw 空壳）先说这件事，比"未知"更具体。
      // ⚠️ 快照里没有 `hasCredential` 字段，用 `accountKey` 判断 ——
      // 它们在同一次扫描里同源：有凭据才会写入 accountKey。
      if (isAuto === true && account && typeof account.accountKey === 'string' && account.accountKey.length === 0) {
        return h('span', { className: 'tap-muted', key: 'cred' }, '无凭据')
      }

      if (!valid) {
        return h('span', { className: 'tap-muted', key: 'cred', title: 'token 里解不出 exp，无法判断剩余时间' }, '凭据有效期未知')
      }

      var remainingMs = expiresAt - Date.now()
      if (remainingMs <= 0) {
        return h('span', {
          className: 'tap-tag tap-err',
          key: 'cred',
          title: '有效期 ' + timeText(expiresAt) + ' —— 需要重新登录',
        }, '凭据已过期')
      }

      var days = Math.floor(remainingMs / 86400000)
      if (days < 2) {
        return h('span', {
          className: 'tap-tag tap-err',
          key: 'cred',
          title: '有效期 ' + timeText(expiresAt),
        }, days === 0 ? '凭据今天过期' : '凭据 ' + days + ' 天后过期')
      }
      if (days < 7) {
        return h('span', {
          className: 'tap-tag',
          key: 'cred',
          title: '有效期 ' + timeText(expiresAt),
        }, '凭据 ' + days + ' 天后过期')
      }
      // 时间长了就只报日期，别天天提醒
      var date = ''
      try { date = new Date(expiresAt).toLocaleDateString() } catch (e) { date = timeText(expiresAt) }
      return h('span', { className: 'tap-muted', key: 'cred', title: '有效期至 ' + timeText(expiresAt) }, '凭据 ' + date)
    }

    /** 主组件：两个 Tab 共用一套交互。 */
    function Panel() {
      const [tab, setTab] = React.useState('teleagent')
      const [pools, setPools] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [input, setInput] = React.useState('')

      /**
       * 载入状态。
       *
       * @param {{ refresh?: boolean }} [options]
       *
       * ⚠️ `refresh: true` 用于「刚打开面板」的场合：先拉一次状态让界面立刻有东西，
       * 再**主动触发**服务端刷新余额 + 重新解凭据有效期，最后再拉一次。
       * 只靠 `call('state')` 拿到的是**上次落盘的快照** —— 积分可能是几小时前的，
       * 凭据可能已经过期了却还显示有效。用户打开面板想看的就是**现在**的数字。
       */
      const load = React.useCallback(function (options) {
        const refresh = options !== undefined && options.refresh === true
        const first = call('state')
          .then(function (payload) { setPools(payload.pools); setError(''); return payload })
          .catch(function (failure) { setError(String(failure.message || failure)); return undefined })

        if (!refresh) return first
        // 全量刷新：两条并行走（两家号池互不牵连，一个失败不该拖住另一个）
        return first.then(function (payload) {
          if (payload === undefined) return payload
          return Promise.all([
            call('balance/refresh', { body: { pool: 'teleagent' }, timeout: 90000 }).catch(function () {}),
            call('balance/refresh', { body: { pool: 'autoclaw' }, timeout: 90000 }).catch(function () {}),
          ]).then(function () {
            return call('state')
              .then(function (fresh) { setPools(fresh.pools); return fresh })
              .catch(function () { return payload })
          })
        })
      }, [])

      // 进入面板即全量刷新（拿到最新的积分与凭据有效期）
      React.useEffect(function () { load({ refresh: true }) }, [load])

      function run(label, action, body, successText) {
        setBusy(label)
        setNotice('')
        setError('')
        var payloadBody = Object.assign({ pool: tab }, body || {})
        return call(action, { body: payloadBody })
          .then(function (payload) {
            if (successText) setNotice(typeof successText === 'function' ? successText(payload) : successText)
            else setNotice('完成')
            return payload
          })
          .catch(function (failure) { setError(String(failure.message || failure)) })
          .finally(function () {
            setBusy('')
            return load()
          })
      }

      var current = pools === null ? null : pools[tab]
      var accounts = (current && current.accounts) || []
      var settings = (current && current.settings) || {}
      var isAuto = tab === 'autoclaw'
      var loginUrl = !isAuto && current ? current.loginUrl : ''

      function addTeleagent() {
        var text = input.trim()
        if (text === '') { setError('先把含 token= 的回调链接（或 token 本身）粘进来'); return }
        run('add', 'accounts/add', { input: text }, function (payload) {
          return '已添加：' + ((payload.account && payload.account.nickname) || '账号')
        }).then(function (payload) { if (payload) setInput('') })
      }

      function scanAutoClaw() {
        run('scan', 'autoclaw/scan', {}, function (payload) {
          return '扫描完成：发现 ' + payload.scanned + ' 个，新增 ' + payload.added + ' 个'
        })
      }

      return h('div', { className: 'tap-root' }, [
        // ── Tab 切换 ──
        h('div', { className: 'tap-tabs', key: 'tabs' }, POOLS.map(function (pool) {
          return h('button', {
            key: pool.id,
            className: 'tap-tab' + (tab === pool.id ? ' on' : ''),
            onClick: function () { setTab(pool.id); setNotice(''); setError('') },
            title: pool.hint,
          }, pool.label)
        })),

        error !== '' ? h('div', { className: 'tap-err', key: 'err' }, error) : null,
        notice !== '' ? h('div', { className: 'tap-ok', key: 'ok' }, notice) : null,

        // ── TeleAgent：加账号 ──
        isAuto ? null : h('div', { className: 'tap-card', key: 'add' },
          h('div', { className: 'tap-title' }, '添加 TeleAgent 账号'),
          h('div', { className: 'tap-muted' }, [
            '1) 点「打开登录页」用天翼账号登录；',
            h('br', { key: 'b1' }),
            '2) 登录完成后按 F12 → Network → 勾选「保留日志」，重新完成一次授权；',
            h('br', { key: 'b2' }),
            '3) 点开那条 cowork/auth?code=… 请求，在 Location 响应头或响应体里找到 token=，整条链接粘到下面。',
          ]),
          h('div', { className: 'tap-row', key: 'r1' },
            h('button', {
              className: 'tap-btn',
              disabled: !loginUrl,
              onClick: function () { if (loginUrl) window.open(loginUrl, '_blank', 'noopener') },
            }, '打开登录页'),
            h('button', {
              className: 'tap-btn',
              disabled: !loginUrl || !navigator.clipboard,
              onClick: function () {
                if (!loginUrl || !navigator.clipboard) return
                navigator.clipboard.writeText(loginUrl)
                  .then(function () { setNotice('登录链接已复制') })
                  .catch(function () {})
              },
            }, '复制登录链接'),
          ),
          h('textarea', {
            className: 'tap-textarea',
            key: 'in',
            placeholder: '粘贴含 token= 的回调链接，或直接粘贴 token',
            value: input,
            onChange: function (event) { setInput(event.target.value) },
          }),
          h('div', { className: 'tap-row', key: 'r2' },
            h('button', {
              className: 'tap-btn tap-btn-primary',
              disabled: busy !== '',
              onClick: addTeleagent,
            }, busy === 'add' ? '校验中…' : '完成登录'),
          ),
        ),

        // ── AutoClaw：扫描本机 ──
        isAuto ? h('div', { className: 'tap-card', key: 'scan' },
          h('div', { className: 'tap-title' }, 'AutoClaw（智谱）账号'),
          h('div', { className: 'tap-muted' }, [
            '不需要粘任何东西：只要在 AutoClaw 桌面端登录过，本插件就能从本机加密凭据里读出来',
            '（Windows DPAPI + AES-256-GCM，同用户可解、换用户解不开 —— 这是设计如此）。',
            h('br', { key: 'b1' }),
            current && current.paths ? '数据目录：' + current.paths.userDataDir : null,
          ]),
          h('div', { className: 'tap-row', key: 'r' },
            h('button', {
              className: 'tap-btn tap-btn-primary',
              disabled: busy !== '',
              onClick: scanAutoClaw,
            }, busy === 'scan' ? '扫描中…' : '扫描本机账号'),
            h('button', {
              className: 'tap-btn',
              disabled: busy !== '',
              onClick: function () { run('cat', 'autoclaw/catalog', {}, '模型目录已刷新') },
            }, busy === 'cat' ? '刷新中…' : '刷新模型目录'),
          ),
          h('label', { className: 'tap-row', key: 'as' },
            h('input', {
              type: 'checkbox',
              checked: settings.autoScan !== false,
              disabled: busy !== '',
              onChange: function (event) {
                run('as', 'settings', { autoScan: event.target.checked },
                  event.target.checked ? '已开启启动自动扫描' : '已关闭启动自动扫描')
              },
            }),
            h('span', { key: 'l' }, '启动 DSH 时自动扫描本机账号'),
          ),
          current && current.channels && current.channels.length > 0
            ? h('div', { className: 'tap-muted', key: 'ch' },
              '可用渠道 ' + current.channels.length + ' 个，模型 ' + ((current.models && current.models.length) || 0) + ' 个'
              + (current.catalogFallback ? '（目录为兜底表，未能从服务端拉取）' : ''))
            : null,
        ) : null,

        // ── AutoClaw 账号切换（本机账号目录层面）──
        isAuto ? h('div', { className: 'tap-card', key: 'acct' }, [
          h('div', { className: 'tap-title', key: 't' }, 'AutoClaw 登录账号（切换需重启客户端）'),
          h('div', { className: 'tap-muted', key: 'hint' }, [
            '对话固定用**当前激活账号**。切号必须改写账号指针并重启 AutoClaw（官方错误码 ',
            'account_switch_requires_restart），会关掉窗口十几秒。',
          ]),
          accounts.length === 0
            ? h('div', { className: 'tap-muted', key: 'none' }, '先点「扫描本机账号」')
            : null,
        ]) : null,

        // ── 号池 ──
        h('div', { className: 'tap-card', key: 'pool' },
          h('div', { className: 'tap-row' },
            h('div', { className: 'tap-title', key: 't' }, '号池（' + accounts.length + '）'),
            h('button', {
              className: 'tap-btn',
              key: 'rf',
              disabled: busy !== '',
              onClick: function () { run('rf', 'balance/refresh', {}, '余额已刷新') },
            }, busy === 'rf' ? '刷新中…' : '刷新余额'),
            // ⚠️ AutoClaw 没有每日签到：给按钮就是骗人。如实显示能力。
            isAuto
              ? h('span', { className: 'tap-muted', key: 'nk', title: (current && current.checkin && current.checkin.reason) || '' }, '无每日签到')
              : h('button', {
                className: 'tap-btn',
                key: 'ck',
                disabled: busy !== '' || accounts.length === 0,
                onClick: function () {
                  run('ck', 'checkin/claim', {}, function (payload) {
                    var rows = payload.results || []
                    var ok = rows.filter(function (row) { return row.ok }).length
                    return '签到完成：' + ok + '/' + rows.length + ' 个账号已处理'
                  })
                },
              }, busy === 'ck' ? '领取中…' : '一键签到'),
          ),

          isAuto ? null : h('label', { className: 'tap-row', key: 'auto' },
            h('input', {
              type: 'checkbox',
              checked: settings.autoCheckin === true,
              disabled: busy !== '',
              onChange: function (event) {
                run('au', 'settings', { autoCheckin: event.target.checked },
                  event.target.checked ? '已开启每日 09:00 自动签到' : '已关闭自动签到')
              },
            }),
            h('span', { key: 'l' }, '每天 09:00（UTC+8）自动全量签到；过点未开机则开机后补签'),
          ),

          h('div', { className: 'tap-row', key: 'st' },
            h('span', { key: 'l' }, '选号策略'),
            h('select', {
              className: 'tap-select',
              style: { width: 'auto' },
              value: settings.strategy || 'balance-desc',
              disabled: busy !== '',
              onChange: function (event) { run('sg', 'settings', { strategy: event.target.value }, '策略已更新') },
            },
              h('option', { value: 'balance-desc', key: 'b' }, '余额优先（推荐）'),
              h('option', { value: 'round-robin', key: 'r' }, '轮换'),
            ),
            h('span', { className: 'tap-muted', key: 'h' },
              '连续失败 ' + String(settings.failureCooldown != null ? settings.failureCooldown : 3) + ' 次后冷却 10 分钟'),
          ),

          isAuto
            ? h('div', { className: 'tap-muted', key: 'note' }, [
              '✅ 对话可用：经 AutoClaw 桌面端的本地配对协议（127.0.0.1:3917）转发给模型。',
              h('br', { key: 'n1' }),
              // ⚠️ 关于「自动换号」，必须如实说清，别给假承诺：
              // 桌面端只有一个激活账号，本地协议的 31 项 operation 里没有切号操作，
              // 且切号要求重启进程（account_switch_requires_restart）。
              '⚠ 额度用尽时：若本机有**多个** AutoClaw 实例（各自登录不同账号），会自动换实例；',
              '只有 1 个实例时无法远程换号 —— 需在 AutoClaw 里切换账号并重启客户端，',
              '或再开一个实例登录另一个账号（插件会自动发现并轮换）。',
            ])
            : h('div', { className: 'tap-muted', key: 'last' },
              '最近一次自动签到：' + ((current && current.checkin && current.checkin.lastRunAt)
                ? timeText(current.checkin.lastRunAt) : '从未')
              + '（' + ((current && current.checkin && current.checkin.succeeded) ? '已完成' : '未完成')
              + '，尝试 ' + String((current && current.checkin && current.checkin.attempts) || 0) + ' 次）'),

          current && current.tokenStorage === 'inline'
            ? h('div', { className: 'tap-muted tap-err', key: 'il' },
              '⚠ 本组合没有凭据服务：token 内联存放在插件数据目录（文件权限 600）。')
            : null,

          accounts.length === 0
            ? h('div', { className: 'tap-muted', key: 'empty' },
              isAuto ? '还没有账号。在 AutoClaw 里登录一次，然后点「扫描本机账号」。' : '还没有账号。按上面的三步添加一个。')
            : accounts.map(function (account) {
              return h('div', { className: 'tap-account', key: account.id },
                h('div', { className: 'tap-row' },
                  h('span', { className: 'tap-title', key: 'n' }, accountLabel(account)),
                  h('span', { className: 'tap-tag', key: 'b' },
                    // ⚠️ 「不可读」≠「0 分」。没有凭据的账号（在 AutoClaw 里从未真正登录过）
                    // 余额就是 `null`，显示成 0 会让人以为积分被清零了。
                    typeof account.balance === 'number' ? '积分 ' + num(account.balance) : '积分 不可读'),
                  isAuto
                    ? (typeof account.expiring === 'number'
                      ? h('span', { className: 'tap-tag', key: 'x' }, '将过期 ' + num(account.expiring))
                      : null)
                    : h('span', { className: 'tap-tag', key: 'c' },
                      account.lastCheckinDay ? ('签到 ' + account.lastCheckinDay) : '未签到'),
                  isAuto
                    ? (account.accountKey ? h('span', { className: 'tap-badge', key: 'k' }, '本机凭据') : null)
                    : null,
                  // 凭据有效期：两家号池都显示，且**过期就红字**
                  credentialTag(account, isAuto),
                ),
                h('div', { className: 'tap-row' },
                  h('label', { className: 'tap-row', key: 'en' },
                    h('input', {
                      type: 'checkbox',
                      checked: account.enabled !== false,
                      disabled: busy !== '',
                      onChange: function (event) {
                        run('tg:' + account.id, 'accounts/toggle', { id: account.id, enabled: event.target.checked })
                      },
                    }),
                    h('span', { key: 'l' }, '启用'),
                  ),
                  h('button', {
                    className: 'tap-btn',
                    key: 'bal',
                    disabled: busy !== '',
                    onClick: function () { run('b:' + account.id, 'balance/refresh', { id: account.id }, '余额已刷新') },
                  }, '刷新余额'),
                  isAuto ? null : h('button', {
                    className: 'tap-btn',
                    key: 'ck2',
                    disabled: busy !== '',
                    onClick: function () { run('c:' + account.id, 'checkin/claim', { id: account.id }, '已处理该账号的签到') },
                  }, '签到'),
                  h('button', {
                    className: 'tap-btn tap-btn-danger',
                    key: 'rm',
                    disabled: busy !== '',
                    onClick: function () { run('r:' + account.id, 'accounts/remove', { id: account.id }, '已删除') },
                  }, '删除'),
                ),
                account.lastError !== ''
                  ? h('div', { className: 'tap-muted tap-err', key: 'le' },
                    '上次失败：' + account.lastError + '（' + timeText(account.lastErrorAt) + '）')
                  : null,
              )
            }),
        ),
      ])
    }

    /**
     * 侧边栏入口按钮（左栏底部）。
     *
     * ## 为什么要有这个，而不只是设置页
     *
     * 号池是**日常要用的东西**（看积分、切号、签到），把它藏在设置里等于每次都要
     * 翻三层菜单。侧边栏一个按钮就能打开面板，这才符合使用频率。
     *
     * slot 名 `sidebar.footer.action` 是从 `dsh-cost-meter` 的注册源码抄的
     * （同一套 `slots.register({ name, id, order, inject })` 约定）。
     * 点它 → 打开设置页并定位到号池那一段。
     */
    /**
     * 侧栏那一行（图标 + 文字），显示在「插件」下方。
     *
     * ## 机制（从 `dshmarket` 的源码抄来的正式做法）
     *
     * 侧栏导航**不是**往 `sidebar.workspaces` 里塞按钮，而是成对注册：
     * ```js
     * // ① 这一行：看板列表用 sidebar.panellist
     * slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order, label }, IconRow)
     * // ② 那个页面：点开后在主区显示，用 main + key 绑定同一个 id
     * slots.register({ name: 'main', key: PANEL_ID, inject }, Page)
     * ```
     * 两者 `id` / `key` **必须是同一个字符串**，否则点了打不开或者页面挂不上。
     *
     * 切换靠 `layout` 服务（`ctx.inject(['layout'])`），本组件只负责"长什么样"。
     */
    function SidebarRow(props) {
      var size = (props && props.size) || 16
      // 用一个鱼形/池子意向的极简图形，跟着主题色走
      return h('span', {
        className: 'tap-rail',
        style: { width: size + 'px', height: size + 'px', display: 'inline-flex' },
        title: 'AI 号池',
      }, h('span', { style: { fontSize: Math.max(13, size) + 'px', lineHeight: 1 } }, '🐟'))
    }

    /**
     * 主区页面（点侧栏那一行后显示）。
     *
     * ⚠️ 这里**直接渲染 `Panel`**，不要用 `Panel()` 函数式调用 ——
     * 那样它的 hooks 会挂到调用者的 hook 链上，轻则顺序错乱，
     * 重则抛错被 slot 当成 crash 举报并**永久剔除**（那就再也显示不出来了）。
     */
    function SidebarPage() {
      return h('div', { className: 'tap-root', style: { padding: '16px 18px' } },
        h(Panel, null))
    }

    function apply(ctx) {
      try {
        installStyles()
      } catch (error) {
        // 样式失败不影响功能，只是难看一点。
      }
      try {
        var slots = ctx.get ? ctx.get('slots') : ctx.slots
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return

        // ① 设置页那一段（一直都在）
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'teleagent-pool',
            order: 42,
            label: function () { return 'AI 号池（电信 / 智谱）' },
          }, Panel)
        })

        // ② 侧栏那一行：「插件」下方的导航项
        slots.inject('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 1,
            label: function () { return 'AI 号池' },
          }, SidebarRow)
        })

        // ③ 那个页面的本体（点开后显示）
        slots.inject('main', function () {
          return slots.register({
            name: 'main',
            key: PANEL_ID,
          }, SidebarPage)
        })
      } catch (error) {
        // slot 是别人家的：挂坏了不该让整个面板白屏。
        try { console.warn('[dsh-teleagent-pool] 注册面板失败：', error) } catch (ignored) {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
