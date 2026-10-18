# Codex 多 Agent 消息投递、生命周期与结果回传机制分析

- 分析对象：`/Users/work/pi-gui/vendor/codex`，commit `5009a99`（最新 main）。
- 路径基准：下文 `file:line` 均相对 `vendor/codex/`（例如 `codex-rs/core/src/agent/control.rs:457`）。
- 方法：直接阅读生产代码为主，测试仅作行为佐证。凡无法从代码/测试确证者标「未确认」。

## 0. 总览（心智模型）

```
父 turn ──spawn_agent──▶ AgentControl::spawn ──▶ 子 thread (ThreadSpawn)
   ▲                                                │
   │  result 回传（V2: turn_finished→completion.rs；V1: completion watcher）
   │                                    InterAgentCommunication{trigger_turn:false}
   │                                                │
   └────────── 父 session.input_queue.enqueue_mailbox_communication
                          │
        mailbox(bool) watch ──▶ submission_loop 唤醒 ──▶ InputQueueActivity::Mailbox
                          │                                   │
        wait_agent 唤醒 / 下一次采样 get_pending_input 时 drain ──▶ record_inter_agent_communication
```

- 控制器契约：`AgentControl` trait（`codex-rs/core/src/agent/api.rs:41`），本地实现是 `LocalAgentControl`（`codex-rs/core/src/agent/control.rs:97`），每个 agent tree 共享一个 `LocalAgentRuntime`（`codex-rs/core/src/agent/control/runtime.rs:184`）。
- 消息统一载体：`InterAgentCommunication{author, recipient, content, encrypted_content, trigger_turn}`（`codex-rs/protocol/src/protocol.rs:913`）；`trigger_turn` 是「队列投递」与「触发新 turn」的唯一开关。
- 工具差异：`send_message` → `MessageDeliveryMode::QueueOnly`，`followup_task` → `MessageDeliveryMode::TriggerTurn`（`codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs:46`、`.../followup_task.rs:46`、`codex-rs/core/src/agent/types.rs:59`）。

---

## 1. spawn 后子 agent 的结果如何回到父 agent

### 1.1 V2（MultiAgentV2）走 turn 终态回调，不走 spawn 时的 watcher

- spawn 时只在 **非 V2** 才启动 `maybe_start_completion_watcher`：
  `codex-rs/core/src/agent/control/spawn.rs:982`（`if multi_agent_version != MultiAgentVersion::V2 { ... maybe_start_completion_watcher(...) }`）。
- V2 子线程每个终态事件在 `Session::send_event` 后调用 `maybe_notify_parent_of_terminal_turn`：
  `codex-rs/core/src/session/mod.rs:2484`（调用点）、`:2505`（函数定义）。
  该函数只在 `MultiAgentVersion::V2`、且事件为 `TurnComplete|TurnAborted`、且 `SessionSource::SubAgent(ThreadSpawn{agent_path:Some(_)})` 时继续（`session/mod.rs:2511-2523`）。
- 它先取 `terminal_error` 或由 `agent_status_from_event` 推导状态，再用 `is_final` 过滤，最后调用
  `agent_control.turn_finished(AgentTurnOutcome{ thread_id, turn_id, source, parent_turn_id, initiating_agent_path, status, error_info }, trace)`
  （`session/mod.rs:2526-2568`；`AgentTurnOutcome` 结构见 `codex-rs/core/src/agent/api.rs:238`）。
- 终态路由实现 `notify_parent_of_terminal_turn`（`codex-rs/core/src/agent/control/completion.rs:27`）：
  - 只处理 `ThreadSpawn{parent_thread_id, agent_path:Some(child)}`；由父子路径切分得到 `parent_agent_path`（`completion.rs:31-45`）。
  - `Completed` 时对「发起活动的线程」发 `SubAgentActivity{kind:Completed, id:"subagent-completed-{turn_id}", agent_thread_id}`（`completion.rs:47-90`；`id` 构造 `completion.rs:79`）。
  - 依据状态构造完成文本（完成/错误/Guardian 中断），包装为 `InterAgentCommunication{trigger_turn:false}`（**队列投递，不启动 turn**），再 `send_inter_agent_communication(parent_thread_id, ...)`（`completion.rs:92-131`；`InterAgentCommunication::new` 在 `:112`，发送在 `:122`）。
  - 发送结果写 `codex.multi_agent.result_delivery` 指标，`queued`/`failed`（`completion.rs:127-136`）。
