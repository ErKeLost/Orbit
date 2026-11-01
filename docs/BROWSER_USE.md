# Browser Use

更新于 2026-11-01。

Orbit 保留 Tauri。桌面使用 Tauri 的 CEF runtime，右侧浏览器是原生 Chromium 子视图。页面由 Chromium 渲染、合成并直接显示，文字选择、滚动、输入法、音视频都走浏览器原生路径。面板和画中画不经过 canvas、截图或图片流。

## 控制链路

`Pi session → browser_* → NativePage → Playwright → page-scoped CDP relay → 原生 CEF 页面`

前端只报告面板的逻辑坐标和可见性。后台先创建页面再通知前端，冷启动不依赖 React 事件订阅；前端重载时恢复 Rust 持有的页面目录。Rust 持有页面及其稳定 tabId、Profile 和 session lease；收起面板不销毁网页，明确关闭标签才销毁。自动化不会借用另一个 session 或用户当前的标签。

Pi 使用与 t3code 桌面预览相同的 CDP relay 模式连接已存在的原生页面。Playwright 不启动另一份浏览器。relay 只暴露调用者拥有的一个 page，不暴露应用主界面，也不允许创建其他 browser context。输入使用 Chromium 的可信鼠标/键盘通道，不使用系统全局鼠标或手动派发 DOM 键盘事件。

管理请求和原生 CDP 共用 WebSocket 服务，端点记录在 browser home 的 native-host.json（Unix 权限 0600）；管理协议在 Windows、macOS、Linux 使用相同实现。事件由异步通道唤醒，无轮询。原生 CDP WebSocket 仅绑定随机的 127.0.0.1 端口，使用每次运行生成的 token 和当前操作的 lease 校验；拒绝网页 Origin。CEF 自身的全浏览器调试端口保持关闭。CDP 请求 id 经 runtime allocator 分配，避免和 Tauri 内部请求冲突。

## 页面操作

快照来自 Playwright AI accessibility tree，包含 frame、ref、语义、href、输入值和媒体状态。同源与跨域 frame 均由 Chromium/Playwright 读取。导航、新快照和目标语义变化后需要刷新 ref。

操作送达后由 Pi 观察页面验证，不能把点击、播放按钮、广告或登录墙当成任务完成。browser_evaluate 的执行时间有界，支持异步值，输出最多 64 KB；取消时终止执行中的页面脚本，再释放 session lease。普通 Pi session 和 Rime 的消息路由不因浏览器迁移而改变。

## Profile 与构建

CEF 的资料目录位于 browser home 的 cef/ 下。应用外壳、默认浏览器和导入 Profile 使用不同的 request context。浏览器 Profile 使用独立 data_directory；Cookie 导入写入目标原生 Chromium context，通过页面的 Network.getAllCookies 读回核验值、域、路径、过期时间及标志，等待 Cookie 存储落盘。切换导入来源只影响新建页面，已有页面保留原 Profile。旧 WKWebView 的导入成功记录不作为 CEF 登录成功的证明，来源浏览器的设备绑定凭据仍不能仅靠 Cookie 复制。

桌面依赖固定的 Tauri CEF 分支、对应插件集和 @tauri-apps/cli-cef。它会打包 CEF framework 与 helper processes，因此安装包会包含 Chromium。Tauri 外壳保留。移动端继续使用平台 runtime。

全局快捷键插件有一个本地补丁：把等待主线程的修改命令移到异步 IPC 执行，避免 CEF 的 IPC 线程持有 PluginStore 时与主线程互相等待。补丁与许可证位于 vendor/tauri-plugin-global-shortcut。

## 验证

`bun run check`、`bun run test:unit`、`bun run test:ui`、`cargo check` 验证接口、类型、页面归属及原生构建。`bun run check:browser-guards` 在运行中的桌面应用上验证真实 Chromium、中文输入和可信点击。原生窗口中的显示与输入还需桌面交互验证。

## 构建要求和当前边界

此实现使用实验中的官方 Tauri CEF 分支，不能视为稳定版 Tauri 的等价替换。固定的提交、CLI、插件以及 Cargo.lock 必须一起更新；winit-gtk4 的提交由锁文件固定。Rust 最低 1.95，仓库使用 1.98.1。需要 CMake 和 Ninja，可通过 `python -m pip install cmake==4.4.4 ninja==1.13.2` 安装；隔离的本地环境可放在 work/build-tools，或用 ORBIT_NATIVE_TOOLS 指定其 bin 目录。桌面使用 cli-cef，移动端使用原有 CLI。

网页原生弹窗保持 CEF 的 opener 和 POST 语义，显示为 Chromium 原生窗口；目前尚未把这些弹窗接入 Orbit 的 session 标签目录。这部分与 t3code 的新标签页接管仍有差距。画中画当前在 Orbit 窗口内移动同一原生视图，并非跨应用的独立置顶窗口。DRM 和付费媒体播放需要单独验证。

CEF 151 的 framework 声明最低 macOS 13，应用的最低版本已同步；macOS 11/12 无法运行此原生内核。

本机验证目标是 Apple Silicon macOS。Windows、Linux 和移动端仍需要各自 CI/设备验证。CEF framework 和 helper 会增加安装包体积，本机未压缩的开发 .app 约 565 MiB。
