# Pi 功能覆盖与边界

以 Pi 1.0.0 官方 RPC / SDK / extensions 文档为基准（2026-10-02 复核）。这里区分原生 GUI、控制台和原始终端入口，不把“有个按钮”当作已支持。

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
| 新建、恢复、命名、克隆、分叉 | 会话列表、标题、会话树；Pi 持久化文件。切换/新建/克隆/分叉、切项目、会话树切分支都会先上聊天的骨架屏（`transcript.loading`），等 `hydrate` 把真正的会话换上来，不停在旧内容上再突然抽掉 |
| 树导航、标签 | GUI 附带扩展调用 ctx.navigateTree / pi.setLabel |
| 当前模型可用的所有工具、工具开关 | 设置；Pi 的 getAllTools / setActiveTools |
| 停止与队列 | 输入框；先 clear_queue 再 abort。排队中的 steer 不丢：第一条重新起一轮、其余的按 steer 排进这一轮继续投递；followUp 仍回草稿 |
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
| MCP 服务器（stdio / streamable HTTP） | 设置 → Pi 1.0 能力：Rust 读写 `~/.pi/agent/mcp.json`（写入前备份，密钥值只留在磁盘，列表只暴露 key 名与 OAuth 登录名）；连接状态、工具数量和 exposure 来自扩展的 `pi.getMcpServers()` 与工具 namespace。会话内临时注册用 `pi.registerMcpServer()`；OAuth 登录仍走 `/mcp` 或原始终端 |
| Codemode 与 Tool Search | 设置开关通过 `gui-tools-set` 激活这两个内置扩展工具；`codemode` 与 `tool_search` 在 Pi 1.0 中是 `model-only` 暴露，未激活时不计入 prompt 工具集。`codemode.mode`（on/only）由设置写入 settings.json |
| 工具暴露分类 | `gui-capabilities` 报告 direct / model-only / codemode / deferred / hidden 的数量；MCP 服务器可逐个切换 exposure（写入 `mcp.json`） |
| 图片生成与分类器模型 | `gui-media` 用 `getModelsOfType()` + `hasConfiguredAuth()` 列出可用图片/分类器模型；codemode 脚本可用 `models.generateImages()`、`models.classify()`，GUI 触发的生成结果写入 `~/.pi/agent/orbit-media/` 并提示路径。出图端点（provider / Base URL / 模型 / 密钥）在设置里可配，见下节 |
| 虚拟（路由）模型 | 扩展调用 `pi.registerVirtualModel()`；`/gui-virtual-model register` 接收数据驱动的路由规则，continuation/retry 默认粘在上一次成功回答的物理模型上以保缓存；`gui-virtual-models` 列出已注册项 |
| 缓存预热与 Codemode 设置 | 设置写入 `~/.pi/agent/settings.json` 的白名单键（`cacheWarming`、`codemode`），Rust 侧先校验取值；非白名单键直接拒绝 |
| 分支摘要导航 | 会话树同时提供普通导航和 `navigateTree({ summarize: true })` |
| 会话附加项目 | 顶栏标题弹出 roots；同一 session 可挂多个侧栏项目，扩展写入会话记录并注入根列表与各项目 AGENTS.md |
| 动态多 agent | 父 Pi 通过 `spawn_agent` / `spawn_agents` 以完成结果为边界进行 supervisor 委派；子进程复用 Orbit 内置 Pi，支持显式并行、嵌套、消息、跟进、等待、中止、状态树与持久化子会话。架构见 [MULTI_AGENT.md](MULTI_AGENT.md) |
| 屏幕通道（Screen） | 可选。手机端「屏幕」页请求后才启动。ScreenCaptureKit 采集（零拷贝 CVPixelBuffer）→ VideoToolbox 硬编 H.264（JPEG 为兜底）→ 单帧总线 → 独立 WebSocket（复用 token/E2EE/relay）→ 手机端 WebCodecs 解码到 canvas；输入经 `xa11y` 注入，与 `gui_task` 同一授权。最慢订阅者门控（保证 H.264 参考链不断）、跳号自动补关键帧、逐字节变化检测、单帧硬上限、带宽调节器（码率优先、只降不升过请求值）。需要 macOS「屏幕录制」授权。架构见 [SCREEN.md](SCREEN.md) |
| 电脑操作（Computer Use） | 可选。Pi 只提供目标 App、整体 goal、本地文本槽和预算；Spotlight resolver 解析本地化 App 身份；Rust `ax_control` worker 负责 AX skeleton/drill、snapshot refs、事件驱动等待、动作和 post-state；决策模型每轮只在当前能力候选中选择 operation+target。默认不截图，只保留唯一生产后端。默认关闭；输入框旁开关或设置开启。有 API/CLI 时不要用。架构见 [COMPUTER_USE.md](COMPUTER_USE.md) |
| 电脑操作决策模型 | 设置 → 操作电脑。Jev（TypeSafe）与 Cloudflare Clef-flash 两套后端都保留，共用同一 SystemOne 协议，可在配置页切换；同页保存 Jev Key、Cloudflare Account ID / API Token、SystemOne Base URL，并提供真实连接的延迟测试。选择写入 `~/.pi/agent/computer-use.json`，重连项目后生效 |
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

## Pi 1.0.0 升级备注（2026-10-02）

项目已升级到 npm 最新正式版 1.0.0，并把内置 runtime 重新打包为 `orbit-pi-runtime` 1.0.0。RPC 命令集仍是 33 个且类型未变，因此聊天、会话、树、队列、压缩等既有协议不需要改写；新增能力集中在扩展/SDK 侧，通过 GUI 扩展的状态通道暴露。

