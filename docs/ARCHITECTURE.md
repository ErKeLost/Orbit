# 架构

Orbit 是一个 Tauri 2 应用：React WebView 负责界面，Rust 负责进程、磁盘和系统能力，
Pi 以子进程形式通过 RPC 提供 agent 能力。同一份 React 代码也运行在手机上，手机把
`invoke` 发回配对的桌面执行（见 [MOBILE.md](MOBILE.md)）。因此这里的“前端/后端”
不是两台服务器，而是同一个工作区的两个执行位置。

事实来源只有三处：Pi 写下的会话 JSONL、Rust 命令的返回值、Zustand 里的投影。
任何一份投影都必须能从另外两者重建，缓存只是加速，不是数据。

## 1. 分层与依赖方向

```text
App.tsx / src/hooks / src/components / src/shared
        │  界面编排、展示组件、无业务状态的工具
        ▼
src/features/*        chat / shell / source-control / settings / sessions / ...
        │  业务规则、feature 内状态、model ↔ ui
        ▼
src/lib/*             store / protocol / rpc-* / native / platform / format / time
        │  无 React 业务组件；可被 feature 与测试直接调用
        ▼
src-tauri/src/*       Tauri 命令、Pi 进程、会话文件、媒体、系统集成
```

`src/lib` 是基础层：`store.ts` 提供全局工作区投影，`protocol/` 只做事件归约与消息
类型，`rpc-*.ts` 管连接/请求/会话，`native.ts` 决定命令发往本机还是配对桌面，
`platform.ts`、`format.ts`、`time.ts` 收敛平台判断和展示格式。基础层不依赖
`src/features`，这样 tests/ 里的纯逻辑测试不需要挂载 React。

`src/features` 是业务层。每个 feature 尽量把纯函数放在 `model/`，把组件放在 `ui/`，
把跨组件状态放在自己的 store 或 hook 里；`source-control` 是最完整的样板
（`model/` 的 diff 解析、`hooks/` 的查询、`ui/` 的渲染）。

`src/components` 与 `src/shared` 是共享展示层，不拥有业务状态。依赖方向大体向下，
但不是严格无环：`components/CodeChange.tsx` 引用 `features/source-control/model` 的
diff 解析，`components/Icon.tsx` 引用 `features/shell/FileTypeIcon`。这类引用是为了
避免复制纯函数，新增代码不应把整块业务状态搬进 components。`lib/browser-import.ts`
反向引用 `features/shell/shellStore` 是目前唯一的 lib → feature 例外，属于待收口项。

### Rust 命令层

`src-tauri/src/lib.rs` 只做模块声明、插件初始化和 `generate_handler!` 注册；命令按域
落在模块里。Pi 桥按域拆分：`bridge.rs` 只保留多个域共用的连接注册表、运行时发现和
文件/路径小工具，具体命令跟着它读写的数据走。新增命令不要重新堆进 `bridge.rs`。

| 模块 | 职责 |
| --- | --- |
| `bridge.rs` | 共享的 Pi worker 注册表 `Bridge`、Pi/Node 运行时路径发现、`agent_dir` / `sessions_dir` 与 JSON 文件辅助函数；`bridge/tests.rs` 是这些共享行为的单测 |
| `pi_session.rs` | `pi_oneshot` / `pi_connect` / `pi_send` / `pi_disconnect` / `open_pi_terminal`，RPC 帧、流式 Channel、burst 判定 |
| `providers.rs` | Provider 目录与模型元数据、`models.json` / `auth.json` 写入、默认模型 |
| `gui_settings.rs` | 项目信任、`settings.json` 白名单、请求预算 |
| `mcp.rs` / `computer_use.rs` / `attachments.rs` | MCP 配置、Computer Use 决策后端与密钥、剪贴板/附件/媒体文件写出 |
| `sessions_cmd.rs` | 会话列表/删除/重命名/清空，以及 `session_project` / `session_image` / `session_stamp` / `session_turn_durations` |
| `sessions.rs` | 会话目录编码、JSONL 单遍扫描、列表缓存、轮次耗时 |
| `history.rs` | 从 JSONL 复现 Pi 的叶路径投影；图片按行偏移引用 |
| `media.rs` | 媒体元数据、asset protocol 直读、历史图片落盘去重与上限 |
| `git.rs` / `github_inbox.rs` / `gitlab.rs` | 工作区 Git、GitHub/GitLab 收件箱 |
| `notes.rs` / `automations.rs` / `search.rs` | 笔记、定时任务、文件与会话搜索 |
| `pty_term.rs` / `browser.rs` / `browser_view.rs` / `screen/` | 终端 PTY、Chrome/CDP、原生子 WebView、屏幕通道 |
| `remote.rs` / `remote_ops.rs` | Host 生命周期、配对传输、手机可调用命令镜像 |
| `runtime.rs` / `power.rs` / `splash.rs` / `mobile_*` | 运行时环境、唤醒锁、启动画面、手机生命周期 |

