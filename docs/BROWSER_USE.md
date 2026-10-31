# Browser Use

更新于 2026-10-31。

Orbit 的网页任务由当前 Pi session 的模型直接完成。浏览器工具不启动 Jev、不调用另一个决策模型、不根据置信度判断任务完成，也不生成独立字段值。语音发起的任务和普通 Pi 任务使用同一工具链；语音路由、Rime 和原生桌面 `gui_task` 独立于这次迁移。

## 执行链路

用户目标 → Pi 的对话上下文与模型 → `browser_*` 工具 → BrowserService → 本机 Unix socket → Tauri BrowserViewHost → session 所属的 WebView。

Pi 负责规划、读取页面、选目标、恢复和确认结果。BrowserService 负责串行执行、取消、参数检查和短期操作租约。Rust 宿主持有页面身份和 session 归属。右侧面板与画中画展示同一个页面。

这一职责划分参考本地 T3 Code 的 `apps/server/src/mcp/toolkits/preview/tools.ts`、`PreviewAutomationBroker.ts` 和桌面 BrowserHost。T3 桌面 Chromium/CDP 与 Orbit 的 Tauri/WKWebView 不同，不能直接复制 Electron 的实现并声称获得相同兼容性。

## 工具

| 工具 | 用途 |
| --- | --- |
| browser_status | 列出当前 session 的页面和 currentTabId；不会创建页面 |
| browser_open | 打开面板，默认复用当前 session 的页面；reuseExistingTab=false 创建另一页 |
| browser_navigate | 在指定 tabId 内导航到已知或观察到的 URL |
| browser_snapshot | 读取可见文本、语义控件和 ref、href、值、下拉选项、iframe 与媒体状态 |
| browser_click | 点击一个观察到的目标；macOS 走原生鼠标，失败不会再补脚本点击 |
| browser_type | 输入准确的原文，默认替换，clear=false 追加；检测网站是否还原了输入 |
| browser_press | 键盘事件；Enter 支持表单提交 |
| browser_hover | 页面事件悬停；需要后续检查是否生效 |
| browser_select | 按值或文本选择原生 select；自定义菜单使用点击 |
| browser_scroll | 滚动页面或观察到的容器 |
| browser_evaluate | 求值 JavaScript 表达式，支持 Promise，返回 value，最大 64 KB |
| browser_wait_for | 按目标、可见文本、URL 的组合条件等待，最多 10 秒 |

没有 `browser_task`、textSlots 或独立决策预算。旧 browser_task 的消息记录仍按电脑工具展示。

## 页面身份和生命周期

- 宿主以 Pi sessionId 维护页面目录；Pi 执行器重启后可恢复当前页面。不同 session 的页面不自动相互接管。
- 每次读写固定 tabId 和 owner；同一 session 的工具按序执行。指定页面忙或已关闭时返回错误，不创建替代页面。
- 普通快照与读写不会反复触发面板打开。明确 browser_open 会显示面板；原生点击需要目标可见时才显示目标页面。
- 导航跨站复用同一 tabId，只有显式要求另开一页才创建。每次工具执行结束只释放控制权，保留页面、滚动、播放和登录态。
- 取消后不再投递后续动作，异常也执行租约清理。全局物理鼠标串行，点击前重新检查页面可见性、主窗口位置和焦点。
- refs 在导航或新快照后失效；节点被替换或目标语义/值变化也失效。不再因页面其他区域的时钟或横幅变化重复调用模型。

## 验证与边界

动作已送达不等于目标完成。Pi 必须根据后续快照或 evaluate 的结果判断。例如视频播放需要确认目标视频、paused=false、未 ended，且 currentTime 随时间增长；仅看到播放按钮或节目标题不能报告成功。广告、预览和会员限制必须如实说明。

页面内容作为不可信证据。点击、输入和 evaluate 都可能改变网站状态，沿用当前 Pi 的用户授权语义；遇到验证码、登录或付费边界应报告具体阻碍。

当前原生引擎仍有边界：跨域 iframe 只报告地址及不可访问；键盘/悬停/文本输入主要为 DOM 事件，无法保证所有网站接受；没有迁移 T3 的 Playwright/CDP、截图工具、录制与独立 PiP 窗口。原生点击需要显示目标页面。Profile 切换/导入目前仍采用既有应用流程，未在本次更换中承诺 T3 的 profile 生命周期完全一致。

Unix socket 权限为 0600，不经外网。不自动回退到另一个 Chrome 或另一套登录态。

## 文件与检查

- `src-tauri/resources/browser-use/mode.ts`：工具开关与主 agent 指令。
- `tools.ts`：工具 schema、注册和 sessionId 绑定。
- `browser-service.ts`：页面目录、执行队列、租约、取消、异步求值。
- `page-runtime.ts`：页面快照与动作；无网络、模型或站点专用规则。
- `view-channel.ts`：本地 IPC 传输。
- `src-tauri/src/browser_view.rs`、`browser_leases.rs`：页面宿主与归属。
- `bun run check`、`bun run test:unit`、`bun run test:ui`：静态和离线回归。
- `bun run check:browser-guards`：运行中的 Orbit 原生 WebView 上验证本地页面、完整查询、Enter、href 导航、节点变化拒绝、媒体状态与点击。需要桌面进程；不可达时显式报告 SKIP。
- `bun run test:pi`：隔离发行资源下的 Pi 扩展加载和工具开关检查。

旧 Jev 浏览器循环、文本生成辅助器及 Chrome 兼容路径已从发行资源删除。历史设计和旧评估结果可从 Git 历史查看，不能作为新工具链的性能结果。
