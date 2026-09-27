# Computer Use V4 设计：少问、并行问、问一次做多步

> 前提（V3 实测）：14 个模拟任务全过；冷启动中位约 1.2s，每个任务约 3.8 次 Jev；有 Memory 时约 0.3s，1 次 Jev。
> **Jev 一次约 300ms，占冷启动耗时的 80% 以上。** 并行问题数量对延迟几乎没有影响（1 个问题和 20 个问题都约 300ms）。
> 所以 V4 的核心只有一句话：**减少 Jev 往返次数，而不是缩小每次请求。**

---

## 0. 开源项目调研结论

| 项目 | 读到什么程度 | 值得学的 | 不学的 |
| --- | --- | --- | --- |
| **browser-use/jev-ultrafast** | 核心代码全读 | 一次请求同时出 operation 头和每种操作的 target 头（和我们一致）；按作用域做新鲜度检查（只比较目标及附近上下文，动画不作废决策）；输入到 combobox 后专门等建议出现（上限 200ms）；执行前记录，不重放 mutation；DONE 不作为成功证据 | 用小 LLM 生成输入文字（我们由 Pi 提供 textSlots，更安全） |
| **browser-use/browser-use-pi**（ultrafast 模式） | `ax.ts` 全读 | 紧凑的 `[id] role "name" = value` 状态表示；`*` 标记新元素；**事件驱动等待 = 网络空闲 + DOM 静默 quietMs + 上限**；每个动作只回一行 `navigated / page changed / no change`；“把已经知道的连成一次调用” | 让模型写 JS（慢，而且不受约束） |
| **browser-use/macos-harness** | SKILL 全读 | **“把确定、可逆的步骤打包成一次执行，最后只验证一次”**；在真正的决策边界才停：身份有歧义、不可逆、状态出乎意料；失败一次就换模式，不重复按键修补 | 让 LLM 直接发原始坐标 |
| **browser-use/workflow-use** | schema / executor 读过 | 语义化工作流：`target_text` + `container_hint` + `position_hint`，不用选择器；**把录下来的值抽成变量**，同一条流程可以换参数重跑；单步失败时交回 agent | 录制器、选择器兜底策略 |
| **trycua/cua-driver** | jev-use、动作结果契约、后台输入计划、invoke_menu | **ActionResult 契约**：`effect = confirmed / partial / unverifiable / suspected_noop / refused` + `escalation`（pixel / foreground）；后台输入顺序：语义 AX → 精确窗口指针 → PID 键盘，都不安全就拒绝；AX 启用按 pid + 进程启动时间缓存；菜单项按路径调用 | MCP 大工具面 |
| **openclaw/Peekaboo** | 架构文档、UI/观察服务目录 | `AXMutationObservation`：动作后只读焦点元素的 identity / value / selection 做局部核对，不重扫全树；`BackgroundInputDriver`：按 PID 投递 CGEvent，不抢前台、不移动光标；WindowTracker：AX 通知 + 低频轮询 | 视觉 OCR 管线 |
| **stagehand** | actService / cacheService | act cache：缓存命中就确定性重放，失败即回到推理（就是 self-heal） | 服务端缓存 |
| **microsoft/UFO** | 结构和 README | GUI + 原生 API 混合执行器；经验检索 | 多代理编排（太重） |
| **OpenAdapt** | README | 演示编译成程序，重放时不调用模型，只在声明的效果验证通过后才报 VERIFIED | 人工准入流程 |
| terminator / macOS-use / OmniParser | 浏览 | terminator：`ui_tree_diff`、选择器 DSL；macOS-use：早期简单版本 | 以视觉为主的路线 |

**结论：** 我们的“本地编译候选 + Jev 选 ID + 本地验证”和做得最好的两家（jev-ultrafast、cua jev-use）边界完全一致。
V4 不需要改骨架，重点补四件事：**多步一次决策、确定性短路、参数化记忆、后台/菜单通道**。


---

## 附：jev-ultrafast 深读（git submodule：`references/jev-ultrafast`）

仓库只有 3 个提交，但两份 `performance*.md` 和两份测量 JSON 把每次尝试（包括失败）都记了下来，比代码本身更有价值。

