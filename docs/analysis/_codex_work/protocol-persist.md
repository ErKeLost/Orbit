# Codex 多 Agent：协议 / 事件 / 持久化 / 身份 分析

- 仓库：`/Users/work/pi-gui/vendor/codex`（`codex-rs`），commit `5009a99`（最新 main）。
- 范围：`protocol/src`、`rollout-trace/src`、`agent-graph-store`、`agent-identity`、`agent-roles`、`agent-message-board-client`、`state`、`core/src/agent/**`、`history`/`rollout`、`app-server-protocol`/`app-server`。
- 证据格式为 `路径:行号`（相对仓库根）。无法从代码直接确认的标注「未确认」。

---

## 0. 结论速览

1. **协议层已把多 agent 提升为一等公民**：有专门的路径身份 `AgentPath`（`/root`、`/morpheus`）、会话来源 `SessionSource::SubAgent(SubAgentSource::ThreadSpawn{..})`、生命周期状态 `AgentStatus`、能力开关 `MultiAgentVersion`，以及成套的 agent 事件（`CollabAgent*`、`CollabWaiting*`、`CollabClose*`、`CollabResume*`、`SubAgentActivity`）（`protocol/src/protocol.rs:913`、`:1937`、`:2957`、`:3039`、`:3214`、`:4400-4558`）。
2. **父子拓扑有独立持久化**：SQLite 表 `thread_spawn_edges(parent_thread_id, child_thread_id PK, status)`，由 `agent-graph-store` crate 的 `AgentGraphStore` trait 抽象、`LocalAgentGraphStore` 落到 `state` runtime（`state/migrations/0021_thread_spawn_edges.sql:1`、`agent-graph-store/src/store.rs:22`、`agent-graph-store/src/local.rs:33`、`state/src/runtime/threads.rs:135`）。
3. **恢复有两条路径**：V2 只恢复「身份元数据」不重开 runtime（`core/src/agent/control/spawn.rs:200`）；V1/legacy 用 BFS 沿 open 边递归 resume 子线程（`core/src/agent/control/spawn.rs:1351`）。
4. **三个 crate 各司其职**：`agent-identity` 是**后端鉴权身份**（Ed25519 + JWT），与 `AgentPath` 无关；`agent-roles` 负责**角色定义发现/加载**；`agent-message-board-client` 是 **MAv2 消息板的 HTTP+SSE 客户端**（`agent-identity/src/lib.rs:97`、`agent-roles/src/lib.rs:5`、`agent-message-board-client/src/client.rs:59`）。
5. **内核有独立 agent 调度原语，不只是工具层封装**：存在 `AgentControl` trait（`core/src/agent/api.rs:41`）、`LocalAgentControl`（`core/src/agent/control.rs:97`）、`LocalAgentRuntime`（含 registry / residency / mailboxes / shutdown / execution limiter / rollout budget）（`core/src/agent/control/runtime.rs:184-203`），工具 handler 只是调用 `agent_control.spawn(..)`（`core/src/tools/handlers/multi_agents/spawn.rs:110`）。

---

## 1. 协议层：agent 相关类型与事件

### 1.1 路径身份 `AgentPath`

- 定义：`pub struct AgentPath(String)`（`protocol/src/agent_path.rs:15`），序列化为字符串，`/root` 为常量根、`/morpheus` 为特殊路径（`agent_path.rs:18-24`）。
- 关键操作：`join`（拼子路径）、`resolve`（相对/绝对引用解析）、`name()`（末段名）（`agent_path.rs:54`、`:64`、`:40`）。
- 名字校验：小写字母/数字/下划线，`root`/`.`/`..` 保留（`agent_path.rs:95-125`）；绝对路径必须以 `/root` 开头或是 `/morpheus`（`agent_path.rs:127-146`）。
- 该类型是 V2 的身份主键（工具按「canonical task name」寻址），并出现在 `SubAgentSource::ThreadSpawn.agent_path`（`protocol/src/protocol.rs:3046`）。

