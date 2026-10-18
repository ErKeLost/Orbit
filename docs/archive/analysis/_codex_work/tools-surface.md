# Codex 多 Agent「工具层」分析

> 仓库：`/Users/work/pi-gui/vendor/codex`（main，commit `5009a99`）
> 以下路径均相对于 `codex-rs/`；每条结论后附 `路径:行号` 证据。

---

## 0. 结论速览

- 代码里同时存在 **两套多 agent 工具集**，由 `enum MultiAgentVersion { Disabled, V1, V2 }` 三态切换：
  - **V1 = MultiAgentV1**：`spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent`，固定命名空间 `multi_agent_v1`。
  - **V2 = MultiAgentV2**：`spawn_agent` / `send_message` / `followup_task` / `wait_agent` / `interrupt_agent` / `list_agents`，默认命名空间 `collaboration`（可配置，也可为无命名空间）。
- 两套共享 `spawn_agent`、`wait_agent` 名字，但 **schema、参数、返回结构完全不同**，由 `turn_context.multi_agent_version` 决定注册哪一套。
- V1/V2 都受 feature flag 控制：`multi_agent`（`Feature::Collab`，stable，默认开）→ V1；`multi_agent_v2`（`Feature::MultiAgentV2`，stable，默认关）→ V2。
- `message` 参数只有 **V2 的 `spawn_agent` / `send_message` / `followup_task`** 带 `encrypted: true` 标注（V1 的 `spawn_agent`/`send_input` 不加密）。
- V2 支持通过 catalog 覆盖工具 **描述与参数 schema**（`multi_agent_tool.rs`），并会自动保留 harness 的 `encrypted` 标注。
- 并行调用：仅 V2 `list_agents` 覆盖 `supports_parallel_tool_calls → true`，其余全部默认 `false`。

---

## 1. 工具清单（名称 / 版本 / 入参 / 语义 / 结果）

### 1.1 V1 工具集（命名空间 `multi_agent_v1`）

命名空间常量：`core/src/tools/handlers/multi_agents_spec.rs:14`
命名空间描述：`core/src/tools/handlers/multi_agents_spec.rs:15`
所有 V1 handler 都用 `ToolName::namespaced(MULTI_AGENT_V1_NAMESPACE, ...)`。

| 工具 | 版本 | tool_name 证据 | 入参 | 语义 | 结果结构 |
|---|---|---|---|---|---|
| `spawn_agent` | V1 | `core/src/tools/handlers/multi_agents/spawn.rs:30-31` | `message?`、`items?`、`agent_type?`、`fork_context?`(bool)、`model?`、`reasoning_effort?`（`multi_agents_spec.rs:610-646`） | 启动子 agent；`message`/`items` 二选一 | `SpawnAgentResult { agent_id, nickname }`（`spawn.rs:230-234`，schema `multi_agents_spec.rs:415-431`） |
| `send_input` | V1 | `core/src/tools/handlers/multi_agents/send_input.rs:12-13` | `target`(必填)、`message?`、`items?`、`interrupt?`(bool)（`multi_agents_spec.rs:166-201`） | 给已有 agent 发消息；`interrupt=true` 立即打断并转向 | `SendInputResult { submission_id }`（`send_input.rs:155-158`，schema `multi_agents_spec.rs:465-477`） |
| `resume_agent` | V1 | `core/src/tools/handlers/multi_agents/resume_agent.rs:10-11` | `id`（`multi_agents_spec.rs:265-284`） | 恢复已关闭 agent，使其能再收 `send_input`/`wait_agent` | `ResumeAgentResult { status }`（`resume_agent.rs:150-153`，schema `multi_agents_spec.rs:508-517`） |
| `wait_agent` | V1 | `core/src/tools/handlers/multi_agents/wait.rs:32-33` | `targets`(必填数组)、`timeout_ms?`（`multi_agents_spec.rs:889-914`） | 等待一组 agent 到达 final 状态（返回**首个**完成者），超时返回空 | `WaitAgentResult { status: map<agent_id, AgentStatus>, timed_out }`（`wait.rs:298-303`，schema `multi_agents_spec.rs:519-536`） |
| `close_agent` | V1 | `core/src/tools/handlers/multi_agents/close_agent.rs:8-9` | `target`（`multi_agents_spec.rs:336-359`） | 关闭 agent 及其后代，返回关闭前状态 | `CloseAgentResult { previous_status }`（`close_agent.rs:111-114`） |