- 文本构造在 `format_inter_agent_completion_message`（`codex-rs/core/src/session_prefix.rs:20`），渲染为 `InterAgentCompletionMessage`：
  - `Completed(Some(msg))` → msg；`Completed(None)` → 空；`Errored` → 截断错误 + `ERROR_NEXT_ACTION`；`Shutdown`/`NotFound` 有固定文案；`PendingInit|Running|Interrupted` 返回 `None`（`session_prefix.rs:26-38`）。
  - 最终 `Message Type: FINAL_ANSWER`（`codex-rs/core/src/context/inter_agent_completion_message.rs:42`）。
- 测试佐证：完成以 `agent_message` 请求项投递，`author="/root/worker"`、`recipient="/root"`，payload 为 `FINAL_ANSWER`（`codex-rs/core/tests/suite/subagent_notifications.rs:2752-2767`）；同时父发起 turn 收到 `SubAgentActivity::Completed`（`subagent_notifications.rs:3126-3165`）。

### 1.2 V1 / 遗留：spawn 时启动 completion watcher

- `maybe_start_completion_watcher`（`codex-rs/core/src/agent/control.rs:457`）仅在 `SubAgentSource::ThreadSpawn` 下启动（`control.rs:465-470`），并在 tree shutdown 时 `select!` 退出（`control.rs:490`）。
- 它通过 `subscribe_status(child_thread_id)` 订阅状态流，遇到 `is_final` 状态即停止（`control.rs:485-509`）。
- 若 child 有 agent_path 且使用 V2，则同样以 `InterAgentCommunication{trigger_turn:false}` + `AgentCommunicationKind::Result` 发回父（`control.rs:516-548`）。
- 否则（V1）向父注入 `SubagentNotification` 片段（`control.rs:551-575`），渲染标记 `<subagent_notification>`、body 为 `{agent_path,status}`（`codex-rs/core/src/context/subagent_notification.rs:39-54`）。
- **tree shutdown 不算子结果**：若状态是 `Shutdown` 且 `runtime.shutdown.is_cancelled()`，直接返回（`control.rs:506-509`）。
- 注意：`is_final` **不包含 `Interrupted`**（`codex-rs/core/src/agent/status.rs:26`），因此被中断的 V1 子 agent 不会触发 completion 通知。V2 的 `maybe_notify_parent_of_terminal_turn` 对普通 `TurnAborted(Interrupted)` 也会跳过（仅 `TooManyDenials` 例外，`session/mod.rs:2531-2546`）。

### 1.3 核心结论

| 版本 | 结果触发点 | 载体 | trigger_turn |
|---|---|---|---|
| V2 | 子线程 turn 终态事件回调 `turn_finished`（`session/mod.rs:2505`） | `InterAgentCommunication` + `InterAgentCompletionMessage` | false |
| V1 | spawn 期间的状态订阅 watcher（`control.rs:457`） | V1 用 `SubagentNotification`；V2 子路径用 `InterAgentCommunication` | 视路径 |

---

## 2. 消息投递语义

### 2.1 `send_message(QueueOnly)` vs `followup_task(TriggerTurn)`

- 工具层只差一个枚举：`send_message` 固定 `QueueOnly`（`multi_agents_v2/send_message.rs:46`），`followup_task` 固定 `TriggerTurn`（`multi_agents_v2/followup_task.rs:46`）；共享 `handle_message_string_tool`（`codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs:52`）。
- 转换为 `InterAgentCommunication` 时：
  - `QueueOnly` → `trigger_turn=false`、消息类型 `MESSAGE`；
  - `TriggerTurn` → `trigger_turn=true`、消息类型 `NEW_TASK`。
  （`codex-rs/core/src/agent/control/delivery.rs:9-40`；`delivery.rs:20` 判断 `trigger_turn`）