### 1.2 `SessionSource` / `SubAgentSource`

- `SessionSource`：`Cli/VSCode/Exec/Mcp/Custom/Internal(InternalSessionSource)/SubAgent(SubAgentSource)/Unknown`（`protocol/src/protocol.rs:2957-2966`）。
- `SubAgentSource`（`protocol/src/protocol.rs:3039-3051`）：
  - `Review`、`Compact`、`MemoryConsolidation`、`Other(String)`；
  - `ThreadSpawn { parent_thread_id: ThreadId, depth: i32, agent_path: Option<AgentPath>, agent_nickname: Option<String>, agent_role: Option<String> }`（`protocol.rs:3042-3051`）。
- 语义：`ThreadSpawn` 即「由父线程 spawn 出来的子 agent」，`parent_thread_id` 是持久化父子关系的**源头字段**。辅助方法 `is_non_root_agent()`、`get_nickname()`、`get_agent_role()`、`get_agent_path()`、`parent_thread_id()` 都从该变体取值（`protocol.rs:3095-3124`、`:3146`、`:3189-3193`）。
- `InternalSessionSource`（记忆整理 / guardian）是另一类内部会话（`protocol.rs:2998-3003`）。

### 1.3 `MultiAgentVersion`（能力开关）

- `enum MultiAgentVersion { Disabled, V1, V2 }`（`protocol/src/protocol.rs:3214-3219`）。
- 决定使用哪套 agent 工具面与运行语义：V1 = `Feature::Collab` 传统 collab 工具；V2 = 路径式子 agent + 消息板 + 常驻 runtime（`core/src/config/mod.rs:1651-1659`）。
- 解析来源：config override > 模型元数据 > feature（`core/src/config/mod.rs:1663`）；spawn/resume 时用 `effective_multi_agent_version_for_spawn`，优先看被复用父线程的版本，其次看历史（`core/src/thread_manager.rs:1838`、`core/src/session/mod.rs:537-557`）。

### 1.4 `AgentStatus`（生命周期状态）

`enum AgentStatus`（`protocol/src/protocol.rs:1937-1956`）：

| 变体 | 含义 | 行 |
|---|---|---|
| `PendingInit`（默认） | 等待初始化 | `protocol.rs:1942` |
| `Running` | 正在运行 | `protocol.rs:1944` |
| `Interrupted` | 当前 turn 被打断，仍可再收输入 | `protocol.rs:1946` |
| `Completed(Option<String>)` | 完成，携带最终 assistant 消息 | `protocol.rs:1948` |
| `Errored(String)` | 出错 | `protocol.rs:1950` |
| `Shutdown` | 已关闭 | `protocol.rs:1952` |
| `NotFound` | 未知/不存在 | `protocol.rs:1954` |

- 状态**由事件派生**：`agent_status_from_event` 把 `TurnStarted→Running`、`TurnComplete→Completed/Errored`、`TurnAborted→Interrupted`、`Error→Errored`、`ShutdownComplete→Shutdown`（`core/src/agent/status.rs:6-22`）。
- 终态判定 `is_final`（`core/src/agent/status.rs:27`）。

### 1.5 `InterAgentCommunication`（agent 间消息）

- 结构（`protocol/src/protocol.rs:913-927`）：`id: Option<ResponseItemId>`、`author: AgentPath`、`recipient: AgentPath`、`other_recipients: Vec<AgentPath>`、`content: String`、`encrypted_content: Option<String>`、`trigger_turn: bool`。
- 构造器 `new` / `new_encrypted`（`protocol.rs:931`、`:952`）；`trigger_turn=false` 表示只入邮箱不启动 turn。
- 它同时是内核提交原语：`Op::InterAgentCommunication { communication, start_options }`，注释说明「记录为 agent-message 历史，但走普通 thread 提交流程」（`protocol.rs:752-756`）。
- 消息被物化为模型可见的 `ResponseItem::AgentMessage` 后落 rollout（`core/src/session/mod.rs:4048-4124`）。