### 1. 它的演进路线（从历史文档还原）

| 阶段 | 做法 | 结果 |
| --- | --- | --- |
| prepared 原型 | 人工写 5 个有序子目标，直接从目标里拷贝引号中的城市名 | 12.9s，17 次 Jev；作者自己判定“不算真正的 agent” |
| 第一版动态策略（68c077b） | **flat-choice + lookahead + Noul → 改成 operation 头 + 每操作 target 头** | 11.4s，23 次 Jev |
| 第二版（452c1ad） | 同样的决策结构；只改运行时：一次 JS 调用完成观察、按作用域做新鲜度检查、combobox 专门等待 | 7.1s，17 次 Jev；CDP 调用 1092 → 101 |

**关键结论：它试过 lookahead，放弃了。** 公开记录没有写原因，但设计文档说明了取而代之的思路：“operation/target 分布取代 flat-choice/lookahead/Noul”。
**第二次提速 25% 完全来自运行时，决策结构没动。** Jev 次数从 23 降到 17，主要是因为不再因为动画作废决策（stale 决策会白白多问一次）。

### 2. 对 V4 的修正

- **方案 A（lookahead）降级为实验项**，排到 B、C、D、E 之后，而且必须有严格的 A/B 对比数据才能合入。
  本质原因：TypeSafe 的头彼此独立，“第 2 步是什么”这个头看不到“第 1 步会选什么”，只能靠同一份当前状态去猜，而第 2 步本来就依赖第 1 步的结果（弹出的建议、页面跳转）。
  可行的是**窄化版**：只在“一个持久控件簇内的纯序列”（键盘、按钮簇）且下一步目标在动作后仍然可见时使用，并由守护兜底。
- **把“避免作废决策”列为一等目标**。它的经验：严格的全页 DOM 标记（任何 mutation 都作废）导致大量白问；放宽到“只看目标 + 附近上下文 + 表单值”后又出过一次事故——菜单动画状态被送给模型，模型选了 BLOCKED（performance-prepared 第 3 次尝试）。最终方案：**点击类动作用作用域守护，DONE / 文本类用完整语义比较**，几何在执行前重新读取并做遮挡检测。
  对应到我们：ledger 在每次观察后只授权一次动作（`consumed`），相当于最严格的全局标记。可以改为：执行前按目标身份重新识别（已有 `matches_live`），并只比较目标及其所在行或表单的语义。这样同一次观察可以支撑多个动作（也是方案 A 的前提）。
- **combobox 等待**：输入之后等“可见的 option 出现”，上限 200ms；其他交互最多等两帧或 50ms。我们的 settle 对应改为：动作类型决定等待谓词（输入 combobox → 等 list/menu 出现；普通点击 → 第一个事件加 quiet）。
- **规则同时给 operation 头和 target 头**（它修过的一个 bug：target 头没有 next-step 规则，导致在筛选条件没设完之前就打开了结果）。我们现在 target 头的规则比 operation 头少很多，应该共享同一套“下一步规则”。
- **target criteria 里直接带 checked / selected / current_value**（我们放在 `state` 字段里，已经有了）。
- **“不要把 WAIT 当成加载证据”“提交搜索和只填了搜索框不一样”“匹配的结果出现不代表筛选已经设好”**：已经加了前两条，第三条（筛选、过滤）也应该加入。
- **测试契约**（`tests/test_agent.py`，值得照搬成我们的单元测试）：
  - 非法 choice（未知 ID、NaN、缺项、负值、非最大值、confidence 越界）必须拒绝，并且什么都不执行 —— 我们有 `validateChoice`，但缺少参数化测试。
  - CLICK 不能消费 TYPE_TEXT 的目标（头之间互不串用）。
  - 作废的决策在任何 mutation 之前就被消费掉（不可能重试同一个决策）。
  - 执行后观察失败，已执行的动作仍然保留在历史里。
  - WAIT 不会触发“无进展”停止。
- **它没有、而我们有的**：本地文本槽（不需要文字生成模型，也不会把用户文本发给第三方）、风险确认、Memory、只读模式、AX 桌面应用。它只管浏览器，也不做不可逆动作的确认。

### 3. 数据：它每次 Jev 的时延