- `send`（`codex-rs/core/src/agent/control/api.rs:100`）差异：
  - `TriggerTurn` 前先 `ensure_execution_capacity_for_turn_start`（`control.rs:166-175`）并**强制 `ensure_v2_agent_loaded`**（`api.rs:145-151`）；
  - `QueueOnly` 时 `start_options.parent_turn_id` 被清空（`api.rs:156-158`），且只有「本地已驱逐」的接收者才保留 mail 而不重载（`api.rs:141-151` 注释：cold-restored 仍会懒加载）。
  - 二者都调用 `send_inter_agent_communication`（`api.rs:163`）。
- `TriggerTurn` 不能指向 root：`api.rs:129-133`（`"Follow-up tasks can't target the root agent"`）；`interrupt_spawned_agent` 也拒绝 root/self（`codex-rs/core/src/agent/control/interrupt.rs:26,33`）。
- 行为佐证：queue-only 完成不会启动父 turn，父需 `wait_agent` 或下一采样才拿到（`subagent_notifications.rs:2598-2625`）；`followup_task` 会启动新 turn 且 `turn_trigger=="composer"`（`subagent_notifications.rs:3070`），工具本身立即返回空（`subagent_notifications.rs:3051-3054`）。

### 2.2 投递路径：加载态 vs 未加载态

`submit_inter_agent_communication`（`codex-rs/core/src/agent/control.rs:257`）：

- **未加载 + QueueOnly**：在持有 `threads` 读锁的原子区间内，`mailboxes.enqueue(agent_id, submission_id, [communication])` 直接进内存信箱，返回 submission id，**不加载、不启动 turn**（`control.rs:270-292`）。这正是「mailbox 保留邮件」的懒加载前置。
- **已加载（或 TriggerTurn）**：走 `state.send_op(agent_id, Op::InterAgentCommunication{...})`（`control.rs:295-320`）。
- 语义保证：未加载投递与「发布重载 session」原子（`control.rs:271-272` 注释）；已加载接收者保持与 follow-up/interrupt 的提交顺序（`control.rs:294`）。
- `DeliveryReceipt.submission_id` 只是「受理标识」，不代表接收方已处理（`codex-rs/core/src/agent/api.rs:233-236`）。

### 2.3 mailbox 唤醒 watch 机制

- `Mailboxes` 内部每 agent 一个 `watch::Sender<bool>`（`codex-rs/core/src/agent/control/mailbox.rs:26-30`）。
  - `enqueue`：追加邮件后 `send_replace(!pending.is_empty())`（`mailbox.rs:36-56`）。
  - `take`：整体取出并 `send_if_modified(std::mem::take)` 复位为 false；若邮件来自驱逐转移则补发 receive 埋点（`mailbox.rs:59-79`）。
  - `watch`：先回收空/无订阅者条目，再 `subscribe()`（`mailbox.rs:81-94`）；`close` 时全部置 false（`mailbox.rs:107-112`）。
- session 侧 `InputQueue::with_controller` 在构造时订阅 `control.watch_mailbox(thread_id)`（`codex-rs/core/src/session/input_queue.rs:117`）。
- `submission_loop` 用 `tokio::select!` 同时等 shutdown、`rx_sub.recv()` 和 mailbox watch；邮件到达（`Ok(true)`）时 `notify_mailbox()`（把 `activity_tx` 置 `Mailbox`），并在有 durable sleep 时尝试唤醒（`codex-rs/core/src/session/handlers.rs:442-475`）。
- `notify_mailbox` 只是把 `InputQueueActivity::Mailbox` 写入 `activity_tx`（`input_queue.rs:131-133`），供 `wait_agent`/`sleep` 订阅（`codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:73,203`）。
- `Op::InterAgentCommunication` 处理：`inter_agent_communication` → `enqueue_mailbox_communication` → 若 `trigger_turn` 或 durable sleep 则 `maybe_start_turn_for_pending_work_with_sub_id`（`codex-rs/core/src/session/handlers.rs:82-91`；Op 分派在 `handlers.rs:650`）。
- 触发 turn 的判定：`has_trigger_turn_mailbox_items`（`input_queue.rs:229`）与 `maybe_start_turn_for_pending_work`（`codex-rs/core/src/tasks/mod.rs:457,471`）；`reserve_pending_work_turn` 要求 `trigger_turn` 或 durable sleep 才预留（`codex-rs/core/src/session/turn_input.rs:704-726`）。