### 1.6 TurnItem 与 EventMsg 中的 agent 变体

`TurnItem`（`protocol/src/items.rs`）：
- `TurnItem::CollabAgentToolCall(CollabAgentToolCallItem)`（`items.rs:57`）、`TurnItem::SubAgentActivity(SubAgentActivityItem)`（`items.rs:58`）。

工具调用枚举 `CollabAgentTool`（`items.rs:323-333`）：`SpawnAgent, SendInput, ResumeAgent, Wait, CloseAgent, SendMessage, FollowupTask, InterruptAgent, ListAgents`（前 5 个是 V1，后 4 个是 V2）。
调用状态 `CollabAgentToolCallStatus { InProgress, Completed, Failed, Interrupted }`（`items.rs:337-342`）。
`CollabAgentToolCallItem`（`items.rs:345-363`）：`id、tool、status、sender_thread_id、receiver_thread_ids、receiver_agents: Vec<CollabAgentRef>、prompt、model、reasoning_effort、agents_states: HashMap<ThreadId, AgentStatus>`。
`SubAgentActivityItem`（`items.rs:368-377`）：`model、reasoning_effort、id、kind、agent_thread_id、agent_path`。

`EventMsg` 中的 agent 变体（`protocol/src/protocol.rs`）：
- `CollabAgentSpawnBegin/End`（`:1667-1669`）、`CollabAgentInteractionBegin/End`（`:1671-1673`）、`CollabWaitingBegin/End`（`:1675-1677`）、`CollabCloseBegin/End`、`CollabResumeBegin/End`、`SubAgentActivity`（`:1688`）。
- 对应结构体：`CollabAgentSpawnBeginEvent`（`protocol.rs:4400`）、`CollabAgentRef`（`:4415`）、`CollabAgentStatusEntry`（`:4427`）、`CollabAgentSpawnEndEvent`（`:4441`）、`CollabAgentInteractionBegin/EndEvent`（`:4468`/`:4483`）、`SubAgentActivityKind {Started,Interacted,Interrupted,Completed}`（`:4508`）、`SubAgentActivityEvent`（`:4516`）、`CollabWaitingBegin/EndEvent`（`:4532`/`:4547`）、`CollabClose*`（约 `:4560`）、`CollabResume*`（约 `:4591`/`:4630`）。
- `TurnComplete` 本身不带 agent 语义，但对子 agent 而言它是 `AgentStatus::Completed` 的来源（`core/src/agent/status.rs:8`）；`ItemStarted/ItemCompleted` 被复用为 `SubAgentActivity` 的传输外壳（见 §4）。

### 1.7 app-server 对外协议

- 对外 **Rust/TS 类型**：`ThreadItem::CollabAgentToolCall`（`app-server-protocol/src/protocol/v2/item.rs:376-396`）、`ThreadItem::SubAgentActivity`（`item.rs:399-407`）、`CollabAgentTool`（`:1136`）、`CollabAgentToolCallStatus`（`:1234` 附近）、`SubAgentActivityKind`（`:1271`）、`CollabAgentStatus`/`CollabAgentState`（`:1292`/`:1305`）。
- **事件映射**：`EventMsg::CollabAgentSpawn*`→ `item/started`/`item/completed`，`CollabAgentInteraction*`→`CollabAgentTool::SendInput`，`SubAgentActivity`→`ItemCompleted`，以及 `CollabWaiting*`/`CollabClose*`/`CollabResume*`（`app-server-protocol/src/protocol/event_mapping.rs:78-363`）。
- **没有独立 agent RPC**：客户端方法清单（`app-server-protocol/src/protocol/common.rs:499-1528`）与服务端通知清单（`common.rs:1948-2097`）中都不存在 `agent/spawn` 之类方法；agent 调度只作为工具/`ThreadItem` 事件透传。配置层仅有 `multi_agent_mode` / `multi_agent_version` 字段（`protocol/v2/turn.rs:296`、`protocol/v2/model.rs:31`）。扩展侧 `install_agent_message_board`（`app-server/src/extensions.rs:82`）是消息板安装，不是 JSON-RPC 方法。
- MCP：`codex-mcp` 是 MCP **客户端**，未发现把 `spawn_agent` 暴露为 MCP 工具（「是否存在其他 MCP 暴露路径」**未确认**）。

