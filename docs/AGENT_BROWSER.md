# agent-browser 与 Orbit browser use

更新于 2026-11-17。对照对象是 `references/agent-browser` 的 `b06e2533`（`main`，`v0.43.0-11-gb06e2533`）。结论先说：作为 Orbit 的浏览器，现在这条链路更合适；作为给 agent 用的浏览器驱动，agent-browser 更完整。不该用它换掉第三栏。

## 它实际怎么跑

CLI 每次是一个短进程。它把一行 JSON 写到会话自己的 Unix socket（Windows 是本机 TCP），daemon 不在就拉起来。daemon 拿着 Chrome，命令之间不退出。默认无头浏览器闲置一小时后存档并退出；有窗口的、以及 `--cdp` / `--auto-connect` 挂上的浏览器不走这个超时。

Chrome 由 `cli/src/native/cdp/chrome.rs` 拉起，调试 WebSocket 地址从 Chrome 自己的发现端口读出来。`CdpClient`（`cli/src/native/cdp/client.rs`）直接说 CDP，没有 Playwright，也没有 Node。大的无障碍树走原始 JSON 文本，避免先解析成 `Value` 再反序列化一次。session 断开会立刻让还在等的命令失败，而不是挂到超时。

快照在 `cli/src/native/snapshot.rs`。它调 `Accessibility.getFullAXTree`，再把节点对上 `backendDOMNodeId`。ref 不是每次重编的序号。`RefMap`（`cli/src/native/element.rs`）按页面 session 加 frame，再用文档的 loader id 分桶。同一个 backend node 在同一份文档里反复快照，拿到同一个 `@eN`。loader 变了、iframe session 变了、或者 loader 根本读不到，旧 ref 作废，而且计数器只增不回收。虚拟无障碍节点没有 backend id，ref 只在这一次快照里有效。

点击不把坐标交给模型。`resolve_element_center` 在页面里量点击点，并用 `elementFromPoint` 看这一点上是不是另一个元素。挡住就返回 `covered by <div#consent-banner>`，不发 `Input.dispatchMouseEvent`。隐藏、禁用、在视口外同样失败。通过之后才走 CDP 的鼠标事件。`fill` 则是 `Runtime.callFunctionOn` 改 value 再派 `input`，不是逐键的可信输入。

安全在 daemon 里，不在提示词里。`policy.rs` 的动作策略可以允许、拒绝或要求确认；策略文件读失败时，除了 `close` 全部拒绝。`--allowed-domains` 只在它自己新开的可控上下文上生效，挂已有 Chrome、profile 或 restore 时直接拒绝启用，因为那些页面可能在它能拦截之前就已经打开。`--content-boundaries` 给页面输出包一层每次进程随机的边界，避免网页正文被当成指令。这是输出格式，不是浏览器沙箱。

## Orbit 现在的对应物

Orbit 的页面是窗口里的 CEF 子视图，人看着的就是 agent 在操作的那一页。工具是 Pi 上的 `browser_*`，没有内层浏览器 agent。

控制链仍是 `BrowserService` → Rust lease → 本机 WebSocket → Playwright `connectOverCDP` → 这一页的 CDP。快照用 Playwright 的 `ariaSnapshot({ mode: "ai" })`。每次快照换一个 generation，ref 是 `generation-nativeRef`。点之前再对一次标签、role、href 和文本签名，变了就拒绝。遮挡者不会单独报出来。Playwright 自己的 actionability 会挡住一部分点不中的情况，但错误是它的措辞，不是「被谁挡住」。

lease 在每次工具调用结束时放开，页面、登录和历史留在第三栏。profile 跟用户的 Chrome 分开。

## 哪一个更好

问的是 Orbit 该用哪套，答案是保持现在的产品形状，吸收它的驱动合同。

agent-browser 更好的地方是驱动，不是产品：

- ref 跟文档身份和 backend node 绑在一起，节点还在就不用让模型重新认一遍。Orbit 每次快照都作废，多一次观察，也多一次选错。
- 点击失败是闭合的，并说出挡住的元素。Orbit 这里靠 Playwright，信息更差。
- 域名、`eval`、下载是进程拒绝，不是说明文字。Orbit 现在只在提示里要求停在登录和验证码前。
- 没有 Playwright 进程。Orbit 每个活着的 tab 还挂着一个 `playwright-core` 连接。

Orbit 更好的地方是这个应用需要的那一半：

- 页面画在窗口里，文字、滚动、输入法是原生的。agent-browser 的 Chrome 是旁边一个进程，人要看就得另开窗口或看截图流。
- agent 用的是类型化工具，不是 shell。再套一层 `agent-browser click` 只是多一次解析，Pi 已经能直接调工具。
- 页面属于这次 session，调用结束不销毁。agent-browser 的默认无头会话会在闲置后关掉，登录要另配 profile 或 restore。
- 不碰用户正在用的 Chrome。它的 `--auto-connect` 能挂用户的浏览器，那是另一套风险，和第三栏不是同一件事。

所以不要把 browser use 换成这个 CLI。已经拿过来的是观察合同，不是它的进程模型：快照不再对每个 ref 各打一次 CDP；唯一控件的 ref 在后续快照里保持，导航后不回收旧 id；点击前用 `elementFromPoint` 拒绝被挡住、隐藏、禁用或视口外的目标，并说出挡住的元素。信任点击仍走 Playwright。直接 CDP 替换 Playwright 还没做：那会换掉跨域 frame 和可信输入，不是这次快照成本能换来的。
