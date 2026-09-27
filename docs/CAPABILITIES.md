# Pi 功能覆盖与边界

以 Pi 0.87.1 官方 RPC / SDK / extensions 文档为基准（2026-09-25 复核）。这里区分原生 GUI、控制台和原始终端入口，不把“有个按钮”当作已支持。

## 覆盖结论

- **正式 RPC：33/33。** `RpcCommand` 的全部 33 个命令都有类型安全的控制台入口，聊天、模型、会话、树、队列、压缩等高频命令另有原生 GUI。`samples` 使用 `Record<RpcCommand['type'], ...>`，以后升级 Pi 若新增 RPC 命令，类型检查会直接暴露缺口。
- **Pi SDK：按 GUI 宿主需要接入，不是逐导出函数 100%。** GUI 使用 RPC 运行会话，并直接使用 SDK 的 `SessionManager.list`、`SettingsManager` 与 extensions API。`createAgentSession`、工具工厂、内存会话等用于开发另一种宿主的底层构件，不应为了“覆盖率”在同一 GUI 中重复实现 RPC 已经提供的能力。
- **完整 Pi 产品：不是 100% 原生 GUI。** OAuth、终端主题/快捷键和 TUI 专用自定义组件仍由原始 Pi 终端承载；这是 RPC 的公开边界，不是漏接一个 API。

| 能力 | 入口与实现 |
| --- | --- |
| 流式回答、Markdown、代码块、图片、思考内容 | assistant-ui 会话；按 contentIndex 合并增量，message_end 覆盖最终结果；GUI 会为自定义模型声明保留现有输入并追加 `image`，让端点实际决定是否支持图片；RPC、provider 和消息错误统一显示在工作区顶部 |
| 工具调用、参数、部分结果与最终结果 | 会话工具卡；toolCallId 关联 |
| 工具/技能用量归因 | Pi 的 `ToolResultMessage.usage` 若存在则按工具显示 input/output/cache/total tokens；普通 read/write/bash 工具没有独立 token 字段时显示未提供。技能和 prompt template 的消耗计入对应 assistant usage，Pi 没有公开的逐技能 token API |
| 中转地址与 API Key | 沿用本机 Pi models.json / auth.json；不把 Key 复制到前端、项目或包内 |
| 模型切换、effort | 输入框选择器；连接前同步当前 provider 的 `/v1/models` 元数据，再使用 get_available_models / get_available_thinking_levels；保留 Pi 已有模型的 reasoning/compat 覆盖 |
| 中转站完整模型目录 | composer 模型栏旁的目录按钮；Rust 读取 Pi provider 的 baseUrl/auth.json，请求 OpenAI 兼容的 `/v1/models`，展示远端全部模型并标记是否已写入 Pi models.json |
| 新建、恢复、命名、克隆、分叉 | 会话列表、标题、会话树；Pi 持久化文件 |
| 树导航、标签 | GUI 附带扩展调用 ctx.navigateTree / pi.setLabel |
| 当前模型可用的所有工具、工具开关 | 设置；Pi 的 getAllTools / setActiveTools |
| 停止与队列 | 输入框；先 clear_queue 再 abort，恢复未发送文本 |
| 引导消息、跟进消息、队列批次模式 | 运行中输入框的排队按钮与设置 |
| 手动压缩、自动压缩、tokens 与 Pi 费用统计 | 设置；自定义模型价格未配置时费用不代表账单 |
| 33 个官方 RPC 命令 | 控制台提供完整命令与参数入口，不自动重复有副作用的调用 |
| Bash、abort_bash、重试控制、原始会话条目、最后回复、HTML 导出 | 控制台；HTML 导出另有顶栏按钮 |
| Skills、提示模板、扩展命令 | 技能与命令面板；从 Pi 枚举，通过 prompt 执行 |
| 扩展 select / confirm / input / editor | GUI 对话框，以 id 返回 extension_ui_response |
| 扩展 notify / setStatus / setWidget / setTitle / set_editor_text | 提示、状态、文本组件、标题、编辑器 |
| 项目文件引用 | Composer 的 `@` 文件索引；从当前工作区筛选路径并插入引用 |
| Bash 实时输出 | 监听 Pi `bash_execution_update`，显示增量输出、命令、退出码、取消和截断路径 |
| 会话导入、分享、重命名、复制 | Pi 工具面板接入 `/import`、`/share`、`set_session_name`、`get_last_assistant_text` |
| Scoped Models、资源重载、快捷键、变更记录 | Pi 工具面板提供官方命令入口；需要 TUI 交互的命令打开原生 Pi 终端 |
| Pi Package 管理 | Pi 工具面板使用官方 `pi install`、`pi remove`、`pi update --extensions` 命令 |
| 分支摘要导航 | 会话树同时提供普通导航和 `navigateTree({ summarize: true })` |
| 会话附加项目 | 顶栏标题弹出 roots；同一 session 可挂多个侧栏项目，扩展写入会话记录并注入根列表与各项目 AGENTS.md |
| 动态多 agent | 父 Pi 通过 `spawn_agent` / `spawn_agents` 以完成结果为边界进行 supervisor 委派；子进程复用 Orbit 内置 Pi，支持显式并行、嵌套、消息、跟进、等待、中止、状态树与持久化子会话。架构见 [MULTI_AGENT.md](MULTI_AGENT.md) |
| 电脑操作（Computer Use） | 可选。Pi 只提供目标 App、整体 goal、本地文本槽和预算；Spotlight resolver 解析本地化 App 身份；Rust `ax_control` worker 负责 AX skeleton/drill、snapshot refs、事件驱动等待、动作和 post-state；Jev 每轮只在当前能力候选中选择 operation+target。默认不截图，只保留唯一生产后端。默认关闭；输入框旁开关或设置开启。有 API/CLI 时不要用。架构见 [COMPUTER_USE.md](COMPUTER_USE.md) |
| OAuth 登录、安装/更新/移除包、终端主题与快捷键设置 | 设置中的“打开 Pi 终端”；使用原始 Pi 功能 |
| 自定义 TUI 组件与终端专有扩展 | 原始 Pi 终端入口；RPC 的 custom() 无可移植的图形表示 |