---

## 2. 父子关系的持久化与恢复

### 2.1 存储模型

- 独立 crate `agent-graph-store` 提供「storage-neutral 的父子拓扑」抽象，crate 文档即写明（`agent-graph-store/src/lib.rs:1`）。
- 边状态 `enum ThreadSpawnEdgeStatus { Open, Closed }`（`agent-graph-store/src/types.rs:7-12`）。`Open` = 子线程仍存活/可恢复；`Closed` = 从图视角已关闭。
- `trait AgentGraphStore`（`agent-graph-store/src/store.rs:19`）：
  - `upsert_thread_spawn_edge(parent, child, status)`：一个 child 最多一个 parent，重复 upsert 覆盖 parent+status（`store.rs:22-31`）；
  - `set_thread_spawn_edge_status(child, status)`（`store.rs:33`）；
  - `list_thread_spawn_children(parent, status_filter)`（`store.rs:43`）；
  - `list_thread_spawn_descendants(root, status_filter)`：按深度 BFS、同层按 thread id 排序（`store.rs:55-63`）。
- 落库实现 `LocalAgentGraphStore`（`agent-graph-store/src/local.rs:19`）转调 `codex_state::StateRuntime`（`local.rs:33-110`）。
- SQL 表：`thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)` + 索引 `idx_thread_spawn_edges_parent_status`（`state/migrations/0021_thread_spawn_edges.sql:1-9`）。
  - **注意**：`child_thread_id` 是主键，天然保证「每个子线程只有一个父」。
- SQL 实现：`upsert_thread_spawn_edge` 用 `ON CONFLICT(child_thread_id) DO UPDATE`（`state/src/runtime/threads.rs:135-159`）；`set_thread_spawn_edge_status`（`:162`）；`list_thread_spawn_children*`（`:176-215`）；`list_thread_spawn_descendants*` 用 `WITH RECURSIVE` 按 depth 排序（`:276-340`）；另提供 `find_thread_spawn_child_by_path` / `find_thread_spawn_descendant_by_path`（`:218-273`）。

### 2.2 写入路径（何时建边）

1. **显式写入**：`LocalAgentControl::persist_thread_spawn_edge_for_source`，仅当 `session_source.parent_thread_id()` 存在且子线程非 ephemeral 时，以 `Open` upsert（`core/src/agent/control.rs:686-711`）——spawn 和 resume 都会调用（`core/src/agent/control/spawn.rs:1523`）。
2. **隐式回填**：线程元数据落库时，从 `SessionMeta.source` 解析 `parent_thread_id` 并 `INSERT ... ON CONFLICT DO NOTHING`（status=Open）：`insert_thread_spawn_edge_from_source_if_absent`（`state/src/runtime/threads.rs:349-379`），被 `insert_thread`（`:723`）和 update 路径（`:1059`）调用；解析函数 `thread_spawn_parent_thread_id_from_source_str`（`:1389-1395`）。
3. **关闭**：`set_thread_spawn_edge_status(child, Closed)`；删除线程时一并删除其作为 parent 或 child 的边（`state/src/runtime/threads.rs:1194-1196`）。

### 2.3 恢复路径

