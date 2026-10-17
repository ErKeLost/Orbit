# Codex 多 Agent 并发模型与额度限制分析

- 仓库：`/Users/work/pi-gui/vendor/codex`（`codex-rs`），commit `5009a99`（最新 main）。
- 范围：`core/src/agent/**`、`core/src/config/mod.rs`、`core/src/rollout_budget.rs`、相关测试。
- 每条结论后括号内为 `路径:行号` 证据；无法从代码直接确认的标注「未确认」。

---

## 0. 结论速览

Codex 的多 agent 并发**不是**基于 `tokio::sync::Semaphore`，而是三套相互配合的**原子计数/队列式准入**机制：

1. **AgentRegistry**：管理「已 spawn 的子 agent 数量」上限，用 `AtomicUsize::CAS` 实现（`core/src/agent/registry.rs:333`）。
2. **AgentExecutionLimiter**：管理「正在运行 turn 的子 agent」上限，用 `AtomicUsize` 计数 + guard 释放（`core/src/agent/control/execution.rs:16`）。
3. **V2Residency**：管理「V2 常驻子 agent runtime」上限，用 `Mutex<VecDeque + pending_slots>` 并支持逐出空闲 runtime（`core/src/agent/control/residency.rs:100`）。

三者都以 **一个 root session tree** 为作用域，**root 不占用子 agent 配额**。超限统一返回 `AgentLimitReached`，对外文案 `agent thread limit reached`。

---

## 1. 并发 slot 上限的默认值与配置方式

### 1.1 默认常量

| 常量 | 值 | 证据 |
|---|---|---|
| `DEFAULT_AGENT_MAX_THREADS` | `Some(6)`（V1 / Disabled 默认） | `core/src/config/mod.rs:256` |
| `DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION` | `4`（V2，含 root） | `core/src/config/mod.rs:257` |
| `DEFAULT_AGENT_MAX_DEPTH` | `1`（V1 嵌套深度） | `core/src/config/mod.rs:266` |

### 1.2 生效值 `effective_agent_max_threads`

`Config::effective_agent_max_threads(version)`（`core/src/config/mod.rs:1670`）：

- `MultiAgentVersion::V2` → `max_concurrent_threads_per_session.saturating_sub(1)`
  （`core/src/config/mod.rs:1674-1678`）。V2 默认 `4 - 1 = 3`，**扣除 root**。
- `MultiAgentVersion::Disabled | V1` → `agent_max_threads.or(DEFAULT_AGENT_MAX_THREADS)`
  （`core/src/config/mod.rs:1680-1682`），即 `Some(6)` 或用户显式值。

### 1.3 配置入口与映射

- `[agents].max_concurrent_threads_per_session`（别名 `[agents].max_threads`）：
  - 别名映射：`config/src/key_aliases.rs:22-25`（`agents.max_threads` → `agents.max_concurrent_threads_per_session`）。
  - `serde(alias = "max_threads")` 字段定义：`config/src/config_toml.rs:764-766`。
  - 解析进 Config：`core/src/config/mod.rs:4018-4021`（`cfg.agents.max_concurrent_threads_per_session`）。
- `[features.multi_agent_v2].max_concurrent_threads_per_session`：`core/src/config/mod.rs:1374`。
- 合并规则 `resolve_multi_agent_v2_config`（`core/src/config/mod.rs:2818`）：
  - 若 `features.multi_agent_v2.max_concurrent_threads_per_session` 有值，直接采用（`mod.rs:2821`）；
  - 否则用 `agents.max_concurrent_threads_per_session + 1`（补上 root，`mod.rs:2824-2828`）；
  - 都没有则用默认 `4`（`mod.rs:2829`）。
- 校验：`features...` 必须 ≥1（`mod.rs:3976-3981`）；`agents...` 若为 0 报错（`mod.rs:4022-4027`）。
- `core/src/config/mod.rs:968` 的 `agent_max_threads` 字段（注释「User-configured maximum number of spawned agent threads per session」）用于 V1 分支；V2 走 `multi_agent_v2.max_concurrent_threads_per_session`。

### 1.4 作用域：每 session 还是每 tree？root 是否计入？