Flights 录像里 17 次请求，中位 178ms（我们测到约 300ms，差别可能来自它使用 httpx HTTP/2 连接池，也可能是地理位置或服务端负载）。**值得测一下我们的 SDK 是否复用了连接、是否使用 HTTP/2**：如果每次都重新握手，每次调用会多 100ms 以上。

---

## 1. 优化清单（按“每个任务省几次 Jev”排序）

| # | 优化 | 依据 | 预计收益 | 风险 |
| --- | --- | --- | --- | --- |
| **A** | **Lookahead 多步头（实验，窄化）**：只用于持久控件簇内的纯序列 | macos-harness “burst”；**jev-ultrafast 试过并放弃了通用版** | 计算器 8→3 次 | 高：必须 A/B 对比后才能合入 |
| **A0** | **单次观察支撑多次动作 + 作用域新鲜度**：ledger 不再每次动作后作废整次观察 | jev-ultrafast 第二版提速的主要来源 | 减少作废决策和重复观察 | 中 |
| **A1** | **Jev 连接复用 / HTTP/2 检查** | jev-ultrafast 中位 178ms，我们约 300ms | 每次调用可能省 100ms 以上 | 低 |
| **B** | **完成预测头**：“这一步执行成功后目标是否全部完成” + 本地证据 → 省掉最后一次 DONE 调用 | cua 的 effect/postcondition 分离 | 每个任务 −1 次（约 25% 耗时） | 中（需要强证据门槛） |
| **C** | **忙碌感知的 settle**：界面有 progress/busy 指示或 `AXElementBusy` 时继续等（有上限） | browser-use-pi 的网络空闲等待；jev-ultrafast 的 combobox 等待 | 异步类任务 −1 次（WAIT） | 低 |
| **D** | **确定性短路**：只剩一个前进候选；回车提交（风险已知且低） | V2 设计 | 偶尔 −1 次 | 低 |
| **E** | **参数化 Memory**：goal 中的标签抽成变量（“打开{X}的名片”），换参数也能回放 | workflow-use 变量抽取 | 同类任务第 2 次起 1 次 Jev | 低（唯一匹配守护） |
| **F** | **菜单栏通道**：菜单项（含快捷键）作为已声明、有文字的候选 | cua invoke_menu、Peekaboo | 无标签工具栏的应用成功率大幅提升 | 低 |
| **G** | **后台输入**：PID 路由 CGEvent，不激活、不抢焦点 | cua、Peekaboo、macos-harness | 每个 headed 动作省掉激活（约 100–300ms）且不打扰用户 | 中（私有 SkyLight 接口可选） |
| **H** | **局部核对**：动作后先读目标及焦点元素的 value / focus / selection，不够再读全树 | Peekaboo AXMutationObservation | 真实应用每步约 −100–200ms | 低 |
| **I** | **ActionResult 契约统一**：`effect` + `escalation` 取代零散的 verdict / changed / delivery | cua | 可维护性、可诊断性 | 低 |
| **J** | 基准扩展 + 真机通道 + hill-climbing | browser-use-pi eval | 防回归 | — |

---

## 2. 关键设计

### A. Lookahead 多步头（最大收益）

TypeSafe 的问题彼此独立、并行评估，一个头读不到另一个头的答案。所以不能写“假设第 1 步是 X，第 2 步是什么”，但可以问：

```text
operation            (现有)
<op>_target          (现有)
next_2_target        "按目标顺序，从现在起的第 2 个 CLICK 目标是哪个？另一个问题会决定第 1 个。"
next_3_target        "……第 3 个……"
```

- **只对“持久候选集”开启**：同一次观察中，operation=CLICK/CHECK/SET_VALUE，且目标集合在动作后通常不变（按钮簇、键盘、表单字段）。每个 lookahead 头的选项里带一个 `stop`（“需要先看结果再决定”）。
- **执行守护**（全部满足才继续下一步，否则回到正常循环）：
  1. 上一步已送达并通过验证（没有 side_effect / no_effect）；
  2. 界面 surface 没变（没有新 overlay 或 sheet）；
  3. 下一步目标用身份在新观察中**唯一**找到；
  4. 该头的置信度 ≥ 0.85，并且不是 `stop`；
  5. 下一步的风险已知且 < 0.5（未知就先问，不跳过确认）；
  6. 两步之间 diff 里没有出现目标以外的“新”元素（弹窗、错误提示）。