V1 统一入口/公共逻辑：`core/src/tools/handlers/multi_agents.rs:1-11`、入参解析辅助 `multi_agents_common.rs:172-198`。

### 1.2 V2 工具集（默认命名空间 `collaboration`）

默认命名空间：`core/src/config/mod.rs:261`（`DEFAULT_MULTI_AGENT_V2_TOOL_NAMESPACE = "collaboration"`）、`core/src/config/mod.rs:1408`。
默认命名空间描述：`core/src/tools/multi_agent_tool.rs:20`。
V2 handler 本体用 `ToolName::plain(...)`，命名空间由 `multi_agent_v2_handler` 包装时追加（`core/src/tools/multi_agent_tool.rs:52-54, 90-98`）。

| 工具 | 版本 | tool_name 证据 | 入参 | 语义 | 结果结构 |
|---|---|---|---|---|---|
| `spawn_agent` | V2 | `core/src/tools/handlers/multi_agents_v2/spawn.rs:36-37` | `message`(必填,**encrypted**)、`task_name`(必填)、`agent_type?`、`fork_turns?`(string)、`model?`、`reasoning_effort?`（`multi_agents_spec.rs:649-684`、必填 `:151-155`） | 启动子 agent，产生 canonical task name（`/root/task1/task_3`） | `SpawnAgentResult` 枚举：`WithNickname{task_name,nickname}` / `HiddenMetadata{task_name}`（`v2/spawn.rs:244-256`，schema `multi_agents_spec.rs:433-463`） |
| `send_message` | V2 | `core/src/tools/handlers/multi_agents_v2/send_message.rs:12-13` | `target`、`message`(**encrypted**)（`multi_agents_spec.rs:204-234`） | 给 agent 投递消息，**不触发新一轮**（`MessageDeliveryMode::QueueOnly`，`send_message.rs:47`） | 无 output_schema（`multi_agents_spec.rs:229`），运行时返回空 `FunctionToolOutput`（`message_tool.rs:97`） |
| `followup_task` | V2 | `core/src/tools/handlers/multi_agents_v2/followup_task.rs:12-13` | `target`、`message`(**encrypted**)（`multi_agents_spec.rs:236-263`） | 给非 root agent 派跟进任务；idle 时触发一轮（`MessageDeliveryMode::TriggerTurn`，`followup_task.rs:47`） | 无 output_schema（`multi_agents_spec.rs:261`），运行时返回空 |
| `wait_agent` | V2 | `core/src/tools/handlers/multi_agents_v2/wait.rs:23-24` | `timeout_ms?`（仅此一个参数，`multi_agents_spec.rs:917-936`） | 等待任意 agent 的 mailbox 更新、或用户 steer 输入、或超时；不返回内容只返回摘要 | `WaitAgentResult { message, timed_out }`（`v2/wait.rs:146-151`，schema `multi_agents_spec.rs:538-554`） |
| `interrupt_agent` | V2 | `core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs:11-12` | `target`（`multi_agents_spec.rs:361-382`） | 打断该 agent 当前轮，返回打断前状态；agent 仍可继续收消息 | `InterruptAgentResult { previous_status }`（`interrupt_agent.rs:91-94`） |
| `list_agents` | V2 | `core/src/tools/handlers/multi_agents_v2/list_agents.rs:9-10` | `path_prefix?`（`multi_agents_spec.rs:315-334`） | 列出当前 root 线程树下的 live agent，可按 task-path 前缀过滤 | `ListAgentsResult { agents: [ListedAgent{agent_name, agent_status}] }`（`list_agents.rs:88-96`，schema `multi_agents_spec.rs:479-506`） |

V2 统一入口：`core/src/tools/handlers/multi_agents_v2.rs:43-56`；公共消息处理：`core/src/tools/handlers/multi_agents_v2/message_tool.rs:39-99`。