### 2.4 投递到模型上下文

- 采样前 `get_pending_input` 在「当前 turn 接受 mailbox 投递」时 drain mailbox（`input_queue.rs:400-431`）；turn 开始时也会 drain 一次（`tasks/mod.rs:328`）。
- 产出 `TurnInput::InterAgentCommunication`（`input_queue.rs:243-273`），最终由 `record_pending_input` → `record_inter_agent_communication` 写入历史（`codex-rs/core/src/hook_runtime.rs:766-772`；`codex-rs/core/src/session/mod.rs:4048`）。
- 转换为模型项：`InterAgentCommunication::to_model_input_item`（`codex-rs/protocol/src/protocol.rs:994-1024`）；加密走 `encrypted_content`，否则直接放 `content`。
- mailbox 抢占（preemption）：tool call 到达时 `accept_mailbox_delivery_for_current_turn`（`codex-rs/core/src/stream_events_utils.rs:334`），并在完成项时按策略 `defer_mailbox_delivery_to_next_turn`（`stream_events_utils.rs:133`；`input_queue.rs:322`）。`DeferMailboxPreemption` 特性控制该行为（`codex-rs/core/tests/suite/scenarios_mailbox_preemption_tests.rs:110`）。

### 2.5 未加载 agent 的懒加载 / 恢复

- 已驱逐（locally evicted）接收者可仅保留 mail，不重载（`api.rs:141-151`）；`try_evict_v2_thread` 在驱逐时把 input_queue 遗留邮件转存进 mailbox（`codex-rs/core/src/agent/control/residency.rs:70-78`）。
- 未加载但记录在案的 V2 子 agent，任何消息（尤其 TriggerTurn）会经 `ensure_v2_agent_loaded` 懒加载（`api.rs:145-151`；实现 `codex-rs/core/src/agent/control/spawn.rs:325`）。
- 加载时重新从 thread store 读历史、校验 V2 与父子归属，再用 `InitialHistory::Resumed` 重建（`spawn.rs:357-430`）；**不启动 turn**，仅恢复 runtime 并返回 residency pin（`spawn.rs:486` 起；`api.rs:145-151` 注释）。
- 对外入口 `ThreadManager::ensure_multi_agent_v2_child_loaded` 要求「父已加载」，否则报错（`codex-rs/core/src/thread_manager.rs:1288-1320`）。
- 测试佐证：冷子必须显式 `ensure_multi_agent_v2_child_loaded`，否则 `get_thread` 为 `ThreadNotFound`；父侧排队消息会惰性重载原 worker（`codex-rs/core/tests/suite/multi_agent_restore_tests.rs:296-307`；`multi_agent_resume.rs:568-570`）。

---

## 3. 生命周期状态机

### 3.1 状态定义

`AgentStatus`（`codex-rs/protocol/src/protocol.rs:1937-1954`）：

| 状态 | 含义 |
|---|---|
| `PendingInit`（Default） | 等待初始化 |
| `Running` | 正在执行 |
| `Interrupted` | 当前 turn 被中断，可能再接收输入 |
| `Completed(Option<String>)` | 完成，含最终 assistant 消息 |
| `Errored(String)` | 出错 |
| `Shutdown` | 已关闭 |
| `NotFound` | 找不到 |

终态判定 `is_final`：仅 `PendingInit | Running | Interrupted` 非终态（`codex-rs/core/src/agent/status.rs:26-31`）。

### 3.2 从事件推导

