# Computer Use V3：更快、更少 Jev、可复现

> 目标：让 Jev 只在真正需要判断的时候出场；每一步的等待都由事件驱动；同一个任务第二次执行几乎不花模型轮次。
> 参考对象：trycua/cua-driver（Rust macOS 驱动 + 官方 jev-use 边界）、browser-use（新元素标记）、stagehand（act cache + self-heal）、OpenAdapt（演示编译、离线重放）、UFO（经验检索）。

## 1. 分层

```text
gui_task(goal, app, textSlots, budget)
  │
  ├─ Resolver          Spotlight 事实匹配 → bundle（沿用）
  ├─ Worker (Rust)     launch / snapshot / action / settle / now-playing
  │     settle: AXObserver 订阅 focus/value/created/destroyed/menu/window 等通知，
  │             第一个事件后再安静 quietMs 即返回；不支持时明确返回 supported=false
  ├─ Observer (TS)     snapshot → 候选编译（沿用）；media 与树指纹分离
  ├─ Decider
  │     1) Replay：Affordance Memory 命中 → 直接执行记住的 operation+target（0 Jev）
  │     2) Jev：单请求 fan-out（operation + target + risk），risk 结果按目标缓存
  ├─ Executor          ref 重识别、交付语义（沿用）
  ├─ Settle            worker settle（事件）→ 一次观察；不支持时退回原来的轮询
  ├─ Verifier          no_overlay / value_equals / diff（沿用）
  └─ Memory writer     任务 done 后写入已验证轨迹；回放失配时标记并退回 Jev
```

## 2. 关键设计

### 2.1 事件驱动 settle（替代 60ms 全树轮询）

旧：每 60ms 一次完整 skeleton 遍历 + 候选编译 + now-playing，最多 900ms。
新：动作送达后发一次 `settle {timeoutMs, quietMs}`：

- worker 在当前线程为目标 pid 建 `AXObserver`，挂到当前 run loop；
- 注册应用级通知：`AXFocusedUIElementChanged`、`AXValueChanged`、`AXUIElementDestroyed`、`AXCreated`、`AXMenuOpened`、`AXMenuClosed`、`AXWindowCreated`、`AXSelectedChildrenChanged`、`AXSelectedTextChanged`、`AXTitleChanged`、`AXLayoutChanged`、`AXRowCountChanged`、`AXFocusedWindowChanged`、`AXMainWindowChanged`；
- 收到第一个事件后，再保持安静 `quietMs`（默认 90ms）就返回；首事件之后最多再等 `maxAfterFirstMs`；超时返回 `changed=false`；
- 一个通知都注册不上 → `supported=false`，引擎退回旧轮询，行为不变。

之后只做**一次**观察。静态界面可以从“N 次全树遍历”变成“1 次遍历 + 一段阻塞等待”。

### 2.2 now-playing 移出热路径

媒体事实只在每轮正式观察时读一次；settle 期间比较的是**树指纹** `treeFingerprint`，不再每次轮询都读 MediaRemote。

### 2.3 Risk 缓存

一次 fan-out 已经为每个 mutation 目标问过 undo risk。同一任务里，同一个 `(operation, 目标身份)` 的风险不会变，所以按 targetKey 缓存；下一轮如果目标全部命中缓存，就不再附带这些 risk 问题，请求更小、更快。

### 2.4 新元素标记（browser-use `*`）

动作之后，当前观察里身份键在上一轮观察中不存在的候选，会在 criteria 中带上 `new: "appeared after the last action"`。菜单项、弹窗按钮、搜索结果都是最常见的“下一步目标”，这个信号可以明显减少选错。

### 2.5 Affordance Memory（学出来的经验，不是特判）

```text
key   = app + normalize(redact(goal)) + slotIds
value = { steps: [{ operation, identity, slotId? }], successes, failures, updatedAt }
identity = targetKey 去掉 state / holds / local_match / new / at，并对 slot 值做 redact
```

- 只有 `status=done` 且全程没有 side_effect / uncertain 的轨迹才写入；DRILL / WIDEN / WAIT 不进入轨迹（它们只是观察手段）。
- 回放：第 i 步在**当前 offered 候选**里找 operation 与 identity 都一致的唯一候选，找到就直接执行，并照常走 settle + verify；风险门控不跳过：记录里这一步当时需要确认，这次仍然要确认。
- 失配（没有候选、多于一个候选、verdict≠通过）→ 立即退回 Jev 循环（self-heal），并记一次 failure；failure 超过 successes+2 次就删除这条记录。
- 回放完所有步骤后，仍然由 Jev 判断一次 DONE（1 次调用），不盲目宣布完成。
- 本地 JSON 存储：`~/.pi/agent/orbit-computer-use/memory.json`，`ORBIT_CU_MEMORY=0` 关闭。slot 的原值永不写盘。

