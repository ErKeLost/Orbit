# Codex vs Orbit/Pi：多 Agent 原理对照

> 对照基线：
> - Codex：`vendor/codex` @ `5009a99`（2026-10-17，已更新到最新 main）。行号相对 `vendor/codex/codex-rs/`。
> - Orbit/Pi：本仓库 `src-tauri/resources/subagents/` + `docs/MULTI_AGENT.md`。Pi 自身**没有** agent 概念，多 agent 是 Orbit 加的控制面。
>
> 详细单侧报告：`docs/archive/analysis/codex-multi-agent.md`、`docs/archive/analysis/pi-multi-agent.md`。

## 0. 一句话总结

两者是**同一个交互契约的两套实现**：工具名、canonical path、信封格式、`wait` 只回摘要、steer/followup 双投递几乎逐条对应（Orbit 的 `FINAL_ANSWER`/`NEW_TASK` 信封与 Codex 的渲染**逐字符相同**：`core/src/context/inter_agent_completion_message.rs:41`、`core/tests/suite/subagent_notifications.rs:2395`）。

**根本差别在「内核级」vs「控制面级」**：Codex 把 agent 树做进内核（`AgentControl` trait + registry/residency/mailbox/execution limiter/rollout budget + `thread_spawn_edges` 持久化 + protocol 事件）；Orbit 在 Pi 之上用「一个 worker 一个独立进程」+ 一个 TS runtime 把同一套语义**外挂**出来，Pi 只当执行引擎。

## 1. 逐维度对照