`agent_status_from_event`（`codex-rs/core/src/agent/status.rs:6-24`）：

| 事件 | 状态 |
|---|---|
| `TurnStarted` | `Running` |
| `TurnComplete` 有 error | `Errored(message)` |
| `TurnComplete` 无 error | `Completed(last_agent_message)` |
| `TurnAborted` reason=Interrupted/BudgetLimited | `Interrupted` |
| `TurnAborted` 其他 reason | `Errored(format!("{:?}", reason))` |
| `Error` | `Errored(message)` |
| `ShutdownComplete` | `Shutdown` |
| 其他 | `None`（不改状态） |

应用点：`Session::deliver_event_raw` 对每个事件 `if let Some(status) = agent_status_from_event(...) { self.agent_status.send_replace(status) }`（`codex-rs/core/src/session/mod.rs:2703-2709`）。恢复时从 rollout 最后一个 `EventMsg` 推导，若为 `Interrupted` 则置 `Interrupted`（`session/mod.rs:1678-1687`）。

### 3.3 状态查询

- `LocalAgentControl::get_status`：runtime 无法 upgrade 或 `get_thread` 失败 → `NotFound`（`codex-rs/core/src/agent/control.rs:365-376`）。
- `inspect_agent`：未加载但已注册 → `AgentInfo::Unloaded(metadata)`，不恢复 runtime（`codex-rs/core/src/agent/control/inspection.rs:14-33`）。
- `subscribe_status`：先订阅 `thread.subscribe_status()` 再读初始值，返回带初始快照的流（`codex-rs/core/src/agent/control/watch.rs:24-...`）。

### 3.4 完成 / 失败 / 取消 / 中断 / shutdown 流转

- 完成与失败：turn 结束由 `on_task_finished` 发 `TurnComplete`（或其 error 字段）或 `TurnAborted`（`codex-rs/core/src/tasks/mod.rs:646,849-877`）；`TurnComplete.error`/`terminal_error` 决定 `Errored`。
- 取消/中断：`Session::interrupt_task` → `abort_all_tasks(TurnAbortReason::Interrupted)`（`codex-rs/core/src/session/mod.rs:5347-5353`）；`abort_turn_if_active`/`finish_turn_abort` 会 `mark_interrupted()` 并 `clear_pending`，且在 `Interrupted` 时尝试 `maybe_start_turn_for_pending_work`（`tasks/mod.rs:594-643`；`mark_interrupted` 在 `session/mod.rs:1482`）。
- shutdown：`Op::Shutdown` → `shutdown_session_runtime`（先 `aborting tasks(Interrupted)` 再清理）→ 发 `ShutdownComplete`（`codex-rs/core/src/session/handlers.rs:290-297,350-393`），状态变 `Shutdown`。
- tree shutdown：`LocalAgentRuntime::request_shutdown` 关闭 `members`、取消 `shutdown` token、关闭所有 mailbox（`codex-rs/core/src/agent/control/runtime.rs:297-302`）；新启动会被 `admit_start` 二次检查拒绝（`runtime.rs:275-296`）。
- 取消的 spawn 清理：`PendingSpawn::drop` 会移除线程、`shutdown_and_wait`、丢弃持久化、关闭 spawn edge（`codex-rs/core/src/agent/control/spawn_guard.rs:49-105`）。

---

## 4. interrupt 语义、transcript/关闭、resume/restore

### 4.1 interrupt

- V2：`interrupt_spawned_agent`（`codex-rs/core/src/agent/control/interrupt.rs:19`）
  - 拒绝 root（`:26-31`）与 self（`:33-39`）；要求目标有 `agent_path`（`:43-45`）。
  - **不加载 runtime**：先 `ensure_agent_known` + `inspect_agent` 取中断前快照，再 `interrupt_agent`；未加载/已死线程视为成功（`interrupt.rs:47-58`），注释明言「never reloads it」（`interrupt.rs:1-5`）。