- 效果：计算器“AC,1,2,+,3,0,=”一次请求给出 1+2 步，每次只要一次 settle。

### B. 完成预测头

在 step 请求里加一个 noul：`completes_goal`，“如果选中的这一步按预期生效，整个目标是否就完成了？”
动作执行后满足以下**全部**条件，直接 `done`（`goalVerified="predicted+evidence"`），不再额外问一次 Jev：

- `completes_goal ≥ 0.9`；
- 动作送达且有正向证据：value_equals 通过、diff 非空，或 media 状态符合预期；
- 所有 textSlots 都已交付；
- 没有新的 overlay 或 alert（新出现的“确认删除？”说明还没完成）；
- 这一步不是 DRILL / SCROLL / FOCUS 这类观察性操作。

任何一条不满足就走原来的 DONE 询问。回放（Memory）的最后一步同样适用。

### C. 忙碌感知的 settle（worker）

`settle` 在收到第一个事件后，如果树中存在 `AXBusyIndicator` / `AXProgressIndicator`，或 `AXElementBusy=true` 的元素，就继续等到它消失或达到 `busyCapMs`（默认 3000）。
可编辑 combobox 输入后，额外等待“新出现的 list / menu”（上限 200ms，照搬 jev-ultrafast）。

### E. 参数化 Memory

学习时，对每一步：如果目标标签（`what` 里的引号内容）出现在 goal 里，就把 goal 中这段文字换成 `{v1}`，步骤身份里的标签也换成 `{v1}`。
key = 模板化的 goal。回放时用同一模板匹配新 goal，解出 `v1`，把 `{v1}` 代回步骤身份，要求在当前候选中唯一匹配。
防误用：变量值必须在新观察里**逐字**作为标签出现，否则放弃回放（交回 Jev）。

### F. 菜单栏通道

worker 新增 `menubar`：读取 `AXMenuBar` 的一级和二级菜单，包括标题、enabled 和 `AXMenuItemCmdChar`，按 pid + 窗口标题缓存。
候选：`MENU_ITEM path="编辑 > 查找 > 查找…" shortcut=⌘F`，evidence=declared。执行时逐级 AXPress（照 cua invoke_menu）。
只在当前窗口候选里没有同名控件时才加入，避免重复。

### G. 后台输入（可开关）

路由顺序照 cua：语义 AX 动作 → PID 路由的指针事件（带窗口本地坐标）→ PID 路由的键盘事件。三者都证明不了精确投递时，返回 `refused` 并给出 `escalation=foreground`，由引擎决定是否激活应用。
SkyLight `SLEventPostToPid` 属于私有接口，放在编译开关后面，默认使用公开的 `CGEventPostToPid`。

### H. 局部核对

动作返回 `post_state` 时同时读取目标元素和焦点元素的 value / focused / selected。引擎先用这些做 value_equals 和 no_effect 判断；只有需要候选列表时才读全树。
（真实应用上一次全树遍历约 100–250ms；模拟基准测不出这部分收益，需要真机验证。）

### I. ActionResult 契约

```ts
type ActionResult = {
  effect: "confirmed" | "partial" | "unverifiable" | "suspected_noop" | "refused"
  route: "accessibility" | "pointer" | "keyboard" | "menu" | "media"
  evidence: { kind: "value_readback" | "tree_diff" | "window_change" | "media_state"; detail: string }[]
  escalation?: { target: "foreground" | "pointer" | "drill"; reason: string }
}
```

现有的 `verdict`、`changed`、`delivery` 和 settle 报告统一映射到这里；Jev 的 recentActions 只显示一行 `effect + 证据摘要`。

---

## 3. 落地顺序