- **每 session / 每 root tree**：`AgentRegistry` 文档注释明确「Total number of sub-agents (i.e. threads) per user session … shared by all agents in the same user session」（`core/src/agent/registry.rs:20-27`）。
- registry 挂在 `LocalAgentRuntime` 上，每个 root runtime 一份（`core/src/agent/control/runtime.rs:190-201`）。
- 子 agent 通过 `self.clone()`（同一个 `LocalAgentControl`/runtime）共享 registry（`core/src/agent/control/spawn.rs:951-956` 传入 `self.clone()` 到 `spawn_child_thread`），因此是**整棵树共享**。
- **root 不计入**：
  - `register_root_thread` 只登记、不递增 `total_count`（`core/src/agent/registry.rs:131-150`）。
  - `release_spawned_thread` 仅当被移除者不是 root 时才 `fetch_sub`（`core/src/agent/registry.rs:112-129`）。
  - `live_agents()` 过滤掉 root（`core/src/agent/registry.rs:181-193`）。
  - `effective_agent_max_threads(V2) = max_concurrent - 1` 也从数值上扣除 root（见 1.2）。
- 结论：**上限按 session tree 共享，root 不占子 agent 配额**。V2 默认「root + 3 个子 agent」；V1 默认最多 6 个子 agent。

### 1.5 V2 下 registry 不设限

V2 走 residency 时，registry 的 `reserve_spawn_slot` 传入 `None`（不设限），由 residency 承担容量控制：

- `reservation_max_threads = if spawn_uses_v2_residency { None } else { agent_max_threads }`（`core/src/agent/control/spawn.rs:737-743`）。
- 只有非 V2-resident（V1 等）才把 `agent_max_threads` 交给 registry（`spawn.rs:743`）。
- V2 恢复路径 `restore_v2_agent_metadata` / `resume_single_agent_from_rollout` 同样用 `None` 或配置值（`spawn.rs:262`；`spawn.rs:1468-1472`）。

---

## 2. 是否真有并发调度器/信号量；admission、guard、root/subagent 差别

### 2.1 没有任何 `tokio::sync::Semaphore`

在 `core/src` 内 agent 相关逻辑中检索 `Semaphore` **无命中**（搜索 `agent_execution_limiter`/`Semaphore` 的结果里，Semaphore 只出现在 `code-mode-host`、`voice-host`、`model-provider` 等非 agent 模块）。多 agent 并发使用：

- **Registry**：`AtomicUsize total_count` + `compare_exchange_weak` 循环（`core/src/agent/registry.rs:333-359`，字段 `registry.rs:28-30`）。
- **ExecutionLimiter**：`AtomicUsize active` + `OnceLock<usize> max_threads`（`core/src/agent/control/execution.rs:16-23`）。
- **V2Residency**：`Mutex<V2ResidencyState>`，含 `residents: VecDeque<ThreadId>` + `pending_slots: usize`（`core/src/agent/control/residency.rs:100-116`）。

### 2.2 admission 流程（spawn）

`spawn_agent_internal`（`core/src/agent/control/spawn.rs:326` 起）：

1. `admit_start()` 取得 tree membership（shutdown 栅栏，`runtime.rs:275-296`）→ `spawn.rs:331`。
2. 计算 `multi_agent_version` 与 `agent_max_threads`（`spawn.rs:335-343`、`spawn.rs:713`）。
3. `ensure_execution_capacity(version, source)`：仅 V2 且 SubAgent 时检查活跃 turn 数（`spawn.rs:711`；实现 `execution.rs:34-51`）。
4. 若为 V2-resident：`reserve_v2_residency_slot(...)`（`spawn.rs:715-733`，实现 `residency.rs:136-149`）；否则 `registry.reserve_spawn_slot(agent_max_threads)`（`spawn.rs:743`）。
5. `prepare_thread_spawn` 预留 nickname/path → `spawn_child_thread` → `reservation.commit(agent_metadata)`（`spawn.rs:972`）。

恢复路径 `resume_agent_from_rollout` / `resume_single_agent_from_rollout` 也走 `admit_start` + `reserve_spawn_slot`（`spawn.rs:1357`、`spawn.rs:1468-1515`）。V2 子 agent 的 reload 走 `ensure_v2_agent_loaded`（`spawn.rs:331` 起）。

### 2.3 guard 生命周期

- **`SpawnReservation`**（`core/src/agent/registry.rs:352`）：
  - `reserve_spawn_slot` 成功时占用一个 slot（`registry.rs:90-108`）。
  - 未 `commit` 就 Drop：释放预留的 agent path 并 `total_count.fetch_sub`（`registry.rs:389-398`，Drop 实现 `registry.rs:389`）。
  - `commit` 后：`active=false`，Drop 不再扣减（`registry.rs:379-386`）；登记的 agent 保留在 `agent_tree`，直到 `release_spawned_thread`（线程关闭时）才扣减（`registry.rs:112-129`）。