### 1.3 AgentStatus（结果里复用的状态 schema）

`pending_init | running | interrupted | shutdown | not_found`，或 `{ completed: string|null }`，或 `{ errored: string }`：
`core/src/tools/handlers/multi_agents_spec.rs:384-414`。

---

## 2. V1 与 V2 的差别

### 2.1 工具名/集合差异

- 仅 V1：`send_input`、`resume_agent`、`close_agent`（`spec_plan.rs:1561-1565`）。
- 仅 V2：`send_message`、`followup_task`、`interrupt_agent`、`list_agents`（`spec_plan.rs:1488-1535`）。
- 两者同名：`spawn_agent`、`wait_agent`。
- 子管理工具集合的判定：`required_child_management_tool_names` `core/src/tools/spec_plan.rs:743-780`（V1 名单 `:754-757`，V2 名单 `:757-772`）。

### 2.2 命名空间

- V1：固定 `multi_agent_v1`，handler 直接 `ToolName::namespaced`（`multi_agents_spec.rs:14`；例 `spawn.rs:31`）。
- V2：handler 为 `ToolName::plain`（例 `v2/spawn.rs:37`），包装层按 `multi_agent_v2.tool_namespace` 追加；`None` 时不加命名空间（`multi_agent_tool.rs:52-54, 90-98`）。
- 默认值 `Some("collaboration")`（`core/src/config/mod.rs:1408`）。
- 测试佐证：V2 命名空间常量 `collaboration`（`core/tests/suite/spawn_agent_description.rs:42`），V1 常量 `multi_agent_v1`（`:41`）。

### 2.3 上下文 fork 语义

- V1：**布尔** `fork_context`（`multi_agents_spec.rs:628-633`），为 `true` 时映射 `SpawnAgentForkMode::FullHistory`，否则不 fork（`core/src/tools/handlers/multi_agents/spawn.rs:103, 112`）。
- V2：**字符串** `fork_turns`（`multi_agents_spec.rs:659-664`），语义 `all`（默认）/`none`；显式传 `fork_context` 会被拒绝（`core/src/tools/handlers/multi_agents_v2/spawn.rs:215-218`），`none → None`，`all`/旧式数字计数 → `FullHistory`（`v2/spawn.rs:226-234`）。
- 描述层面：V2 明确说明 `fork_turns="none"` 不传上下文、`all` 传全部（`multi_agents_spec.rs:808`）。
- 共享的 fork 模式类型 `SpawnAgentForkMode` 定义在 `core/src/agent/types.rs`（引用自 `multi_agents_common.rs:1`）。

### 2.4 `supports_parallel_tool_calls`

- 默认实现返回 `false`：`tools/src/tool_executor.rs:122-124`。
- 在全部 agent 工具里，**只有 V2 `list_agents` 覆盖为 `true`**：`core/src/tools/handlers/multi_agents_v2/list_agents.rs:13-15`。
- 包装层透传：`core/src/tools/multi_agent_tool.rs:103-105`；registry 暴露：`core/src/tools/registry.rs:606-609`。
- 因此 V1 全部工具、以及 V2 的 `spawn_agent`/`send_message`/`followup_task`/`wait_agent`/`interrupt_agent` 都是 `false`（未覆盖即默认）。

### 2.5 其它差异

