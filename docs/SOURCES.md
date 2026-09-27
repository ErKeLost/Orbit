# 文档与代码依据

Thinking 与 Loading State 的当前样式来自 [Beautiful UI](https://www.beautifului.dev/) 的 Reasoning / Drive 组件，保留其 [MIT 许可](licenses/beautiful-ui.txt)。演示用固定阶段与示例文本已替换为 Pi 实际推理内容和运行事件；支持减少动态效果，计时器使用实际经过时间。

核对日期：2026-09-23。使用官方文档、发布注册表和安装包自带源码作为依据。项目中的演示状态已移除，连接、模型、工具和会话数据均来自 Pi。

| 编号 | 官方来源 | 已读取 / 核对的内容 | 实现位置 |
| --- | --- | --- | --- |
| T1 | https://v2.tauri.app/start/create-project/ 和 `@tauri-apps/cli@2.11.4 init --help` | 官方 CLI 初始化已有前端项目；`--ci`、应用名称、devUrl、frontendDist、build commands | `src-tauri/`，由 `tauri init` 生成 |
| T2 | https://v2.tauri.app/start/frontend/vite/ | 固定端口、strictPort、忽略 src-tauri、../dist | `vite.config.ts`, `tauri.conf.json` |
| T3 | https://v2.tauri.app/develop/calling-rust/ | `#[tauri::command]`、invoke、State、generate_handler | `src-tauri/src/bridge.rs` |
| T4 | https://v2.tauri.app/develop/calling-frontend/ | Channel 适合有序流式数据；JS `new Channel()` / onmessage | `src/lib/rpc.ts`, `bridge.rs` |
| T5 | https://v2.tauri.app/develop/resources/ | bundle.resources、Resource 路径解析 | `resources/gui-extension.ts` 的打包和加载 |
| T6 | https://platform.openai.com/docs/api-reference/models/list | OpenAI 兼容 `GET /v1/models` 响应的 `data[].id` 模型目录结构；认证只在 Rust 进程使用 | `bridge.rs`, `rpc.ts`, `Chat.tsx` |
| P1 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md | 33 个 RPC 命令、请求 id、仅 LF 分帧、delta-only message_update、agent_settled、扩展 UI 协议和限制 | `protocol.ts`, `rpc.ts`, `Panels.tsx`, `bridge.rs` |
| P1a | 安装包 `docs/rpc.md` 的 `ToolResultMessage` 与 `docs/session-format.md` | `ToolResultMessage.usage` 是可选的嵌套 LLM 用量；`SessionStats` 只提供会话总量、工具调用/结果数量，不提供普通工具或 skill 的单独 token 统计 | `protocol.ts`, `ToolCall.tsx`, `Inspector.tsx` |
| P2 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md | SessionManager.list(cwd)、SessionInfo、会话树 | 原生会话索引 |
| P3 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md | registerCommand、getAllTools、getActiveTools、setActiveTools、setLabel、ctx.navigateTree、waitForIdle | `gui-extension.ts` |
| P4 | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md 和 settings.md | 模型定义、reasoning 开关、动态可用 thinking levels、默认模型与 thinking | 复用已有 Pi 配置；GUI 不硬编码支持的 effort |
| P5 | Pi 0.87.1 安装包 `examples/extensions/subagent/` | 独立 Pi 进程、JSON 事件、并行调度、取消与用量聚合的官方扩展示例 | `resources/subagents/` 的执行基础；Orbit 另加持久 RPC、父子通信和状态树 |
| J1 | https://docs.typesafe.ai/concepts/how-to-build-with-system-one 和 https://docs.typesafe.ai/model-jaggedness/jev-1.13 | 代码掌控流程和副作用；Jev 只在本地提供的有界候选中选择；输入值、执行和重试权留在本地 | `resources/computer-use/jev.ts`, `gui-task-engine.ts` |
| J2 | macOS Accessibility API、`xa11y` 0.15、`computer-use-core` ledger | AX skeleton/drill、snapshot-qualified refs、live re-identification、Chromium AX activation、事件驱动等待、post-state、delivery/retry、App 生命周期 | `src-tauri/src/fast_ax.rs`, `src-tauri/src/ax.rs`, `crates/computer-use-core`, `src-tauri/resources/computer-use/xa11y-client.ts` |
| J3 | macOS Spotlight `kMDItemDisplayName`、`kMDItemCFBundleIdentifier`、`kMDItemContentType` | 已安装 App 的本地化显示名与稳定 bundle identity；精确事实优先于模型解析 | `desktop-app-resolver.ts` |
| R1 | https://react.dev/reference/react | React hooks 与组件生命周期 | React 组件；事件订阅有清理 |
| A1 | https://www.assistant-ui.com/docs/runtimes/custom/external-store.md | ExternalStoreRuntime、自有状态、convertMessage、onNew/onCancel | `Chat.tsx` |
| A2 | https://www.assistant-ui.com/docs/primitives/thread.md | Root / Viewport / Messages 的 children render function、ScrollToBottom | `Chat.tsx` |
| A3 | https://www.assistant-ui.com/docs/primitives/composer.md | Root、Input、Send、submitMode | `Chat.tsx` |
| A4 | 安装包 `@assistant-ui/core/src/react/primitives/message/MessageParts.tsx`、`runtime/utils/thread-message-like.ts` | 当前 Parts render function、tool-call、reasoning、status 类型；以真实导出为准 | 消息转换与渲染 |
| A5 | 安装包 `@assistant-ui/react-markdown/README.md` | MarkdownTextPrimitive | `Chat.tsx` |
| AE1 | https://www.assistant-ui.com/elements/tool-call、https://www.ai-elements.dev/components/conversation、https://www.ai-elements.dev/components/prompt-input、https://elements.ai-sdk.dev/components/shimmer | 当前 AI Elements registry 的 ToolCall、Conversation、PromptInput、Shimmer API；registry 源码已在 `work/reference/` 核对，ToolCall 保持官方 render props 形状并适配 Pi RPC | `src/components/ai-elements/`, `Chat.tsx` |
| M1 | https://motion.dev/docs/react | 从 motion/react 引入动画组件；MotionConfig reducedMotion | 入场反馈和减少动态效果 |
| Q1 | https://tanstack.com/query/latest/docs/framework/react/quick-start | QueryClient、Provider、useQuery、invalidateQueries | 会话、模型、命令、树和统计读取 |
| Z1 | https://github.com/pmndrs/zustand/blob/main/README.md | create store、immutable update、selector | `store.ts` |
| I1 | https://iconify.design/docs/icon-components/react/ | Icon、addCollection；本地 IconifyJSON | `Icon.tsx`, `icons.mjs` |
| B1 | https://bun.com/docs/cli/install 和 `bun install --help` / `bun update --help` | bun.lock、frozen-lockfile、--latest、--exact | Bun 管理全部 JS 依赖 |
| RS1 | https://rust-lang.github.io/rustup/ | 独立工具链、版本固定、安装配置 | Rust 1.98.1，`rust-toolchain.toml` |
| RS2 | https://static.rust-lang.org/dist/channel-rust-stable.toml | 2026-09-03 stable 为 1.98.1 | 工具链版本依据 |

Pi 的远端 main 分支会继续变化，因此实现同时核对了 **0.87.1 安装包**里的 docs/rpc.md、docs/sdk.md、docs/extensions.md、dist/modes/rpc/rpc-types.d.ts 和 dist/core/messages.d.ts；`src/lib/protocol.ts` 的回归测试覆盖这些实际结构。

2026-09-25 核对 npm registry、GitHub 标签和上游 `main`：最新正式版为 **0.87.1**（标签提交 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`），正式 RPC 仍为 33 个且类型结构未变。项目使用可复现的正式 npm 版本，不把分支提交冒充 SDK 更新。

依赖精确版本与注册表 URL 保存在 `versions.json`。Bun 与 Cargo 的锁文件用于复现，不能用“包名相同”推断它们版本号应相同。Tauri CLI、JS API、Rust crate 各自发布。

Rust 工具链下载使用 USTC 镜像解决官方 CDN 低速问题。执行前已将 rustup-init 的 SHA-256 与官方 `https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init.sha256` 核对，值为 `ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a`；编译器固定为已核对的 1.98.1。没有覆盖系统 Homebrew Rust。

## 组件、实时观测与多项目更新

- Markdown 统一使用 LobeHub `@lobehub/streamdown` 1.3.1。所有聊天正文与压缩摘要共用同一渲染入口，并按官方组合接入 `remark-gfm`、`remark-math`、`rehype-katex`、`preprocessLaTeX`、`latexGuard` 和 KaTeX `mhchem`；KaTeX 使用官方 CSS。流式正文启用字符级平滑显示，历史正文关闭淡入动画。代码围栏与 Mermaid 按官方 Playground（`site/src/components/CodeBlock.tsx`）在源码稳定后升级：Shiki 使用 `vitesse-dark` / `vitesse-light`，图表使用 `beautiful-mermaid` 1.1.3；流式期间保持纯文本以免每帧重高亮。
- 设置采用独立双栏工作区；会话树、常用工具、代码变更和控制台从日常导航收拢到设置分类。Provider 编辑器按标识、接口和凭据分区，保存会直接写入并同步 Pi 模型配置，然后重连当前项目。
- AI Elements 的 Conversation、Message、PromptInput、Shimmer 与 assistant-ui ToolCall 使用当前 registry/docs 的 props 形状，已经接入真实 Pi transcript、流式状态、工具请求和结果；不是静态示例数据。这里保留的是针对 Pi RPC 数据结构的本地轻量渲染适配，没有引入未使用的 assistant-ui runtime。
- 同包 `Button / Select / Input / TextArea / Modal / Tooltip / Collapse / Skeleton` 与 `@lobehub/ui/base-ui` 的 Switch 用于交互控件。ConfigProvider 注入 `motion/react`，ThemeProvider 负责主题。
- Lobe UI 的包声明仍引用 Motion 12；为遵守本项目使用最新 Motion 13.2.0 的要求，Bun overrides 将 Motion 去重到 13.2.0。已验证类型构建、组件运行与交互，不能据此宣称所有未使用的 Lobe UI API 都经过兼容验证。
- https://diffs.com/ 及安装包 `@pierre/diffs` 1.4.1 的 React 类型：完整 patch 用 `PatchDiff`，替换片段用 `MultiFileDiff` 并明确标注片段，写入内容用 `File`。依据 Pi 0.87.1 `dist/core/tools/edit.js` 中返回的 `details.patch`；不把其用于终端显示的 `details.diff` 冒充完整 unified patch。
- https://v2.tauri.app/plugin/dialog/ ：`open({ directory:true, multiple:true })` 选择多个文件夹；使用官方 Tauri CLI 添加插件，再通过 Bun 固定最新版本。
- Pi `get_session_stats` / `get_state` 每 2 秒读取；`message_update.usage`、`compaction_start/end`、重试与队列事件直接订阅。扩展 `gui-observe` 使用公共 `SettingsManager` 和 ExtensionContext API 读取配置及系统提示词，每 5 秒刷新。
- 压缩结束时 `estimatedTokensAfter` 是估计值；`contextUsage.tokens/percent` 可能为 null，显示待更新。Pi 没有压缩完成百分比，因此 UI 没有捏造进度数值。
- 多项目通过 Rust HashMap 分别持有 Pi 子进程，前端按项目区分请求、事件与会话状态。停止一个项目不会终止其他项目；原生进程隔离测试已覆盖。
- 中转站模型目录通过当前 Pi provider 的 `baseUrl` 和 `auth.json` 查询；API key 不经过前端 IPC 返回。目录中的模型只有在 Pi `models.json` 已配置时才会标记为可直接切换，避免 GUI 选择 Pi 不认识的模型。
- 连接前会把目录中的 `id/name/context_length/input_modalities/reasoning` 映射到 Pi 自定义 provider 模型定义；已有 Pi 模型的显式 reasoning、compat、api 和 maxTokens 配置优先保留。同步前生成 `models.json.bak`。
- 项目中同时存在独立加入的明暗主题与模糊切换代码，本次改动保留了这些代码。工作区基础样式放在 `src/styles/workspace-base.css`，避免主题文件覆盖导致布局消失。