| Pi 1.0 变化 | 对 GUI 的影响 |
| --- | --- |
| Codemode、MCP、Tool Search 成为内置扩展（`builtin:mcp`、`builtin:codemode`、`builtin:tool-search`） | 默认加载但工具不激活；GUI 用现有工具开关激活，并新增能力面板管理 MCP 配置与 exposure |
| 工具暴露 `exposure` / `namespace` / `prepareLoadout` | `getAllTools()` 返回 exposure 与 namespace；`gui-tools` 状态一并发布，面板显示暴露分类 |
| `pi.getSettings()`、`pi.registerVirtualModel()`、`pi.registerMcpServer()`、`pi.getMcpServers()` | 扩展不再需要自行加载 `SettingsManager`；新增 `/gui-capabilities`、`/gui-mcp`、`/gui-virtual-model`、`/gui-media` |
| 新事件 `mcp_servers_change`、`session_info_changed`、`cache_warming_decision`、`context_with_system`、`agent_before_settle`、`provider_stream_event` | GUI 用前三个保持能力快照与标题同步；`context_with_system` / `agent_before_settle` / `provider_stream_event` 暂不接入，避免改变既有上下文与落定语义 |
| 图片与分类器模型进入 ModelRegistry（`generateImages` / `classify` / `getModelsOfType`） | `gui-media` 暴露目录与调用入口；凭据缺失时如实报告“无可用凭据” |
| `cacheWarming` 与 `codemode` 设置、默认全屏 TUI、`quietStartup` | Orbit 使用 RPC 模式，不受 TUI/全屏设置影响；前两项可在设置面板写入 |
| 0.86–0.87 已含的缓存预热、`/bug`、transcript-aware 指令与工具更新、canonical context edits | 0.87.1 起已在基线内；本次升级不改变这些行为的呈现方式 |

### Codemode 打包（2026-10-03 修复）

codemode 的沙盒是 `@earendil-works/pi-codemode`：QuickJS（`quickjs-wasi`）编译成 WebAssembly，跑在独立 worker 线程里，脚本只有 `tools` / `models` / `text` / `image` / `exit` / `store` / `load`，没有 fs、网络、进程或定时器。

打包后的运行时里，Pi 的 `getCodemodeWorkerSpecifier()` 走 `bundled-node` 分支，要求 runtime 目录下存在 `codemode-worker.js`；`getQuickJSWasmPath()` 用 `createRequire(...).resolve("quickjs-wasi/quickjs.wasm")` 找 wasm。`bun build` 不会自动产出这两个文件，因此 `scripts/bundle-pi.mjs` 现在：

- 用独立打包把 `scripts/codemode-worker.ts` 输出为 runtime 根目录的 `codemode-worker.js`；
- 复制 `quickjs-wasi` 的 `package.json` 与 `quickjs.wasm` 到 `pi-runtime/node_modules/quickjs-wasi/`；
- 构建后运行 `scripts/check-codemode.mjs`，真实启动一次沙盒（`return 1+1` + 一次工具调用），失败即中断构建。

`bundle-pi.mjs` 的 `buildFormat` 因此升到 5；`scripts/smoke-pi.mjs` 也在隔离资源目录上复跑同一校验。

### 图片模型（2026-10-03，2026-10-10 改为可配置）

Pi 只有 `openrouter-images` 一个内置图片 API（OpenRouter 的 chat completions + `modalities`）；`models.json` 里的模型一律被 `modelFromJson()` 归一成 chat（`ModelDefinitionSchema` 没有 `type` 判别字段），无法定义图片模型。因此图片模型只能由扩展通过 `pi.registerProvider({ api, models: [{ type: "image" }], images })` 注册。

这句“只能在扩展里注册”决定了配置放在哪里：providers 页管的是 `models.json`，而它根本表达不了一个图片模型，所以**出图端点是一个单独的配置文件** `~/.pi/agent/image.json`（`src-tauri/src/image_config.rs` 校验与写入），由扩展在注册时合并到内置默认之上。三个性质是这套设计成立的前提：

- **每个键都可选。** 缺少的键 = 保留内置值，所以没配过的安装和以前完全一样；只填一半就只改它点名的那些东西。
- **一次写入是一个 patch。** 设置页一次只改一个字段，所以存默认模型不能把旁边的端点删掉。缺键 = 保持，显式 `null` = 清除。
- **文件里没有凭据。** 密钥照 Pi 常规放 `~/.pi/agent/auth.json`，按配置里的 provider id 取；配置文件本身明文存储，不放 key。

内置默认是火山方舟（`https://ark.cn-beijing.volces.com/api/v3`，OpenAI 式 `POST /images/generations`，请求 `response_format: "b64_json"`），默认模型列表是四个 Seedream：`doubao-seedream-5-0-flash-260915` / `-5-0-260128` / `-4-5-251128` / `-4-0-20260415`；默认分辨率/画幅表（1K/2K/3K/4K × 8 种比例）也是内置的，可用 `sizes` 整体覆盖。密钥从 `auth.json` 按 provider id 读取，扩展不保存密钥。

入口分两处，按职责划分：

- **设置 → Pi 1.0 能力 → 图片模型**：默认模型、默认分辨率、默认画幅，以及「端点」对话框（provider id / 名称 / Base URL / API Key / 模型列表）。
- **providers 页的「图片模型」区**：只负责选默认模型；它显示的 Base URL 不参与出图，页面上的说明会指向上面那处。

写入 `image.json` 或 `auth.json` 后需要**重连项目**（扩展在注册时才读这份配置）。`gui-media` 与 codemode 的 `models.generateImages()` 都走这条路径。