| 阶段 | 内容 | 验收（模拟基准 + 在线 Jev） |
| --- | --- | --- |
| V4.1 | A1 连接检查 + B 完成预测头 + C 按动作类型等待（含 combobox）+ D 短路 + target 头共享规则 | 14/14，Jev/任务 3.8 → ≤ 2.9 |
| V4.2 | A0 作用域新鲜度 + 窄化 lookahead（开关，A/B 对比） | 计算器 ≤ 3 次；violation=0；否则不开启 |
| V4.3 | E 参数化 Memory | 换参数的同类任务第 2 次起 1 次 Jev；自愈基准通过 |
| V4.4 | F 菜单栏、H 局部核对、I 契约 | 新增 3 个菜单类模拟任务；真机基准 |
| V4.5 | G 后台输入 | 真机：不抢前台、光标不动 |

每个阶段都要求：旧单元测试全绿、模拟基准 3 轮全过，且 `violation` 永远为 0。


---

## 4. 实施结果（V4 已落地部分）

基准：`scripts/bench-fixtures.ts`（16 个模拟应用任务，真实引擎 + 在线 Jev），`scripts/bench-params.ts`（参数化记忆），`scripts/bench-selfheal.ts`（界面变更后自愈）。

| 指标 | V3 末 | **V4** |
| --- | --- | --- |
| 冷启动通过率 | 14/14 | **16/16 × 3 轮**（新增“两个开关不能提前结束”和“菜单栏导出”） |
| 冷启动 Jev/任务 | 3.79 | **3.06–3.13**（−18%） |
| 冷启动中位耗时 | ~1.2s | ~1.2s（任务更难，Jev 次数更少） |
| 同一任务第二次（Memory） | 1.00 Jev，~300ms | **0.50 Jev**，~300ms（回放的最后一步也能按预测完成） |
| 换参数的同类任务 | 与冷启动相同 | **0–1 次 Jev**（学会“给李四发消息”后，“给王五发消息”直接回放） |
| 误操作（violation） | 0 | **0** |

已实现：

1. **共享下一步规则**：operation 头和所有 target 头使用同一套 `NEXT_STEP_RULES`（jev-ultrafast 修过的问题），并新增“设置完筛选再打开结果”“填写搜索框不等于提交搜索”。删除了已废弃的 `decideDesktopLegacy`。
2. **完成预测头 `completes_goal`** + 本地证据门槛（值读回 / 界面有变化且没有新的 alert 或错误文字 / 所有文本槽已交付 / 没有新 overlay）→ 省掉最后一次 DONE 询问。阈值 0.75（实测：真正完成的一步 Jev 给 0.78–0.87，未完成的给 0.04–0.17）。“两个开关”陷阱测试证明它不会在第一步后提前结束。
3. **忙碌感知的 settle**：出现 progress/busy 指示时继续观察（上限 3s）；在自动补全框输入后等待建议列表出现（上限 300ms）。异步搜索任务从 5–6 次降到 4 次 Jev。
4. **参数化 Affordance Memory**：从“在同形兄弟中选中、并且标签原样出现在目标里”的步骤学出模板变量；新目标匹配模板后绑定变量回放，绑定值必须在当前界面中唯一匹配。回放可以按布局插入或跳过 SCROLL_TO（目标在不在视口里取决于列表位置）。
5. **菜单栏通道 `MENU_ITEM`**：Rust `read_menu_bar` / `press_menu_path`（每一级都从活的菜单栏重新解析，每一段必须唯一且 enabled，照搬 cua invoke_menu 的做法）；按窗口标题缓存 5 秒，任何 mutation 后失效；跳过 ⌘Q 和与窗口控件同名的命令。只有图标的工具栏任务一次 MENU_ITEM 就完成。
6. **窄化 lookahead（实验，默认关闭）**：`click_next_N` 头 + 六重守护（上一步可见生效、surface 不变、目标唯一、置信度 ≥ 0.8、风险已知且低、不重复上一步）。
   **A/B 结果：16 个任务里一次都没有触发**（全部被守护拦下：预测的序号会漂移、置信度偏低），额外的头反而让 Jev/任务从 3.13 升到 3.31。与 jev-ultrafast 放弃 lookahead 的结论一致。代码保留（`ORBIT_CU_LOOKAHEAD=N` 或 `input.lookahead`），默认关闭。

未做（需要真机）：局部核对（H）、后台输入（G）、ActionResult 契约统一（I）。这几项在模拟环境里测不出收益，需要在有辅助功能权限的真机上验证。
