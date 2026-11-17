# OpenCode Browse 与 Orbit 浏览器

更新于 2026-11-17。对照对象是 `references/browse` 的 `fa55a5e`（`dev`，`v0.1.0-26-gfa55a5e`）。公告里的 0.1.0 是 `c3b29be`；`v0.1.1`（`0d5d907`）是从更早的 `49b22bc` 打的 release commit，不在当前 `dev` 尖上。OpenCode 主仓 `anomalyco/opencode` 没有 `.gitmodules`，Browse 是独立仓库，不是它的 submodule。

OpenCode 桌面里还有另一套浏览器：`packages/plugin-browser` 加 `packages/gui-plugins/src/browser`。那是应用内嵌页，桌面持有 CDP，服务端用 Code Mode 暴露 `tools.browser.*`。它不是这条 0.1.0 公告，也不在 `references/browse` 里。下面说的 Browse 只指扩展加 Rust relay 这一套。

## Browse 怎么接上 agent

一条进程，三个角色：`browse mcp`（stdio MCP 代理）、`browse` relay（本机 HTTP + 扩展 WebSocket）、Chromium 扩展（`chrome.debugger`）。代理不决定工具面，只把 `clientInfo.name` 放进 `OpenCode-Browser-Client`。relay 按这个名字选表面：

- 名字里有 `opencode`：plain tools。没有 `execute`。OpenCode 用自己的 code mode 把 `navigate`、`snapshot`、`click` 编进同一次脚本。
- 其他 MCP 客户端：只有 `execute`、`status`、`tabs`。`execute` 在 relay 里的 QuickJS 线程跑，上面有一层 Playwright 风格的 `page` / `locator`，底下仍是同一组 Rust tool。
- 不报客户端名的 CLI 看到全部工具。`OPENCODE_BROWSER_TOOLS=plain|execute|all` 可以改这个选择。

句柄是 tab，不是 session。`navigate` 不带 `tab` 会开一个后台 agent tab 并返回 id；之后每次调用都要带这个 id，或调用方起的 slug（`work-mail`）。用户点工具栏按钮借出的 tab 也可以用。agent 碰不到其他 tab，也不能把窗口拉到前台。登录、2FA、验证码、付款走 `handoff`，人做完再继续。

扩展协议没改。Rust relay 说的是原来 TypeScript relay 的 WebSocket。`chrome.debugger.attach(tab, "1.3")` 之后，CDP 命令经扩展转发。一个扩展对一个 tab 只能挂一个 debugger。

## Browse 怎么动页面

没有 Playwright 进程，也没有 Node。页面 crate 自己维护 frame tree、每个 frame 的 isolated world，以及跨文档导航后的 generation。默认不调 `Runtime.enable` / `Console.enable`，页面脚本里不留 `sourceURL` 或 browse 的全局变量。选择器和 aria snapshot 用的是 vendored 的 Playwright `InjectedScript`（来自 patchright-core，Apache-2.0），装进 isolated world，并且拿掉了它原来挂在 window 上的两个 listener。所以“去掉 Playwright 依赖”指的是运行时不再拉起 Playwright；快照质量仍靠那份注入脚本。