- spawn 输入：V1 支持 `items`（结构化多模态/mention，schema `multi_agents_spec.rs:570-608`）；V2 `spawn_agent` 只有纯文本 `message` + `task_name`（`multi_agents_spec.rs:649-684`）。
- spawn 返回：V1 `agent_id`+`nickname`；V2 `task_name`(+可选 `nickname`，`hide_spawn_agent_metadata` 可隐藏，`multi_agents_spec.rs:433-463`）。
- wait 返回：V1 返回 `status` map（含最终消息可能）；V2 只返回 `message` 摘要 + `timed_out`，不返回内容（`multi_agents_spec.rs:281-301, 519-554`）。
- 日志/事件：V1 通过 `CollabAgentToolCallItem` 发 turn item（例 `spawn.rs:79-99`）；V2 额外走 analytics（`multi_agents_v2/analytics.rs:1-62`）与 `SubAgentActivityItem`（`multi_agents_v2.rs:43-52`）。

---

## 3. 何时暴露：`multi_agent_version` 判定与 feature flag

### 3.1 版本枚举

```rust
pub enum MultiAgentVersion { Disabled, V1, V2 }
```
`protocol/src/protocol.rs:3213-3219`（`serde rename_all = "snake_case"`）。

### 3.2 Feature flag

- `Feature::Collab`，key `"multi_agent"`，`Stage::Stable`，`default_enabled: true`：`features/src/lib.rs:1482-1486`。
- `Feature::MultiAgentV2`，key `"multi_agent_v2"`，`Stage::Stable`，`default_enabled: false`：`features/src/lib.rs:1488-1493`。
- V2 相关配置结构：`MultiAgentV2ConfigToml`（`features/src/feature_configs.rs:289-357`）；运行时结构 `MultiAgentV2Config` 与默认值（`core/src/config/mod.rs:1373-1425`）。

### 3.3 版本如何判定

- 覆盖逻辑：`Config::multi_agent_version_override`：开 `Feature::MultiAgentV2` → `V2`；否则若 `!agents_enabled` → `Disabled`（`core/src/config/mod.rs:1641-1649`）。
- 默认逻辑：`multi_agent_version_from_features`：`Feature::Collab` 开 → `V1`，否则 `Disabled`（`core/src/config/mod.rs:1651-1659`）。
- 结合模型：`multi_agent_version_for_model`：override → 模型自带的 `model_multi_agent_version` → 默认（`core/src/config/mod.rs:1661-1668`）。
- 会话级固化：`Session::resolve_multi_agent_version_for_model`（`core/src/session/mod.rs:4416-4427`），在 turn context 构建时解析（`core/src/session/turn_context.rs:1290`）。
- 模型层面的 `multi_agent_version` 字段：`protocol/src/openai_models.rs:279`（ModelPreset）、`:511`（ModelInfo）；会话元数据字段 `protocol/src/protocol.rs:3325`，TurnContextItem 字段 `protocol/src/protocol.rs:3455`。

### 3.4 是否注册/暴露工具

- **全局开关**：`collab_tools_enabled`（`core/src/tools/spec_plan.rs:728-741`）：
  - `Disabled` → `false`（不注册任何 agent 工具）。
  - `V1` → 不超深度限制才注册（`:731-734`）。
  - `V2` → `!multi_agent_v2.disable_native_tools && (session_source.get_agent_path().is_none() || model_info.multi_agent_version == Some(V2))`（`:735-741`）。
- **哪些模型不暴露（关键）**：当当前会话是一个 sub-agent（`get_agent_path().is_some()`）且其模型 **不是** `multi_agent_version == Some(V2)` 时，V2 的 agent 工具一律不注册。测试：`core/src/tools/spec_plan_tests.rs:3055-3109`（Bedrock worker：V2 模型可委托，V1/None 模型不可委托，且注册表里没有 `agents.spawn_agent` / `agents.followup_task`）。
- **V2 内部细分开关**：
  - `multi_agent_v2.disable_native_tools` 隐藏原生工具（保留 V2 runtime 供 host 工具）：`spec_plan.rs:736`，默认 false（`core/src/config/mod.rs:1416`）。
  - `multi_agent_v2.disable_direct_message` 关闭直连消息工具（不注册 `send_message`/`followup_task`）：`spec_plan.rs:1488`，并影响子管理名单 `:757-772`，默认 false（`core/src/config/mod.rs:1417`）。
  - `multi_agent_v2.wait_agent_enabled` 控制 V2 `wait_agent` 是否注册：`spec_plan.rs:1508-1517`，默认 true（`core/src/config/mod.rs:1411`）。
  - `multi_agent_v2.non_code_mode_only` → V2 工具 exposure 变 `DirectModelOnly`，否则 `Direct`：`spec_plan.rs:1448-1452`，默认 true（`core/src/config/mod.rs:1421`）。
- **V1 exposure**：`supports_search_tool` 时 `Deferred`，否则 `Direct`：`spec_plan.rs:1540-1545`。
- 注册入口：`add_collaboration_tools`（`core/src/tools/spec_plan.rs:1438-1566`）；V2 分支 `:1441-1535`，V1 分支 `:1537-1566`。
- spawn 工具的模型 override 列表还会按后端能力过滤：`model_supports_multi_agent_backend`（`core/src/agent/child_config.rs:23-28`），即 V2 下 `model.multi_agent_version == Some(Disabled)` 的模型不会出现在 `spawn_agent` 的模型候选里（`multi_agents_spec.rs:822-833`）。

### 3.5 V1 深度限制

- 判定函数 `exceeds_thread_spawn_depth_limit(depth, max_depth) = depth > max_depth`：`core/src/agent/registry.rs:85-87`。
- V1 spawn 工具层再次校验：`core/src/tools/handlers/multi_agents/spawn.rs:76-78`；`resume_agent` 同样校验：`resume_agent.rs:57-59`。

---

## 4. `message` 的加密标注 `encrypted` 与参数覆盖机制

### 4.1 `encrypted` 标注

- schema 字段定义：`tools/src/json_schema/types.rs:47-49`（"Responses-only marker for reviewed encrypted tool parameters"）。
- 构造器：`JsonSchema::with_encrypted`：`tools/src/json_schema/types.rs:119` 附近。
- 使用位置：
  - V2 `spawn_agent.message`：`multi_agents_spec.rs:650-657`（`.with_encrypted()` 在 `:656`）。
  - `send_message.message`：`multi_agents_spec.rs:210-218`（`:217`）。
  - `followup_task.message`：`multi_agents_spec.rs:246-251`（`:250`）。
- **V1 不加密**：V1 `spawn_agent.message`（`multi_agents_spec.rs:611-616`）与 `send_input.message`（`:169-174`）没有 `.with_encrypted()`。
- 运行时语义：V2 消息默认 `AgentMessage::Encrypted`，仅当来源是 `DirectPlaintextMessage` 才用 `Plaintext`：`core/src/tools/handlers/multi_agents_v2.rs:45-56`。
- 测试佐证：`core/tests/suite/multi_agent_tool_descriptions.rs:70-84` 断言对 `spawn_agent`/`send_message`/`followup_task` 的 `message` 期望 `encrypted: true`。

### 4.2 参数/描述覆盖机制

- 包装器 `multi_agent_v2_handler(handler, namespace, description_override, parameters_override)`：`core/src/tools/multi_agent_tool.rs:22-63`。
  - `parameters_override` 用 `catalog_parameters::parse` 解析，只接受 harness 支持的 JSON-Schema 子集：`core/src/tools/catalog_parameters.rs:1-14`。
  - 解析成功后，**重新把 harness 自己的 `encrypted: true` 标注补回**覆盖后的 schema（要求覆盖 schema 必须保留同名加密参数，否则报错并回退到 bundled schema）：`core/src/tools/multi_agent_tool.rs:26-45`。
  - 覆盖只在 `spec()` 生效（description `:83-86`，parameters `:87-90`），**执行逻辑不变**（`:110-113` 直接透传 `handle`）。
- 覆盖文本来源：`ResolvedModelMessages::multi_agent_tool_description_override` / `multi_agent_tool_parameters_override`，按工具名从 model catalog 的 `tools.multi_agent` 读取：`prompts/src/model_messages.rs:173-190`。
- spec_plan 中的调用点：`core/src/tools/spec_plan.rs:1444, 1484, 1493-1494, 1502-1503, 1513-1514, 1523-1524, 1532-1533`。
- 注意 `spawn_agent` 的描述 override 比较特殊：spawn 会把选中描述与「继承模型/usage hint」组合，故 `add_collaboration_tools` 对 spawn 传 `description_override = None`（注释见 `spec_plan.rs:1485-1486`），而把 override 文本传入 handler 自身（`spec_plan.rs:1477-1483`）。
- Catalog 覆盖测试：`core/tests/suite/multi_agent_tool_descriptions.rs:9-19`（6 个 V2 工具名）、`:22-40`（catalog schema 样例）、`:70-84`（只改被选中的字段；V1 不受影响，见 `"v1_unchanged"` / `"v1_parameters_unchanged"` 用例 `:71-75`）。

---

## 5. 工具结果结构

### 5.1 V1

| 结构 | 定义 | 字段 |
|---|---|---|
| `SpawnAgentResult` | `core/src/tools/handlers/multi_agents/spawn.rs:230-234` | `agent_id: String`、`nickname: Option<String>` |
| `SendInputResult` | `core/src/tools/handlers/multi_agents/send_input.rs:155-158` | `submission_id: String` |
| `ResumeAgentResult` | `core/src/tools/handlers/multi_agents/resume_agent.rs:150-153` | `status: AgentStatus` |
| `WaitAgentResult` | `core/src/tools/handlers/multi_agents/wait.rs:298-303` | `status: HashMap<String, AgentStatus>`、`timed_out: bool` |
| `CloseAgentResult` | `core/src/tools/handlers/multi_agents/close_agent.rs:111-114` | `previous_status: AgentStatus` |

### 5.2 V2

| 结构 | 定义 | 字段 |
|---|---|---|
| `SpawnAgentResult`（enum） | `core/src/tools/handlers/multi_agents_v2/spawn.rs:244-256` | `WithNickname{task_name,nickname}` / `HiddenMetadata{task_name}` |
| `WaitAgentResult` | `core/src/tools/handlers/multi_agents_v2/wait.rs:146-151` | `message: String`、`timed_out: bool` |
| `InterruptAgentResult` | `core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs:91-94` | `previous_status: AgentStatus` |
| `ListAgentsResult` | `core/src/tools/handlers/multi_agents_v2/list_agents.rs:88-96` | `agents: Vec<ListedAgent{agent_name, agent_status}>` |
| `send_message` / `followup_task` | `message_tool.rs:97` | 无结构，返回空文本 `FunctionToolOutput`（`success=Some(true)`） |

### 5.3 序列化/输出通道

- 统一 JSON 文本序列化：`multi_agents_common.rs:29-65`（`tool_output_json_text` / `tool_output_response_item` / `tool_output_code_mode_result`）。
- 各结果实现 `ToolOutput`（`log_output` / `to_response_item` / `code_mode_result`），例如 `spawn.rs:236-252`。
- V2 消息类工具不返回内容体，成功与否通过 `FunctionToolOutput` 的 `success` 表达（`message_tool.rs:97`）。

### 5.4 输出 schema 位置

- V1 spawn：`multi_agents_spec.rs:415-431`；V2 spawn：`:433-463`。
- `send_input`：`:465-477`；`list_agents`：`:479-506`；`resume_agent`：`:508-517`。
- V1 wait：`:519-536`；V2 wait：`:538-554`。
- `close_agent`/`interrupt_agent` 共用 `agent_previous_status_output_schema`：`:556-568`。
- `agent_status_output_schema`：`:384-414`。

---

## 6. 不确定 / 未确认

- 「哪些具体模型不暴露」的最终名单依赖运行时 model catalog 中每个 preset 的 `multi_agent_version` 字段（`protocol/src/openai_models.rs:279`），本仓库未静态列出全部模型，故只给出判定规则与 Bedrock 测试样例，**未确认**完整模型名单。
- `TurnContext` 里 `multi_agent_version` 在 `core/src/session/turn_context.rs:1290` 解析（`self.resolve_multi_agent_version_for_model(&model_info, &per_turn_config)`）；`InjectItems`/`StartupPrewarm` 走 `multi_agent_version_for_model`（`turn_context.rs:1297-1300`）。
- `SpawnAgentForkMode` 的完整定义与数字计数语义（`fork_turns` 接受旧式数字）在 `core/src/agent/types.rs`（本报告未逐行展开），`fork_turns` 接受 `NonZeroUsize` 的证据为 `v2/spawn.rs:232`；其被消费的具体 fork 行为**未确认**。
- V1 `wait_agent` 是否会把完成消息正文带回（描述称 "Completed statuses may include the agent's final message"，`multi_agents_spec.rs:293`），取决于 `AgentStatus::Completed` 承载内容，**未确认**其渲染细节。