| 维度 | Codex @5009a99 | Orbit / Pi | 证据 |
|---|---|---|---|
| 层次 | 内核子系统：`AgentControl` + `LocalAgentRuntime` | Pi 之上的扩展层控制面（`SubagentRuntime`） | `core/src/agent/api.rs:41`、`core/src/agent/control/runtime.rs:184` / `runtime.ts` |
| 进程模型 | 同进程内的 session **thread** | **进程外**：每 worker 一个 `node pi --mode rpc` | `core/src/agent/control/spawn.rs:684` / `runtime.ts:507-538` |
| 世代 | 由 `MultiAgentVersion` 选择后端，版本随 thread 持久化（`SessionMeta.multi_agent_version`） | 只有一套，对齐 V2 的工具面 | `protocol/src/protocol.rs:3205`、`config/mod.rs:1635-1662`、`session/mod.rs:4265` / `tools.ts:16-23` |
| 工具面 | V2 6 个：spawn/send_message/followup_task/wait/interrupt/list | 6 个，同名同义 | `core/src/tools/spec_plan.rs:755-777` / `tools.ts:16` |
| **结果回传** | **queue-only（`trigger_turn:false`）→ 不唤醒父**，父须 `wait_agent` 或下次采样 | **`triggerTurn:true`** → 父运行中 steer 进下一请求，空闲则**主动起一轮** | `core/src/agent/control/completion.rs:117` / `tools.ts:142-171` |
| 信封格式 | `Message Type: FINAL_ANSWER` / `Task name` / `Sender` / `Payload` | 同格式 + `Status:` 行；`NEW_TASK` 反向同构 | `core/src/context/inter_agent_completion_message.rs:42` / `tools.ts:130-140` |
| `wait_agent` | 只收 `timeout_ms`，等**任意** agent mailbox 活动，只回摘要 | 只收 `timeout_ms`，等任意 worker 更新，只回摘要 | `core/src/tools/handlers/multi_agents_v2/wait.rs:53` / `tools.ts:235-257` |
| wait 超时 | 默认 30s，min 10s，max 3600s（越界报错/clamp） | 默认 30s，max 600s（clamp，不报错） | `core/src/config/mod.rs:258` / `tools.ts:28-29,253` |
| **并发控制** | 3 套按 **tree 共享**的原子准入：registry 计数、V2 活跃 turn limiter、V2 residency | **每进程独立**：8 活跃 + 12 存活，无全局量 | `core/src/agent/registry.rs:90`、`control/execution.rs:34`、`control/residency.rs:177` / `runtime.ts:101-103,690` |
| 默认并发 | `max_concurrent_threads_per_session(4) - 1` = **3**；**root 不计入** | 8（嵌套后每层各 8） | `core/src/config/mod.rs:256-257,1670` / `runtime.ts:101` |
| 超限行为 | `AgentLimitReached` 直接失败；V2 会先逐出空闲 resident | 直接抛错，无排队 | `protocol/src/error.rs:131` / `runtime.ts:690` |
| 深度限制 | 无深度检查，但子 agent 只有「自己是 root 或自己的模型声明 V2」才拿得到协作工具 | 无深度限制 | `core/src/tools/spec_plan.rs:729-741` / `MULTI_AGENT.md:20` |
| 常驻/驱逐 | residency 常驻 + 空闲逐出 | 已结束进程保留到 12 上限，最旧优先驱逐；`interrupt` = clear_queue→abort→SIGTERM→SIGKILL | `residency.rs:177`、`control/legacy.rs:50,109` / `runtime.ts:475-494,664-680` |
| 上下文继承 | `fork_turns` = `all`（默认）/`none`；`all` 复制 rollout 并**保留 cached prompt prefix** | `context: "inherit"`（默认）/`"isolated"`；inherit 走 Pi `--fork` + **自研过滤**（丢 toolResult/toolCall/thinking、`parentId` 线性化）；失败降级 isolated 或原始 session | `handlers/multi_agents_v2/spawn.rs:215-226`、`handlers/multi_agents_spec.rs:629,667` / `fork.ts:114-200`、`runtime.ts:453-473` |
| 工具暴露 | 默认 `DirectModelOnly`（`non_code_mode_only`）| 普通 `registerTool`，由 `setActiveTools` 控制激活 | `core/src/tools/spec_plan.rs:1471-1475,1562-1567` / `tools.ts:182` |
| 权限/沙箱 | 子继承父 provider/approval policy/sandbox/permission profile/cwd/exec policy；角色**只能降权** | 无沙箱概念：子进程继承 `process.env` + 同 cwd 全权；无角色 | `core/src/agent/child_config.rs:104,178-194` / `runtime.ts:530-538` |
| 模型覆盖 | spawn 可带 `model`/`reasoning_effort`，角色也可改 | spawn 可带 `model`/`thinking`，默认继承父 | `child_config.rs:204,326` / `tools.ts:113-126` |
| 命名角色 | `agent_type` 从 TOML 加载，可改 model/instructions/features | **未实现**（仅 model/thinking） | `core/src/agent/role.rs:33` / `MULTI_AGENT.md`「Not carried over」 |
| 消息板 | channels/posts/subscriptions/search + SQLite | **未实现** | `agent-message-board-client/src/client.rs:59` / 同上 |
| 加密消息 | V2 的 message 标 `encrypted`（`encrypted_content` 块） | 无 | `handlers/multi_agents_spec.rs:656` / — |
| 预算 | `RolloutBudget` **整树共享** token 预算 | 无整树预算 | `core/src/rollout_budget.rs:16` / — |
| 持久化 | `thread_spawn_edges(parent,child,status)`；重启只恢复身份元数据 | 子 session 落 `<parent session>/subagents/<agentId>`；树在内存 + UI 快照重建，**无父子边表** | `state/migrations/0021_thread_spawn_edges.sql`、`control/spawn.rs:200,1351` / `runtime.ts:240,517-521` |
| 可观测 | protocol 层 `InterAgentCommunication`/`SubAgentActivity`/`CollabAgentToolCallItem` 事件；app-server 只透传 | 单一 `AgentSnapshot` v1 wire 契约 → `setStatus("gui-agents")` → Tauri JSONL → Zustand | `protocol/src/items.rs:345,368`、`protocol.rs:4516` / `types.ts:1-46`、`MULTI_AGENT.md` 事件流 |
| 共享 workspace | 共享 cwd，无 worktree 隔离，靠提示词约定 | 同 | `child_config.rs:191` / `runtime.ts:531`、`tools.ts:40-47` |

## 2. 完全一致（契约对齐）的部分

1. **异步委派、spawn 非阻塞**：只回 ack（path/id/nickname），答案永不出现在 tool result 里。
2. **canonical `AgentPath`**：`/root` 为根，子为 `<parent>/<task_name>`；支持 id / 绝对路径 / 相对引用解析；非法名报错而非改写。
3. **两个信封**：`NEW_TASK` 下发、`FINAL_ANSWER` 上报，字段与渲染一致（Orbit 额外带 `Status:`）。
4. **`wait_agent` 只等信号、只回摘要**——这正是「结果不在 tool result 里」这一契约的副作用。
5. **两种投递模式**：`send_message`（steer / 不触发往返）与 `followup_task`（follow-up / 触发新 round）。
6. **共享工作目录**：都写成「给模型的警告」而非运行时锁；Orbit 多加一句「不要静默回滚其他 agent 的改动」。
7. **6 个协作工具的整体开关**：Codex 由 `MultiAgentVersion` 决定，Orbit 由「Pi / Multi Agent」分段控件整体增删。