`pi_session.rs` 的 `pi_connect` 返回 Tauri `Channel` 而不是广播事件：一条连接的流只能
被一个 WebView 消费；手机则走 `connection.attach` 和 relay，不共享本地 Channel。

## 2. 状态归属

| 所有者 | 内容 | 生命周期 |
| --- | --- | --- |
| `lib/store.ts` | 当前投影连接的 `transcript`、`state`、`telemetry`、`connection`、错误、草稿、对话框/通知/状态、`liveSessions`、`agents`、模式开关、`panel` | 应用级；`event()` 用 `reduceEvent` 归约，`set()` 被 rpc 层调用 |
| `features/shell/shellStore.ts` | 工作区标签、`activeWorkspaceId`、`activeByProject`、每个标签的 pane 树、文件标签、侧栏/终端布局 | 标签不持久化；轨道/侧栏/终端等 UI 偏好写 localStorage，启动时重建首页 |
| `lib/rpc-core.ts` | `snapshots`（每条连接一份完整投影）、`connections`、`projectActive`、`sessionOwners`、待响应请求、事件队列、`pendingModels`、transcript cache | 进程/连接级；`closeConnection` 时删除对应条目 |
| `features/*/model` | 纯函数缓存与派生数据（diff、分组、路径、格式） | 无状态或短命 memo |

`rpc-core` 的 `current(id)` 是读取一条连接状态的唯一入口：如果 `id` 正是当前投影的
`connectionId`，它返回 `lib/store` 的实时快照；否则返回 `snapshots` 里的副本。
`patch(id, value)` 同时更新二者（仅当它是当前投影时写 store）、通知该连接的订阅者，
并维护缓存失效。分屏面板通过 `SessionScopeContext` 读取自己的连接投影，写入走
`patchConnectionSnapshot`，所以后台会话不会把内容写进前台标签。

### 模块级缓存与失效

- **transcript cache**（`rpc-core.ts`）：按会话文件路径保存最多 6 份 `transcript`，
  记 `stamp = "${size}:${mtimeMs}"`、Pi 的 `messageCount` 和 `dirty`。收到新事件即
  `dirty=true`；一轮 settle 后重新 stat、按 `messages + tools` 重算条数并清 dirty；
  `loadMessages` 只在文件戳与条数都对得上时直接采用；预取（`primeProjection`）绝不
  覆盖 dirty 条目；删除会话时 `forgetCachedTranscript`。
- **轮次耗时**：`lib/turn-duration.ts` 把结果按会话文件写 localStorage
  `pi-gui:turn-durations:v2:<path>`（最多 500 轮），只在该轮结束后写入，读时与 React
  Query 的 `["pi","turn-durations",sessionFile]` 合并；Rust 侧
  `sessions::DURATION_CACHE` 按 `(mtime, size)` 缓存同一份计算（最多 64 个文件，满了
  整表清空），由 `session_turn_durations` 提供历史会话的兜底值。
- **会话列表**：`sessions::LIST_CACHE` 按目录分桶、按 `(mtime, size)` 命中；扫描后
  剪掉已消失的文件。没有全局“当前会话”，一切以路径/连接 id 为键。

## 3. RPC 边界

前端只从 `lib/rpc.ts` 导入 Pi 客户端；它 re-export `rpc-core`、`rpc-connection`、
`rpc-session`、`rpc-projects`，依赖方向是 core ← connection ← session，避免环。
`request()` 生成 UUID、登记超时并按连接路由；`message_update` /
`tool_execution_update` 进入 burst 队列，可见连接按动画帧合并提交，后台连接按 100ms
合并，其余事件（审批、生命周期）立即应用，保证顺序。

`lib/native.ts` 是唯一的 `invoke` 入口：手机且 Host 宣告过该命令时，走
`runRemoteInvoke` → `host.invoke`；否则走本地 Tauri。Host 的宣告来自每次快照里的
`commands`（`remote.rs` 发布 `remote_ops::REMOTE_COMMANDS`），所以 TS 侧不复制白名单；
首次快照前所有调用保持本地，bootstrap 命令不会被错误地发到另一台机器。

Rust 侧 `remote_ops.rs` 是默认拒绝的安全边界：`REMOTE_COMMANDS` 列出允许项，
`allows()` 在读取参数前检查，`dispatch()` 再按名字调用与本地完全相同的函数。
排除项在文件头逐条说明理由（手机自身、Host 生命周期、剪贴板、浏览器子视图等）。