- V1/Disabled：`interrupt` 直接 `inspect_agent` + `interrupt_agent`（`codex-rs/core/src/agent/control/api.rs:203-215`）。
- 底层：`interrupt_agent` 发 `Op::Interrupt`（`codex-rs/core/src/agent/control.rs:330-346`），会话侧 `interrupt` handler 调 `sess.interrupt_task()`（`codex-rs/core/src/session/handlers.rs:31-33`），产生 `TurnAborted{reason:Interrupted}` → 状态 `Interrupted`。
- 工具层 `interrupt_agent` 额外发 `SubAgentActivity{kind:Interrupted}`，并返回 `previous_status` 快照（`codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs:73-95`）。
- 中断不通知父：`maybe_notify_parent_of_terminal_turn` 对普通 `Interrupted` 返回；仅 `TooManyDenials` 构造 Guardian 错误上报（`session/mod.rs:2531-2546`）。`format_guardian_interruption_message` 在 `session_prefix.rs:39`。

### 4.2 transcript / 关闭

- transcript（rollout）在 shutdown 前 `ensure_rollout_materialized` + `flush_rollout`（`codex-rs/core/src/agent/control/legacy.rs:11-17`）；会话结束再 `live_thread.shutdown()` 落盘（`session/handlers.rs:364-381`）。
- `shutdown_live_agent`：发 `Op::Shutdown`、`wait_until_terminated`，随后 `remove_thread`、清 residency、释放 spawn 记录、移除 mailbox（`legacy.rs:8-62`）。
- `close_agent`：把 spawn edge 置 `Closed`（含 stale 场景），再 `shutdown_agent_tree`（`legacy.rs:64-107`）。
- `shutdown_agent_tree`：先算 `live_thread_spawn_descendants`，再逐个 `shutdown_live_agent`（`legacy.rs:100-121`）；后代枚举实现见 `codex-rs/core/src/agent/control/runtime_context.rs:107-135`。
- 测试佐证：subagent_stop 有 2 条 hook，`stop_hook_active=[false,true]`，父/子 transcript 路径不同（`subagent_notifications.rs:861-893`），子完成不触发普通 Stop（`:897-904`），内部 Review 子 agent 不触发 SubagentStop（`:940-946`）。

### 4.3 resume / restore

- `resume_agent`：若 `get_thread` 返回 `ThreadNotFound` 则 `resume_agent_from_rollout`（`codex-rs/core/src/agent/control/resume.rs:14-35`）。
- `resume_agent_from_rollout`（MAv1 路径）：恢复单个 agent 后按 agent graph store 的 Open edge 递归恢复后代；**V2 提前返回，不递归**（`codex-rs/core/src/agent/control/spawn.rs:1351-1370`）。单个恢复会重建 session_source/agent_path/nickname/role 并注册（`spawn.rs:1427-1541`）；非 V2 恢复后同样启动 completion watcher（`spawn.rs:1521-1531`）。
- `restore_v2_agent_metadata`：只恢复注册表身份（path/nickname/role），**不重开 runtime**（`spawn.rs:199-282`）；commit 前用 graph 顺序保留路径/昵称（`spawn.rs:243-258`）。
- 测试佐证：冷启动根恢复后仅根线程驻留，子/兄弟线程 `get_thread().is_err()`（`multi_agent_resume.rs:496-511`）；恢复只读元数据、`!include_history`（`multi_agent_restore_tests.rs:152`）；子读并发且按 graph 顺序应用（`multi_agent_restore_tests.rs:272-292`）；重载后模型/供应商/推理力度/权限 profile 保持（`multi_agent_resume.rs:729-737`）。

---

## 5. message board（`codex-agent-message-board-client` / extension 的使用）

- 安装：`install_agent_message_board`（`codex-rs/core/src/agent_message_board.rs:44`）同时安装 client 通知与 board extension。
  - 触发条件：显式 `LocalBoardConnection`，或 `Feature::AgentMessageBoard + MultiAgentV2`；ephemeral 需 in-memory 或 remote（`agent_message_board.rs:63-77`）。
  - 后端选择：connection > remote（bearer token/URL） > in-memory > 本地 SQLite（`agent_message_board.rs:88-125`）。