## 3. 关键差异与影响

| 差异 | 影响 |
|---|---|
| **回传是否唤醒父**（Codex queue-only vs Orbit triggerTurn） | Codex 父必须显式 `wait_agent` 或等下次采样，语义更「邮箱式」；Orbit 父会被完成事件主动打断/唤醒，延迟更低但父的 turn 边界更不可预测（成本与交互都更「事件驱动」） |
| **并发作用域**（tree 共享 vs 每进程） | Codex 全树有硬总额（V2 默认 3），嵌套不会乘性膨胀；Orbit 每层各 8、且无全局量 → 嵌套树活跃数理论上可 8^n 增长，只靠「12 存活驱逐」兜底 |
| **进程内 vs 进程外** | Codex 子 agent 与父共享进程内存，启动几乎零成本、可直接共享 registry/预算/事件总线；Orbit 每 worker 都是完整 Pi 进程 → 强故障隔离、独立上下文窗口、可持久化子会话，但固定启动/内存/工具 schema 成本高，且跨进程只能靠 JSONL RPC |
| **持久化/恢复** | Codex 有 `thread_spawn_edges`，进程重启后可重建 agent 树；Orbit 的树只活在内存 + UI 快照里，进程退出即失去寻址能力（`resolveAgentId` 会提示重新 spawn） |
| **权限边界** | Codex 子继承 approval policy/sandbox 且角色只能降权 → 委派不提权；Orbit 没有沙箱层，子进程与父等同权限 → 委派即等同于在同一 shell 里跑 |
| **继承成本控制** | Codex 保留 cached prompt prefix（复用缓存，便宜）；Orbit 用**过滤掉工具结果**的 fork（省 token，但会打破 prompt prefix 缓存）→ 两条不同的省钱路线：一个省单价，一个省量，不能简单相加 |
| **多 agent 的「组织能力」** | Codex 还有 named roles（换 model/instructions）与 message board（频道/订阅/检索）→ 支持「团队」形态；Orbit 只有扁平的 spawn + 6 工具 → 支持「并行委派」形态 |

## 4. 风险清单（Orbit 侧，按优先级）

1. **无全局并发/深度上限**：8/进程 × 无深度限制 → 成本与进程数可乘性放大（`runtime.ts:101,690`，`MULTI_AGENT.md:20`）。
2. **inherit 默认导致的 token 放大**：并发 N 个 worker 各 fork 一份父历史；过滤失败时退回**未过滤**原始 session（`runtime.ts:465-470`）。
3. **共享文件系统无写串行化**：任何 agent 可同时改同一文件；只有提示词约定（`runtime.ts:531`、`tools.ts:40-47`）。
4. **空闲 worker 的 `send_message` 可能永不投递**：只写 `handle.queued`，需要后续 `followup_task`/新 prompt 才会被前置（`runtime.ts:801-804`）——与 Codex 的 mailbox 语义不同，模型容易误用。
5. **无沙箱/无权限降级**：子进程继承 `process.env` 与全机读写能力。
6. **嵌套快照依赖 `setStatus` 文本通道**：解析失败被静默 `catch`，UI 会缺枝不报错（`runtime.ts:395-403`）。
7. **无 idle 健康检查**：空闲 worker 可能存活到 12 上限才被驱逐（`runtime.ts` 内未见额外回收）。

## 5. 如果要继续对齐 Codex，最小改动清单

| 目标 | 最小改动点 |
|---|---|
| 全局并发上限 | 在 `SubagentRuntime` 之上引入**跨进程**配额（例如父 session 目录下的锁文件/计数，或由父进程代为分配 slot） |
| 树遍历/恢复 | 落一份 `spawn_edges(parent,child,status)` 的 JSONL/SQLite，取代仅内存 `AgentNode` |
| 空闲回收 | 为 settled 且 idle 超过 T 的 worker 加主动 `stopProcess` |
| 结果投递语义开关 | `deliver()` 的 `triggerTurn` 可配（queue-only 模式对齐 Codex），或增加「继续已结束 worker」的入口 |
| 权限降级 | 给 worker 加 sandbox/approval 参数（Pi 侧已有 `--model` 等参数，需扩展 CLI 能力） |
| 角色 | 在 spawn 参数里加 `agent_type` + 一个 TOML 角色表（model/instructions/tool 子集） |