- **`AgentExecutionGuard`**（`core/src/agent/types.rs:77-89`，`#[must_use]`）：
  - 包装 `Box<dyn Send + Sync>` permit；本地 permit `LocalExecutionPermit::drop` 执行 `active.fetch_sub`（`execution.rs:24-30`）。
  - 在 turn 开始时由 `admit_turn` 获取（`tasks/mod.rs:356-359`），存进 `RunningTask._agent_execution_guard`（`tasks/mod.rs:435`、`core/src/state/turn.rs:83`），turn 结束随之释放。
  - `max_threads` 由 `LocalAgentControl::with_session_id(session_id, max_threads)` 用 `effective_agent_max_threads(V2)` 初始化（`core/src/agent/control.rs:126-130`；调用点 `core/src/session/session.rs:974-978`）。`initialize` 用 `get_or_init`，后续同值调用不覆盖（`execution.rs:64-66`）。

### 2.4 root 与 subagent 的差别

- **ExecutionLimiter 只作用于 V2 且 SubAgent**：`is_execution_limited = multi_agent_version == V2 && matches!(session_source, SessionSource::SubAgent(_))`（`execution.rs:84-90`）。root turn 返回 `None` guard，不计数。
- **Residency 只作用于 V2 且 SubAgent**：`is_v2_resident_session_source = matches!(session_source, SubAgent(_))`（`residency.rs:309-311`），`reserve_v2_residency_slot` 内部据此。
- **Registry root 不计数**（见 1.4）。
- 测试佐证：`execution_guards_ignore_root_and_v1_turns`（`core/src/agent/control/execution_tests.rs:48-64`）、`execution_guards_count_active_v2_subagent_turns`（`execution_tests.rs:18-45`）。
- 结论：**root 全程不受并发限额约束；subagent 受「活跃 turn 数（execution limiter）+ 常驻 runtime 数（residency）」双重准入，V1 则受 registry 配额。**

---

## 3. `wait_agent` 的 timeout 上下限、默认值与 blocking 语义

### 3.1 常量与默认值

| 项 | 值 | 证据 |
|---|---|---|
| `DEFAULT_MULTI_AGENT_V2_MIN_WAIT_TIMEOUT_MS` | `10_000` | `core/src/config/mod.rs:258` |
| `DEFAULT_MULTI_AGENT_V2_MAX_WAIT_TIMEOUT_MS` | `3600 * 1000` = `3_600_000` | `core/src/config/mod.rs:259` |
| `DEFAULT_MULTI_AGENT_V2_DEFAULT_WAIT_TIMEOUT_MS` | `30_000` | `core/src/config/mod.rs:260` |
| `HARD_MIN_MULTI_AGENT_V2_TIMEOUT_MS` | `0` | `core/src/config/mod.rs:263` |
| `HARD_MAX_MULTI_AGENT_V2_TIMEOUT_MS` | `3_600_000` | `core/src/config/mod.rs:263-264` |
| `DEFAULT_MULTI_AGENT_V2_TOOL_NAMESPACE` | `"collaboration"` | `core/src/config/mod.rs:261` |

### 3.2 配置与校验

- 结构字段：`MultiAgentV2Config.min_wait_timeout_ms / max_wait_timeout_ms / default_wait_timeout_ms`（`core/src/config/mod.rs:1375-1377`）。
- 解析：`core/src/config/mod.rs:2832-2840`（缺省回落到 default）。
- 校验：`validate_multi_agent_v2_wait_timeout`（`mod.rs:3199-3213`，须在 `[0, HARD_MAX]`），并强制 `min ≤ max`、`min ≤ default ≤ max`（`mod.rs:3994-4011`）。
- 工具参数组装：`spec_plan.rs:819-825`（`WaitAgentTimeoutOptions`）。

### 3.3 运行时语义（V2，`wait` handler）

`core/src/tools/handlers/multi_agents_v2/wait.rs`：