- **V2（不重开 runtime，只恢复身份）**：`restore_v2_agent_metadata(config, root_thread_id)` 拉取 root 下所有 `Open` 边后代（`list_thread_spawn_descendants`），并发读取 `read_stored_thread` 后按图顺序 reserve agent_path/nickname（`core/src/agent/control/spawn.rs:200-215`、`:215-260`）。
- **V1/legacy（递归重开线程）**：`resume_agent_from_rollout`（`core/src/agent/control/spawn.rs:1351`）：
  - 先 `resume_single_agent_from_rollout` 恢复目标线程（`:1427`）；
  - 若整体为 V2 则直接返回，不做后代重开（`:1362-1366`）；
  - 否则以 `VecDeque` BFS，沿 `list_thread_spawn_children(parent, Some(Open))` 逐层恢复子线程，成功者入队继续（`:1369-1420`）。
- 单线程恢复细节：从 `read_stored_thread` 读回 `agent_path / agent_nickname / agent_role / parent_thread_id`，重建 `SessionSource::SubAgent(ThreadSpawn{..})`，从 rollout 载入历史后 `resume_thread_with_history_with_source`（`core/src/agent/control/spawn.rs:1427-1521`）。
- 入口：`resume_agent(config, thread_id, source)` 先尝试内存内线程，缺失则回落 `resume_agent_from_rollout`（`core/src/agent/control/resume.rs:13-35`）。
- 恢复时重新挂 completion watcher（非 V2），使子 agent 完成后仍能通知父线程（`core/src/agent/control/spawn.rs:1512-1521`）。

### 2.4 rollout 层的 agent 冗余字段与消息

- `SessionMeta` 冗余保存 agent 身份，便于仅凭 rollout 恢复：`parent_thread_id`、`source: SessionSource`、`thread_source`、`agent_nickname`、`agent_role`、`agent_path`、`multi_agent_version`、`subagent_history_start_ordinal`（`protocol/src/protocol.rs:3271-3331`）。
- rollout 写入时从 `SessionSource` 回填这些字段：`agent_nickname: source.get_nickname()`、`agent_role: source.get_agent_role()`、`agent_path: source.get_agent_path()`、`multi_agent_version`（`rollout/src/recorder.rs:955-981`）。
- SQLite 侧再次从 SessionMeta 抽取：`builder.agent_path/agent_nickname/agent_role`（`rollout/src/metadata.rs:58-60`）。
- 消息持久化：`RolloutItem::InterAgentCommunication` / `InterAgentCommunicationMetadata`（`history/src/lib.rs:215-221`），wire tag（`history/src/rollout_payload.rs:41-49`）；但当前 `record_inter_agent_communication` 实际落的是 `InterAgentCommunicationMetadata + ResponseItem(AgentMessage)`（`core/src/session/mod.rs:4120-4124`）。恢复时 `InterAgentCommunication` 会被 `to_model_input_item()` 重放为模型输入（`core/src/session/rollout_reconstruction.rs:516-519`）。
- 子 agent 的 rollout 采用分页/history_base + `subagent_history_start_ordinal` 机制，子记录从 ordinal 起点开始（`rollout/src/ordinal.rs:59-93`）。

---

## 3. `agent-identity` / `agent-roles` / `agent-message-board-client` 职责

### 3.1 `agent-identity` — 后端鉴权身份（与 AgentPath 无关）

- 职责：让 Codex 作为「被认证 agent」向后端注册并签名，产出鉴权头/校验 JWT。
- 核心类型：`AgentIdentityKey`（agent_runtime_id + PKCS#8 私钥，`agent-identity/src/lib.rs:97`）、`AgentBillOfMaterials`（`:103`）、`AgentIdentityJwtClaims`（`:116`）。
- 生成/注册：`generate_agent_key_material`（OsRng+Sha512 派生 Ed25519，`:425`）、`register_agent_identity`（`/v1/agent/register`，`:358`）、`register_agent_task`（`:315`）、`authorization_header_for_agent_task`（`AgentAssertion` 头，`:232`）、`decode_agent_identity_jwt`（JWKS 校验，`:266`）。
- **无自有持久化**：私钥落到 login/auth storage（`login/src/auth/storage.rs:104` 附近）；仅用于 model-provider 鉴权（`model-provider/src/auth.rs:5,90`）。
- 结论：这是**加密/鉴权身份子系统**，与协议层 `AgentPath` 的「任务路径身份」互不引用。