### 2.6 指标

`metrics` 新增 `jevCalls`、`replayedSteps`、`settleMs`、`settleEvents`；trace 每步记录 `ms`、`source: "jev" | "memory"`。基准脚本 `scripts/bench-gui-task.ts` 直接驱动引擎，读取任务 JSON，输出成功率、耗时和 Jev 调用次数，用于前后对比。

## 3. 性能目标

| 场景 | V2 | V3 目标 |
| --- | --- | --- |
| 动作后等待（界面静止） | 最多 16 次全树遍历 | 1 次 settle + 1 次遍历 |
| 同一任务第二次执行 | 与第一次相同 | 只有 1 次 Jev（DONE 复核） |
| 每轮 Jev 请求体 | 每个 mutation 目标都附 risk | 已知 risk 的目标不再附带 |
| Chromium 首次开启无障碍 | 固定 sleep 2.2s | 150ms 轮询，树一出现就继续 |

## 4. 边界（不变）

- Jev 仍然只能从候选 ID 中选；不接收 ref、坐标或 slot 原值。
- 不重放交付状态不确定的动作；Memory 回放本身也要经过同样的交付语义和验证。
- 不写应用名或业务关键词特判；Memory 是运行时学到的缓存，结构变化时自动失配。

## 5. 实测（Jev-in-the-loop 模拟应用基准）

`scripts/bench-fixtures.ts`：真实引擎 + 真实候选编译 + **在线 Jev**，只有操作系统层是模拟的（`scripts/cu-fixtures/fixtures.ts`，按 xa11y worker 的输出格式渲染 AX 树，并用快照 ref 执行动作）。成功与否由应用自身状态判定，而不是 Jev 说 DONE。

14 个任务：计算器、音乐（同名“播放”按钮 + 区分 Live 版）、聊天（不能发错人）、设置、文件（菜单 + 不能误删）、只读查看、邮件（3 个字段 + 多行正文）、异步加载、40 行长列表、二次确认删除、自动补全、弹窗打断、目标已满足（不能乱点）、表单。

| 版本 | 通过 | 中位耗时 | Jev 调用/任务 |
| --- | --- | --- | --- |
| V3 初版（6 个任务） | 3/6 | 1432ms | 5.00 |
| V3 修正后（14 个任务 × 3 轮） | 14/14 ×3 | ~1.2s | 3.8 |
| + Affordance Memory 第二轮 | 14/14 | ~300ms | 1.00 |

`scripts/bench-selfheal.ts`：学会之后“应用更新”（按钮改名 + 列表重排），回放在变化的那一步停下，交回 Jev 完成，没有误操作；再下一次按新布局回放（1 次 Jev）。

基准暴露并修复的问题：
- `N items not shown` 在子项其实全部可见时也会输出 → Jev 反复滚动“显示更多”。改为“全部已观察 / 部分未显示”的真实事实。
- 同名控件（每一行都有“播放”）无法区分 → 新增 `in_item`（所在行的文字）。
- 可编辑 combo box（自动补全输入框）没有被当成文本框 → 无法输入。
- 操作头只能看到前 4 个目标名 → 目标名出现在目标里的优先展示（`goal_match`），长列表能想到 SCROLL_TO。
- 模态 sheet/alert 出现时仍给出其下方的控件 → 只给出 overlay 内的控件。
- A,B,A,B 循环（删除→确认→删除→确认）→ 第二次重复时警告，第三次停止。
- Memory 身份里含有列表位置和“containing …”内容摘要 → 列表重排就失配；改为只保留角色、标签、容器角色和能力。
- 回放时目标还在加载 → 先短暂重新观察，再决定是否放弃回放。
- 从 jev-ultrafast 借鉴的规则：“最近的 WAIT 不是正在加载的证据”“不要重复已经看得到结果的步骤”“不要选已经是目标值的字段或开关”。

测得的一个事实：Jev 的请求时延与并行问题数量基本无关（1 个 choice 和 1 choice + 19 个 noul 都约 300ms），因此 risk 继续随 fan-out 一起问，而不是拆成单独请求。