- 读取配置 min/max/default（`wait.rs:53-55`）。
- 请求值 > max → 直接返回 `FunctionCallError::RespondToModel("timeout_ms must be at most {max}")`（`wait.rs:57-61`）；否则 `requested.max(min)`（`wait.rs:62`）；缺省用 default（`wait.rs:63`）。
- blocking 机制：订阅输入队列活动 `InputQueueActivity` 的 `watch` channel（`wait.rs:65-73`），执行 `timeout_at(deadline, activity_rx.changed())`（`wait.rs:209-217`）。
- 结果三态：`MailboxActivity`（有新消息）/ `Steered`（被新输入打断）/ `TimedOut`（`wait.rs:186-217`），返回 `WaitAgentResult { message, timed_out }`（`wait.rs:134-164`）。若请求值被 clamp，会在 message 中附加提示（`wait.rs:143-153`）。
- 相关常量副本（供共享/V1 使用）：`MIN_WAIT_TIMEOUT_MS = 10_000`、`DEFAULT_WAIT_TIMEOUT_MS = 30_000`、`MAX_WAIT_TIMEOUT_MS = 3_600_000`（`core/src/tools/handlers/multi_agents_common.rs:22-24`）。
- 测试：`multi_agent_v2_wait_agent_clamps_timeout_below_configured_min`（`core/src/tools/handlers/multi_agents_tests.rs:3063`）、`..._rejects_timeout_above_configured_max`（`multi_agents_tests.rs:3240`）、`..._allows_zero_configured_timeout`（`multi_agents_tests.rs:3200`）、`wait_agent_times_out_when_status_is_not_final`（`multi_agents_tests.rs:3341`）。

---

## 4. token / rollout budget 与子 agent 的关系

### 4.1 配置与共享范围

- `RolloutBudgetConfig { limit_tokens, reminder_at_remaining_tokens, sampling_token_weight, prefill_token_weight }`（`core/src/config/mod.rs:1345-1350`）。
- `RolloutBudget` 注释：**"Shared accounting and reminder state for one root-thread session tree"**（`core/src/rollout_budget.rs:16`）。
- 实例位于 `LocalAgentRuntime.rollout_budget`（`core/src/agent/control/runtime.rs:193`），构造时由 `config.rollout_budget` 配置（`core/src/thread_manager.rs:1668-1676`），root 与所有 subagent 共享同一 runtime → **共享同一预算**。

### 4.2 记账与超限

- `record_usage`（`core/src/rollout_budget.rs:45-68`）：优先用 provider 返回的 `usage.codex_rollout_budget_units`，否则 `output_tokens * sampling_token_weight + non_cached_input * prefill_token_weight`；累计值 ≥ `limit_tokens` 返回 `true`。「Returns true once the configured budget is exhausted, including on later calls」。
- 控制层 `record_rollout_budget_usage`：达到即返回 `CodexErr::SessionBudgetExceeded`（`core/src/agent/control/budget.rs:12-19`）。
- 提醒 `pending_reminder` / `mark_reminder_delivered`（`core/src/rollout_budget.rs:70-113`）按 thread 记录，让每个线程都能观察到阈值跨越；注入上下文见 `core/src/session/rollout_budget.rs:7-27`。
- 子 agent 的 usage 经 `AgentControl::record_usage`（`core/src/agent/control/api.rs:288-290`）汇入共享预算。

### 4.3 与并发限额的关系

- 预算与 slot 并发限额是**相互独立**的两套限制，但都按 session tree 共享（`rollout_budget.rs:16`；`registry.rs:20-27`）。
- 关键测试：`subagent_usage_draws_from_the_shared_budget`（`core/tests/suite/rollout_budget.rs`，验证子 agent 的 30 tokens 与 root 的 10+10 一起从 100 预算扣除，root 后续看到剩余 50）；`exhausted_budget_fails_current_and_later_turns`（`rollout_budget.rs` 同文件）；`compaction_budget_exhaustion_fails_without_retry`（同文件）。
- 「未确认」：预算耗尽是否会导致正在运行的子 agent 被主动终止——从代码看是在下一次 usage 记账/下一 turn 报错，未发现对子 agent 的主动 kill 逻辑。

---

## 5. 超出上限时的错误与行为

### 5.1 统一错误类型

`CodexErrorDetails::AgentLimitReached { max_threads }`，显示文案 `"agent thread limit reached"`（`protocol/src/error.rs:131-132`），映射 `CodexErrorInfo::BadRequest`（`protocol/src/error.rs:522`，另见 `protocol/src/error.rs:430`）。三种触发点用 `AgentErrorContext` 区分：