- 访问控制：`LocalBoardHost::actor` 校验 board 归属，`get_thread_for_board` 要求同一 board 的显式连接（`agent_message_board.rs:152-174`；`codex-rs/core/src/thread_manager.rs:957-973`）。
- 通知投递 `MessageBoardHost::notify`（`agent_message_board.rs:236-286`）：
  - recipient 不存在 → `NotificationDelivery::SkippedInactive`（`:240-245`）；
  - 构造 `AgentMessageBoardNotification` 的 `InterAgentCommunication{trigger_turn:false}`（`:250-258`）；
  - remote notice 有大小上限（`>1024` 报错，`:260-268`）；
  - 通过 `deliver_mailbox_communication_to_current_turn(...)` 投递到**当前活跃 turn**；成功 → `Accepted`，否则 `SkippedInactive`（`:269-285`）。
- **关键语义**：该适配器「绝不启动或恢复接收者，也绝不为空闲 agent 排队通知」（`agent_message_board.rs:1-6`）；空闲/已完成 agent 不唤醒、不重开 final answer。
- 渲染：`AgentMessageBoardNotification` body 为 `Message Type: CHANNEL_POST\nSender/Channel/Message ID/Thread ID/Payload`（`codex-rs/core/src/context/agent_message_board_notification.rs:26-40`）。
- 测试佐证：跨实例共享同一 board（`scenarios_agent_message_board.rs:1038-1043`）；`board_is_shared_with_children_and_skips_idle_notices`（`:250`）——根 `Completed` 时读请求不含 CHANNEL_POST（`:324-344`）；`board_notifications_do_not_reopen_a_final_answer`（`:394`，通知存在性 == `!after_final`，`:549-561`）；unsubscribe 跨 `restart` 生效、resubscribe 后恰 1 条（`:569`，`:843-855`）；固定读写/只读访问连接（`:1049-1051`，未连接运行时的通知被拒 `:1157`）；board clock 失败不回退、不建 channel（`:887`，`:917-934`）。

---

## 6. 未确认 / 边界

- `NotificationDelivery::Accepted` / `SkippedInactive` 语义由实现代码直接给出（`agent_message_board.rs:269-285`），但指定测试文件未直接断言枚举值，仅以「上下文是否出现 CHANNEL_POST」间接验证 → 测试侧「未确认」。
- mailbox 抢占（preemption）行为在 `subagent_notifications.rs` 中未见断言；由 `scenarios_mailbox_preemption_tests.rs` 与 `stream_events_utils.rs` 代码佐证。
- `send_message` 的 QueueOnly 对「cold-restored（未本地驱逐）」接收者仍会懒加载（`api.rs:141-151` 注释），与「已驱逐保留 mail」是两种不同未加载态，具体触发条件需结合 `evicted_environments` 判定（`api.rs:145-147`）→ 边界行为已读代码但未用测试逐一确认。
- V1 completion watcher 在 `multi_agent_version != V2` 时启动，但 watcher 内部仍含 V2 分支（`control.rs:516`）；该 V2 分支的实际可达性依赖「spawn 版本非 V2 而子线程版本为 V2」的罕见组合 → 「未确认」。
- `AgentStatus::NotFound` 由 `get_status` 的失败路径产生（`control.rs:365-376`），与注册表中的缺失身份区分见 `inspection.rs`。

---

## 附录：最关键 file:line 索引

1. `codex-rs/core/src/session/mod.rs:2505` — V2 子 turn 终态回调父（`maybe_notify_parent_of_terminal_turn`）。
2. `codex-rs/core/src/agent/control/completion.rs:27` — 结果路由为 queue-only `InterAgentCommunication`。
3. `codex-rs/core/src/agent/status.rs:6` — 事件到 `AgentStatus` 的推导表。
4. `codex-rs/core/src/session/handlers.rs:442` — mailbox watch 唤醒 `submission_loop`。
5. `codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs:46` / `followup_task.rs:46` — QueueOnly vs TriggerTurn 的工具分叉。