### 3.2 `agent-roles` — 角色定义发现与加载

- 导出：`AgentRoleConfig`、`ResolvedAgentRoleFile`、`parse_agent_role_file_contents`、`load_agent_roles`（`agent-roles/src/lib.rs:5-8`）。
- 角色字段：`description`、`config_file`、`nickname_candidates`（`agent-roles/src/agent_role_config.rs:10-17`）；`nickname_candidates` 校验（`:175` 起）。
- 来源：配置 `agents.roles` + `<config_folder>/agents/**/*.toml` 递归扫描（`agent-roles/src/discovery.rs:15-26`）、逐层合并与缺失告警（`agent-roles/src/loader.rs:29,82,148`）。
- **本 crate 无内置角色**；内置 `default` 等在 core（`core/src/agent/role.rs:33,342`）。
- 与 nickname 绑定：spawn 时用 `AgentRoleConfig.nickname_candidates` 作为候选名（`core/src/agent/control/spawn.rs:75-88`）。

### 3.3 `agent-message-board-client` — MAv2 消息板 HTTP/SSE 客户端

- 职责：某 session 的消息板客户端。协议为 **HTTP（读写 `POST /call`）+ SSE（`/notifications` 实时预览）**（`agent-message-board-client/src/client.rs:59,137,215`）。
- `RemoteAgentMessageBoard` 以 `SessionId` 为 board、`ThreadId` 为 caller，`register_members` 维护 `ThreadId→AgentPath` 映射（`client.rs:129`、`protocol.rs:57`）。
- 关键消息：`BoardNotification { recipient: ThreadId, turn_id, post }`（`protocol.rs:90`）、`Operation` 枚举（`protocol.rs:66`）、`AccessToken`（`protocol.rs:27`）。
- 归属：属于 **MAv2 内核调度**的一部分——core 侧 `install_agent_message_board` 桥接 active turn（`app-server/src/extensions.rs:82`；core 内 `agent_message_board.rs` 注册/桥接）。「远程板是否默认启用」**未确认**。

---

## 4. 事件流与可观测性

### 4.1 归约到对外事件的路径

- 工具 handler 在调用前后发出 `TurnItem::CollabAgentToolCall` 的 `ItemStarted`/`ItemCompleted`。例：spawn 时先发 `SpawnAgent/InProgress`（`core/src/tools/handlers/multi_agents/spawn.rs:82-96`），完成后发终态 item（`:172-190`）。
- `CollabAgentToolCallItem::as_legacy_begin_event` / `as_legacy_end_event` 把该 item 映射为 legacy `EventMsg::CollabAgent*` / `CollabWaiting*` / `CollabClose*` / `CollabResume*`（`protocol/src/legacy_events.rs:271-405`）。V2 的 `SendMessage/FollowupTask/InterruptAgent/ListAgents` **故意不发** legacy 事件（`:275-279`、`:335-338`）。
- `SubAgentActivity`：`LocalAgentControl::emit_sub_agent_activity` 同时发送 `ItemStarted` + `ItemCompleted` + legacy `EventMsg::SubAgentActivity`（`core/src/agent/control.rs:186-232`）；`SubAgentActivityItem::as_legacy_event` 填充 model/effort/event_id/agent_thread_id/agent_path/kind（`protocol/src/legacy_events.rs:436-448`）。

### 4.2 归约到 rollout-trace 模型

- 工具开始/结束归约入口：`start_agent_interaction_from_runtime`（`rollout-trace/src/reducer/tool/agents.rs:72`）与 `end_agent_interaction_from_runtime`（`:129`）。
  - 开始：`AssignAgentTask/SendMessage → queue_message_agent_interaction`，`CloseAgent → upsert_close_agent_interaction`（`:85-124`）。
  - 结束：payload 含 `agent_thread_id` 则按 `SubAgentActivityEvent` 走 `end_sub_agent_activity`，否则按工具类型映射 `CollabAgentSpawnEnd` / `CollabAgentInteractionEnd` / `CollabCloseEnd`（`:137-174`）。
