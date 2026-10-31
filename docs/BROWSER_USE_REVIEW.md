# Browser Use 检查与优化建议

检查日期：2026-10-31。依据当前 Orbit 工作区和本地 `t3code/` 源码；本轮验证覆盖离线执行协议、DOM 输入和语音分段，未测真实网站账号登录成功率或生产延迟。

## 已修复的确定问题

- 任务在等待 Jev 决策、字段文本生成或操作确认时取消，旧实现仍可能继续点击或输入一步。现在在异步边界重新检查取消状态和时间预算，并把取消信号传到两个浏览器驱动的动作执行入口。
- WebView 的 `contenteditable` 分支通过布尔短路跳过了 `insertText`，随后把富文本节点当普通 input 使用。现在通过所属 document 的编辑接口输入；不支持编辑命令时使用 DOM 写入和 input 事件，并读回确认。
- 普通输入框收到 input 事件后，网站可能把值还原。现在还原会返回 `fill-unconfirmed`，不能报告输入成功。
- 原生点击坐标先 JSON.stringify，经过通道序列化后成为字符串，调用方却按坐标对象访问。现在直接返回对象、检查数值，并在点击前验证目标没有被覆盖；同源 iframe 的点击会累加框架位置。
- 系统鼠标注入报错后不能再补一次脚本点击，因为失败可能发生在 mouse-down 之后。现在保留错误，避免重复激活控件。
- 清理了驱动中“任务结束自动关闭页面”的过期注释；实际行为仍是释放操作权，保留标签页。

## 与 t3 code 的实际差别

| 能力 | Orbit 当前实现 | t3 code 本地实现 |
| --- | --- | --- |
| 主浏览器 | Tauri 原生 WebView，macOS 为 WKWebView；另有 Chrome CDP 兼容路径 | Electron Chromium 桌面页面，以及 Playwright/CDP 服务端路径 |
| 操作 | DOM 节点观察；macOS 点击经过系统鼠标，输入与选择仍依赖页面脚本 | 桌面 debugger/CDP 通道；服务端复用 CDP 与 Playwright |
| 页面归属 | session/site 租约和每次操作的 tab/owner；完成只 release | threadId/tabId 标识，集中管理页面宿主与生命周期 |
| Profile | 导入源映射到持久分区；当前激活分区改变后原页面会重建 | profile partition 在 tab 生命周期内固定 |
| 新窗口 | 注入 window.open / target 拦截，再通知界面创建 tab | 浏览器宿主管理页面及自动化通道，具有显式页面身份 |
| 画中画 | 主窗口内移动同一原生 WebView 的矩形 | 桌面有独立 PiP 窗口，另有服务端串流 PiP |

参考文件：

- `src-tauri/resources/browser-use/view-driver.ts`、`browser-driver.ts`、`browser-engine.ts`
- `src-tauri/src/browser_leases.rs`、`browser_view.rs`、`browser.rs`
- `t3code/apps/desktop/src/preview/DesktopBrowserHost.ts`、`BrowserSession.ts`、`Manager.ts`
- `t3code/apps/server/src/preview/ServerBrowser.ts`、`ServerBrowserPage.ts`
- `t3code/apps/web/src/browser/HostedBrowserWebview.tsx`、`desktopTabLifetime.ts`

## 建议按这个顺序优化

1. **把新标签页纳入任务的页面集合。** 现在页面新开的 tab 会进入界面，但 ViewDriver 仍持有原 tab。给新窗口事件增加 openerTabId、owner、profileId，并把创建/关闭/激活作为 BrowserHost 事件；任务只在自己的页面集合里解析目标。否则用户看到了新网站，任务可能仍在观察旧页面。
2. **明确要继续操作哪一页。** browser_task 目前只有 goal/url，没有显式 tab 选择。保留 scope/site 租约，同时提供可读页面目录和稳定 tabId；用户说“回到刚才的页面”时由上层选择目标，再由驱动固定执行。不要用全局当前页代替任务目标，也不要按站点文本写死规则。
3. **Profile 固定到页面创建时。** 将 profileId 存到 Tab 的身份中；改变默认 Profile 只影响新页面。需要切换现有页面时显式重建并告知页面状态会重置。Cookie 导入成功和网站已经登录是两个结果，两边的 Cookie 导入都不能保证迁移 localStorage、设备绑定凭据等状态。
4. **减少依赖前台物理鼠标。** 当前每次原生点击有 180ms、60ms、40ms 的固定等待，并依赖主窗口位置。建议让 BrowserHost 隔离渲染器与操作协议，逐步把需要高兼容性、跨源 iframe 和后台操作的网站迁到 CDP 驱动；同时解决统一 Profile、页面展示与用户输入回传，避免切到另一套无关登录态。仅给 WebView 通道换成 WebSocket 不能解决这些问题。
5. **合并观察请求，改进页面就绪判断。** ViewDriver 每轮分别读取 status、安装用户操作监听、读取计数和 snapshot；可把后三步合成一次脚本。原生 eval 还会等待 load 完成，带长连接或慢资源的页面可能拖长等待。改为文档可读加有界 DOM 稳定判断，再通过页面事件推送状态；用 observationMs、decisionMs、actionMs 分开量化收益。

优先建设一个统一 BrowserHost，持有页面身份、Profile、任务租约和页面事件；Jev 只选择观察到的动作，驱动只负责执行，右侧面板和 PiP 只负责显示同一页面。这样可以保留当前 Jev 循环，同时逐步提升浏览器宿主能力。