| 触发点 | 上下文 | 证据 |
|---|---|---|
| Registry 配额（V1/非 resident） | `RegistryCapacity` | `core/src/agent/registry.rs:95-99` |
| ExecutionLimiter 活跃 turn | `ExecutionCapacity` | `core/src/agent/control/execution.rs:45-49` |
| V2 residency 常驻 runtime | `ResidencyCapacity` | `core/src/agent/control/residency.rs:194-199` |

`AgentErrorContext` 定义见 `protocol/src/agent_error.rs`（`ExecutionCapacity` 于 `agent_error.rs:10`）。

### 5.2 对外行为

- **spawn 直接失败，不排队、不等待**：错误经 `collab_spawn_error` 转为模型可见的 `FunctionCallError::RespondToModel("collab spawn failed: {err}")`（`core/src/tools/handlers/multi_agents_common.rs:64-76`）。
- 遥测 reason 记为 `"limit_reached"`（`multi_agents_common.rs:88`）。
- V2 residency 超限时会**先尝试逐出一个空闲 resident**（`reserve_slot` 循环 + `try_unload_one_resident`，`core/src/agent/control/residency.rs:177-200`、`residency.rs:215-270`）；仅当无可逐出者时返回 `AgentLimitReached`（`residency.rs:194-199`）。`PendingInit` 状态候选被跳过（`residency.rs:236-243`）。
- 端到端测试：`v2_nested_spawn_checks_shared_active_execution_capacity` 断言第二次 spawn 输出 `"collab spawn failed: agent thread limit reached"`，且线程数保持 2（`core/tests/suite/agent_execution.rs:145-235`，关键断言 `agent_execution.rs:227-229`）；`agent_execution.rs` 上层还有 `spawn_failure_context_distinguishes_execution_and_residency_capacity`（`core/src/agent/control_tests.rs:670-745`）。
- Registry 配额与恢复路径测试：`spawn_agent_respects_max_threads`、`spawn_agent_limit_shared_across_clones`、`resume_agent_respects_max_threads_limit`（`core/src/agent/control_tests.rs:4210-4405`，断言 `AgentLimitReached`）。
- **深度限制（仅 V1）**：超过 `agent_max_depth` 返回 `"Agent depth limit reached. Solve the task yourself."`（`core/src/tools/handlers/multi_agents/spawn.rs:74-79`；`multi_agents/resume_agent.rs:55-58`）。
- **tree 正在关闭**：`admit_start` 在 shutdown 后拒绝，返回 `InvalidRequest("agent runtime is shutting down")`（`core/src/agent/control/runtime.rs:275-296`）。

---

## 6. 相关测试文件（按要求索引）

- `core/tests/suite/agent_execution.rs`：跨共享执行容量的嵌套 spawn（`agent_execution.rs:145`）；tree shutdown / residency reload / 树隔离（同文件 `agent_execution.rs:266` 起）。
- `core/src/agent/control_tests.rs`：execution vs residency 容量区分（`control_tests.rs:670`）；max_threads 上限与共享（`control_tests.rs:4210-4405`）。
- `core/src/agent/control/execution_tests.rs`：guard 计数、root/V1 不计（`execution_tests.rs:18-64`）。
- `core/tests/suite/rollout_budget.rs`：共享预算、子 agent 扣减、超限、compaction。
- `core/tests/suite/scenarios_agent_eviction_tests.rs`：idle eviction 保留 worker 上下文，供 followup 复用（`max_concurrent_threads_per_session = 2`，文件 `:29`）。
- `core/src/agent/control/residency_tests.rs`：residency slot 行为（`residency_tests.rs:26`、`:88`）。

---

## 7. 未确认 / 待补充

- 「预算耗尽是否会主动终止正在运行的子 agent」——未在代码中发现主动 kill，推测为下一 turn/记账时失败。**未确认**。
- registry 与 residency 在 V2 下的严格边界（例如非 `ThreadSpawn` 的 `SubAgentSource::Other` 是否全部走 residency）——`is_v2_resident_session_source` 对所有 `SubAgent(_)` 返回 true（`residency.rs:309-311`），故应都走 residency；但个别内部 subagent 路径可能有独立处理。**未确认**。
- 远程/非本地 backend 的 `AgentExecutionGuard` 恢复语义（`types.rs:74-76` 注释提到 remote backend 需在 worker 丢失后恢复预留）在本仓库本地实现中未见对应代码。**未确认**。