- 状态机 `end_sub_agent_activity`（`agents.rs:186-241`）按 `(tool_kind, activity.kind)` 二维匹配：`(SpawnAgent,Started)`→spawn 边、`(AssignAgentTask|SendMessage,Interacted)`→交互边、`(CloseAgent,Interrupted)`→关闭边、`(_,Completed)`→no-op，不匹配则报错。
- 边类型 `InteractionEdgeKind { SpawnAgent, AssignAgentTask, SendMessage, AgentResult, CloseAgent }`（`rollout-trace/src/model/runtime.rs:319-327`）；稳定 spawn 边 ID `edge:spawn:{parent}:{child}`（`agents.rs:66-68`）。
- 投递先于接收方 transcript 的竞态用 `PendingAgentInteractionEdge` 挂起，`resolve_pending_agent_edges_for_item` / `resolve_pending_spawn_edge_fallbacks` 解析兜底（`agents.rs:31-48`、`:517`、`:544`、`:594`）。
- 子 agent 完成回流父通知：`queue_agent_result_interaction_edge`（`agents.rs:476`）。
- `protocol_event.rs`：`tool_runtime_trace_event` 把 `CollabAgent*Begin/End` 映射为 trace `Started/Ended`（`rollout-trace/src/protocol_event.rs:268-354`）；`SubAgentActivity` 的 `Completed` 被忽略（`:347-354`）。Collab*/SubAgentActivity 不作为独立 trace 事件（`wrapped_protocol_event_type` 返回 `None`，`:504-514`）。
- `reducer/thread.rs`：`start_thread` 从 `session_source.subagent.thread_spawn` 派生 `AgentOrigin::Spawned`/`Root`（`rollout-trace/src/reducer/thread.rs:34-95`）。
- **未确认**：`CollabResumeBegin/End` 未进入 `ToolRuntimePayload`（`protocol_event.rs:424-425,512-513`），trace 可能不捕获 resume。

### 4.3 app-server 可观测性

- 上述事件被折叠/透传为 `ThreadItem::CollabAgentToolCall` 与 `ThreadItem::SubAgentActivity`（`app-server-protocol/src/protocol/event_mapping.rs:78-363`；历史归约 `protocol/thread_history.rs:393-403,936-1176`），经通用 `item/started`、`item/completed` 通知客户端。

---

## 5. 工具层封装 vs 内核独立调度原语

**结论：内核存在独立的 agent 调度原语，工具层只是其中一层适配。**

证据链：

1. **独立 trait 与契约**：`pub trait AgentControl` 定义 `resolve/spawn/send/take_mailbox/watch_mailbox/ensure_child_loaded/interrupt/list/child_agent_paths/check_turn_admission/admit_turn/record_usage/turn_finished/...`（`core/src/agent/api.rs:41-165`），并注释「这些 Rust 契约不定义 wire protocol」（`api.rs:1-5`）。
2. **独立运行时状态**：`LocalAgentControl`（`core/src/agent/control.rs:97`）持有 `LocalAgentRuntime`（`core/src/agent/control/runtime.rs:184`），后者含 `registry`（身份/path/nickname 预留）、`residency`（V2 常驻）、`mailboxes`（离线投递）、`agent_execution_limiter`（并发）、`rollout_budget`、`shutdown`（整棵 agent tree 生命周期）（`runtime.rs:191-203`）。
3. **独立生命周期与调度语义**：
   - 邮箱旁路：未加载接收者可直接 `mailboxes.enqueue` 且不启 turn（`core/src/agent/control.rs:270-292`）。
   - 完成通知：`maybe_start_completion_watcher` 订阅子线程状态，终态时对 V2 发 `InterAgentCommunication`、对 V1 注入 `SubagentNotification` fragment（`core/src/agent/control.rs:457-580`）。
   - 树级 shutdown / teardown guard 与失败上报（`runtime.rs:31-160`）。