## 事实上的限制

- 这不是官方 Pi 桌面客户端，产品代码为本地自建 GUI。
- RPC 文档明确指出 custom() 返回 undefined，多种终端 header/footer/editor 接口在 RPC 中为 no-op，主题 API 不可用。不能宣称任意第三方终端扩展都能原样显示在 React 中。
- Pi 没有内置逐次工具审批；确认弹窗来自需要用户输入的扩展。本 GUI 不伪造内置审批能力。
- 目前应用原生启动、终端入口按 **macOS** 实现。Tauri 支持其他平台不等于本应用已经在那些平台验证。
- Orbit 应用内置锁定版本的 Node 与 Pi runtime 并优先使用；项目/全局 Pi 仅作为开发与兼容回退。用户不需要单独安装 Node 或 Bun。
- GUI 使用 --offline 禁用 Pi 的启动更新和 catalog 联网；模型请求仍正常联网。更新 Pi/扩展后重新连接。
- GUI 不信任自定义中转站缺失的图片能力声明。连接前会为 `models.json` 中每个自定义模型保留现有输入并追加 `image`，原文件首次修改前备份为 `models.json.pi-gui.bak`；真正不支持图片的端点可能返回服务端错误。
- 项目信任沿用 Pi 保存的决定；未信任的项目本地资源可能被 Pi 忽略。可在原始 Pi 终端用 /trust 管理。
- 浏览器预览不具备原生 IPC，不能真实连接 Pi，也不会显示虚假的连接成功。
- 持久化依赖 Pi 原始文件。GUI 已提供受路径校验保护的本机会话删除；仍没有归档能力，Pi 的 RPC 本身也没有删除或归档命令。

## 新增能力

- 可搜索项目菜单，系统目录选择器支持一次添加多个目录。保存列表、切换项目、保留会话与输入草稿；各项目拥有独立 Pi 进程，后台任务继续运行。
- 常驻 Context 状态栏与可收起的运行详情：上下文用量/配置上限、剩余量、最大输出、预留 tokens、近期保留量、累计及当前回复用量、缓存读写、费用估算、压缩前后统计、摘要、取消/失败/重试、队列、工具、模型和会话信息。
- 实时压缩没有虚构百分比；测试确认压缩后 contextUsage 返回 null 时显示待更新。
- LobeHub Markdown、AI Elements Conversation/PromptInput/Shimmer、assistant-ui ToolCall、组件库控件、Motion 交互动画及 Pierre 文件/差异视图已实际接入。连接提示、版本页脚、快捷键说明和原生 window.prompt 已从常用界面移除。

## Pi 0.87.1 升级备注（2026-09-25）

项目已升级到 npm / GitHub 最新正式版 0.87.1。该版本包含此前 main 分支上的模型、压缩、重试、队列输入和工具采样改进；Orbit 继续使用稳定的 RPC 命令和 JSONL 事件边界，不需要改写前端协议。

| 已发布变化 | 对 GUI 的影响 |
| --- | --- |
| 模型注册表流式调用 | 扩展可通过已配置 provider 发起嵌套模型调用；没有新增 RPC 命令，GUI 继续显示标准消息、工具和扩展 UI 事件。 |
| 按模型压缩预算 | Pi 支持按模型覆盖 `reserveTokens` / `keepRecentTokens`；Orbit 当前仍展示和控制全局压缩设置。 |
| 重试退避上限 | Pi 提供默认 60 秒的 agent/摘要重试退避上限；Orbit 继续显示真实重试事件，不虚构进度。 |
| 内置工具严格采样与队列输入处理 | Pi 内部请求和 steer/follow-up 扩展输入处理改进；工具事件和 RPC 命令结构保持兼容。 |