输入走 CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`。人化轨迹默认开着，点之前自己做 hit test，不靠 Playwright 的 actionability。ref 在导航或 generation 变化后失效。跨域 iframe 是 child target session，不是主世界 `evaluate`。

因为动的是用户自己的浏览器，guardrail 写在 CDP 出口：不许清全部 cookie、关浏览器、改站点权限；cookie 和 storage 限制在这个 tab、它的 opener/popup 和同组 tab 的 host；`readOnly` tab 只留观察类方法。Chrome 内部页和 Web Store 不能借出。

## Orbit 现在怎么做

Orbit 的浏览器是窗口里的 CEF 子视图，不是用户的 Chrome。`Window::add_child` 放一块 WKWebView/CEF view，文字、滚动、输入法由 Chromium 直接画。profile 在 browser home 的 `cef/` 下，和用户的 Chrome profile 分开；cookie 导入是另一条路，设备绑定凭据不能单靠复制 cookie。

agent 看到的也是直接工具，不再有 `browser_task`。`mode.ts` 会把历史的 `browser_task` 从活动工具里删掉，注册 `browser_open`、`browser_snapshot`、`browser_click` 这一组。Pi 自己规划、读页、验证。

控制链是：

`Pi browser_*` → `BrowserService` → Rust view channel（lease）→ `NativePage` → 本机 WebSocket → Playwright `connectOverCDP` → page-scoped CDP → 那一块 CEF view

Rust 持有 tabId、profile 和 session/site lease。一次工具调用 `acquire` 一个 owner，做完 `release`，页面、登录和历史都留着。CDP 只绑 `127.0.0.1`，带一次性 token 和当前 owner，拒绝带 Origin 的握手。Playwright 不另开浏览器。隐藏的 tab 会开 `Emulation.setFocusEmulationEnabled`，否则 Playwright 的 actionability 等不到帧。

快照是 Playwright 的 `ariaSnapshot({ mode: "ai" })`，ref 绑到这次 generation，目标签名变了就拒绝点击。`browser_evaluate` 有 64 KB 上限，取消时 `Runtime.terminateExecution`。模型可以传 ref，也可以传一个唯一 CSS selector；说明文字要求先看 snapshot，但工具本身没有 Browse 那层 CDP guardrail。

## 对照

| | OpenCode Browse | Orbit |
| --- | --- | --- |
| 页面在哪 | 用户正在用的 Chrome / Edge / Brave，扩展用 `chrome.debugger` | 应用窗口里的 CEF 子视图，独立 profile |
| 谁对 agent 暴露操作 | relay 按客户端名给 plain tools 或一个 `execute` | Pi extension 直接注册 `browser_*`，没有嵌套决策 agent |
| 驱动 | Rust 直接发 CDP；InjectedScript 只负责选择器和 aria snapshot | Playwright 包一层，再经自建 CDP relay 进 CEF |
| 运行时 | 一个数 MB 的 `browse` 二进制。公告写 25x 内存、23x 体积；仓库里只写了目标：二进制个位数 MB，每个 MCP 代理数 MB，relay 数十 MB。测量过程不在这份检出里 | Pi 进程里的 `playwright-core` 1.63.0，每个活着的 tab 再挂一个 CDP browser 连接 |
| 句柄 | tab id，可选用调用方 slug；没有隐式当前页 | session 拥有的 `tabId`；省略时用这个 session 的当前 tab |
| 人的页面 | 只能动 agent 打开的或用户借出的 tab；登录走 `handoff` | 第三栏就是给人看的同一页；弹窗还没进 session 目录 |
| 隐身 | 默认不 `Runtime.enable`，isolated world，不留标记 | 会为了焦点仿真和 `terminateExecution` 开 Runtime；这是自己的 CEF，不是用户的 Chrome |
| 失败边界 | 扩展没配对、debugger 被 DevTools 占着、后台 tab 截图要 nudge | host 不在、lease 被别人占着、ref 过期、Playwright 连接断开后下一调用重连 |

两边已经做成同一类接口：agent 直接拿页面操作，不再套一个“帮你浏览”的内层 agent。差在页面属于谁，以及操作底下还有没有 Playwright 进程。

## 不该直接搬的部分

Browse 的小，是因为它不渲染页面。Chromium 在用户已经打开的浏览器里。Orbit 的体积主要在打包进去的 CEF，换掉 Playwright 不会变成数 MB 的应用。

Browse 的 guardrail 是因为 agent 和用户共用一个 cookie jar。Orbit 的隔离是另一块 profile。把那套“不许清 cookie、不许关浏览器”抄过来，解决的不是现在这条链路的问题。

值得看的是驱动层，不是产品形态。Orbit 现在每次操作都要：Rust lease → 自建 WebSocket → Playwright 的 browser server 协议 → 再译回 page CDP。Browse 证明 aria snapshot、ref、跨域 frame 和可信输入可以不经过 Playwright 进程，只要留下 InjectedScript 和自己的 CDP 客户端。若要减掉 `playwright-core`，应替换 `src-tauri/resources/browser-use/native/`，不要改第三栏的原生视图，也不要改成去挂用户的 Chrome。