`tests/remote-commands.test.ts` 是这道边界的守卫：每个注册命令必须被镜像或被显式
排除；排除表不能过期、不能与白名单矛盾；白名单与 dispatch 分支必须一致；每个白名单
命令必须真实注册；`src/` 里除 `lib/native.ts` 外不得直接 import Tauri 的 `invoke`。

## 4. 会话加载

会话加载的完整权衡、四条路径和实测数据在 [SESSION_LOADING.md](SESSION_LOADING.md)。
一句话概括：`history::project` 直接读 JSONL，沿叶子的 `parentId` 链复现 Pi 的投影，
图片只留 `{session, at, ordinal}`；调用方仅在 `exact === true` 且投影条数等于
`get_state.messageCount` 时采用，否则退回 Pi 的 `get_messages`（权威但慢）。压缩、
分支摘要、context edit 会让 `exact=false`，所以投影写错只损失速度，不损失消息。

## 5. 测试约定

- `tests/` 下的 `bun:test` 是逻辑/协议/回归测试，可直接读 Rust 源文件做契约对账
  （如协议字段、远端命令表）。`bun run test:unit` 还会跑
  `src/features/source-control/model` 里的纯函数测试。
- 与组件放在一起的 `*.test.ts(x)` 由 Vitest 在 happy-dom 中运行，覆盖需要 DOM、
  React 或浏览器 mock 的界面：`source-control/ui`、`shared/hooks`、`shell/**/*.test.tsx`
  是当前范围。`bun run test:ui` 只跑这一组。
- `bun run test` 串起两个门禁；CI 把它们拆成 Unit tests / UI tests 两步，UI 步使用
  `if: always()`，避免单测失败时跳过 DOM 套件。
- Rust 测试写在对应模块的 `#[cfg(test)]` 里，例如 `history.rs` 的投影/分支/压缩用例、
  `sessions.rs` 的扫描与缓存用例；`cargo test --lib` 是 Rust 门禁。
- 纯逻辑优先放 `tests/` 或 feature 的 `model/`（可被 bun 直接跑）；需要渲染的放
  co-located `ui/`（Vitest）。测试文件名统一 `*.test.ts` / `*.test.tsx`。

## 6. 有意的重复

以下重复是边界造成的，不要“顺手合并”：

| 重复 | 为什么保留 | 谁在守卫 |
| --- | --- | --- |
| `remote_ops.rs` 的命令表 ↔ `src/lib/native.ts` 的 `invoke` 调用面 | 一边是安全白名单与分发，一边是调用路由；TS 不复制白名单，改由 Host 快照宣告。合并会让手机端拥有第二份可漂移的权限表 | `tests/remote-commands.test.ts`（注册表 ↔ 白名单 ↔ dispatch ↔ 排除表） |
| `history::project` ↔ Pi 的 `buildSessionPath` / `buildContextEntries` / `sessionEntryToContextMessages` | Pi 的版本在子进程里，调用它要序列化整段历史；Rust 版本只读文件、图片零拷贝。复现是有意的性能取舍，不是遗漏 | 运行时 `count === messageCount` 对账；`history.rs` 单测；被 ignore 的真实会话 parity 测试（`ORBIT_HISTORY_BENCH` / `ORBIT_HISTORY_EXPECT`） |
| Rust `ScreenSettings` / `ScreenStatus` ↔ TS `RemoteScreenSettings` / `RemoteScreenStatus` | 两端跨进程/网络，没有共享类型系统；生成代码会引入构建步骤，手写 + 对账更直接 | `tests/screen-protocol-parity.test.ts` 逐字段比较 Rust 源码与 TS 类型（异常表最小化） |

## 7. 命名与目录约定

- 组件文件用 PascalCase（`ChatPane.tsx`、`UnifiedDiffView.tsx`）；导出的组件同名。
- hook 导出 `useXxx`，文件用 kebab-case（`use-workspace-tabs.ts`）；存量
  `useAutomationScheduler.ts` 这类 camelCase 不批量改名。
- 纯模块在 `lib/` 用 kebab-case（`rpc-core.ts`、`media-src.ts`）；feature 内历史文件
  仍有 camelCase（`turnModel.ts`、`shellModel.ts`），新增模块优先 kebab-case。
- feature 内按 `model/`（纯函数与类型）、`ui/`（React）、`hooks/`（查询/副作用）分层，
  以 `source-control` 为样板；只有需要跨组件共享的 feature 状态才建 store，且不要
  复制 `lib/store` 的工作区投影。
- `docs/` 一个主题一个文件，跨文档用相对路径链接；`docs/archive/` 只放历史记录，
  新文档不要往 archive 里写。