4. **工具层是薄适配**：`spawn_agent` handler 仅组装 `SpawnRequest` 并调用 `session.services.agent_control.spawn(..)`，再把结果包成 `CollabAgentToolCallItem`（`core/src/tools/handlers/multi_agents/spawn.rs:110-190`）。工具规范名 `spawn_agent/send_input/send_message/followup_task/resume_agent/list_agents/...`（`core/src/tools/handlers/multi_agents_spec.rs:92,193,222,255,275,325`）。
5. **持久化是内核关注点**：spawn edge 由 core 主动 upsert（`core/src/agent/control.rs:686`），恢复由 core 驱动（`core/src/agent/control/spawn.rs:1351`），并非工具层行为。
6. **外部协议只暴露事件/配置，不暴露调度 RPC**（见 §1.7），进一步说明调度原语属于内核内部抽象。

因此：多 agent 在 Codex 中是**内核级子系统**（协议类型 + 图存储 + 运行时 + 恢复 + 观测），工具层（`spawn_agent` 等）与 app-server 事件只是其对外呈现。

---

## 6. 关键证据文件:行号速查（Top）

| 主题 | 证据 |
|---|---|
| Agent 状态 | `codex-rs/protocol/src/protocol.rs:1937` |
| ThreadSpawn 来源 | `codex-rs/protocol/src/protocol.rs:3042` |
| MultiAgentVersion | `codex-rs/protocol/src/protocol.rs:3214` |
| AgentPath | `codex-rs/protocol/src/agent_path.rs:15` |
| Agent 工具调用 item | `codex-rs/protocol/src/items.rs:345` |
| SubAgentActivity | `codex-rs/protocol/src/protocol.rs:4516` |
| 图存储 trait | `codex-rs/agent-graph-store/src/store.rs:22` |
| 边状态 | `codex-rs/agent-graph-store/src/types.rs:7` |
| SQL 表 | `codex-rs/state/migrations/0021_thread_spawn_edges.sql:1` |
| 边 upsert SQL | `codex-rs/state/src/runtime/threads.rs:135` |
| 边隐式回填 | `codex-rs/state/src/runtime/threads.rs:372` |
| 显式写边 | `codex-rs/core/src/agent/control.rs:686` |
| V2 身份恢复 | `codex-rs/core/src/agent/control/spawn.rs:200` |
| V1 BFS 恢复 | `codex-rs/core/src/agent/control/spawn.rs:1351` |
| AgentControl trait | `codex-rs/core/src/agent/api.rs:41` |
| 本地运行时 | `codex-rs/core/src/agent/control/runtime.rs:184` |
| app-server agent item | `codex-rs/app-server-protocol/src/protocol/v2/item.rs:376` |
| trace agent 归约 | `codex-rs/rollout-trace/src/reducer/tool/agents.rs:72` |
| 身份 crate | `codex-rs/agent-identity/src/lib.rs:97` |
| 角色 crate | `codex-rs/agent-roles/src/lib.rs:5` |
| 消息板客户端 | `codex-rs/agent-message-board-client/src/client.rs:59` |

## 7. 未确认 / 待验证

- app-server 之外的 MCP 路径是否暴露 agent 工具（本次 grep 未命中，**未确认**）。
- `CollabResumeBegin/End` 在 rollout-trace 中未被 `ToolRuntimePayload` 覆盖（`protocol_event.rs:424-425,512-513`），resume 的 trace 完整性**未确认**。
- 远程 `agent-message-board` 是否在所有部署默认启用（**未确认**）。
- `rollout-trace/src/reducer/thread.rs` 是否直接消费 `SubAgentActivity`（该文件只维护 thread/turn 与 item id 集合，**未确认** item 层归约的确切归属文件）。
