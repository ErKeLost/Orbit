# Computer Use V2 架构设计：有证据的动作 + 按预期验证 + 分层降级

> 状态：设计稿。触发案例：汽水音乐“播放”误触“更多”菜单，并且长时间空转。

## 0. 问题复盘

| 现象 | 根因 | 所在层 |
| --- | --- | --- |
| 双击到“⋮”，弹出菜单 | 候选编译器把“可聚焦、有子节点、高度 ≤120、带文字”的匿名 group 当成列表行，生成了 `DOUBLE_CLICK` | 候选编译 |
| Jev 选中这个候选 | 候选描述里写着 “open or play this list item”，而且这个动作是**猜出来的**。Jev 无法区分哪些动作有依据、哪些是猜的 | 候选契约 |
| 点错了却没发现 | 验证只看 AX 指纹变没变。菜单弹出算“有变化”，被当成进展 | 验证 |
| 耗时很长 | 失败后不撤销、不记住错误目标、不换通道；要连续三次无变化才停 | 恢复与调度 |
| 真正能用的通道没被使用 | 系统媒体命令、菜单栏、应用声明的快捷键都不在候选空间里 | 通道 |

结论：这不是模型的问题，而是**架构缺少四样东西：动作依据、预期效果、副作用检测、通道降级**。
用关键词黑名单（`音质|上一首|\d:\d\d`）属于应用特判，**不采用**。

---

## 1. 设计原则

1. **动作必须有依据**：每个候选都标注依据等级（语义 / 声明 / 结构 / 几何 / 视觉）。等级越低越排在后面，用之前也要满足越多前置条件。
2. **先走意图、再走界面**：能通过系统或应用声明的接口完成的任务，就不去点像素。
3. **每个动作都带预期**：执行前说明“应该发生什么”，执行后用**对应的信号源**核对，不能只看 AX 树变没变。
4. **点错立刻纠正**：检测到副作用就撤销，记住错误目标，然后换通道，不再原地重试。
5. **决策尽量确定化**：只有真正有歧义时才调用 Jev。确定性路径不消耗模型轮次。
6. **只沉淀经验，不写特判**：按 `bundleId + 结构签名` 记住“这个应用里什么方法有效”。这是学出来的缓存，不是硬编码规则。

---

## 2. 总体架构

```text
gui_task(goal, app, textSlots, budget)
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ① Intent Resolver   目标 → 结构化意图（一次 Jev Choice，   │
│                     或本地规则确定性匹配）                 │
│    media.play / media.next / navigate / send_text /      │
│    open_item / toggle_setting / generic                  │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ② Channel Router    按意图生成“通道计划”（有序降级梯）     │
│    L0 Intent API → L1 AX 语义 → L2 菜单/快捷键            │
│    → L3 结构化物理 → L4 视觉（可选）                      │
│    先查 Affordance Memory：命中就直接走已验证过的通道     │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ③ Sensors（多源观察）                                     │
│    AX 树(skeleton/drill/diff) · 菜单栏 · 系统 NowPlaying  │
│    · 前台/焦点/窗口列表 · (可选)局部截图                  │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ④ Affordance Compiler   观察 → 带依据/预期的候选          │
│    Candidate{op, target, channel, evidence, expect, cost} │
│    结构推断：列表行、按钮簇、覆盖层、主内容区             │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ⑤ Decider   确定性短路 ▸ 否则 Jev Choice（只在当前        │
│             通道层内选目标，不跨层乱选）                  │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ⑥ Executor   ref 重识别 · actionability · 交付语义        │
│             （沿用 agent-desktop / xa11y 的现有能力）     │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ⑦ Verifier   按 expect 选对应信号源核对                   │
│    → achieved | no_effect | side_effect | uncertain       │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ ⑧ Recovery   side_effect → 撤销(Esc/Back) + 禁用目标      │
│              no_effect  → 同层换目标 / 升级下一层         │
│              uncertain  → 停止，needs_review（不重放）    │
│              achieved   → 写 Affordance Memory → 下一步   │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 各层详细设计

### ① Intent Resolver

- 输入：goal 文本。输出：`{ kind, args, successPredicate }`。
- 一次 Jev Choice，从固定的意图类型里选。选不出来时返回 `generic`，走通用 UI 循环。
- 每种意图自带**成功谓词**，完成判定不再全靠 Jev 看截图文字说 DONE：

| kind | successPredicate（信号源） |
| --- | --- |
| `media.play` / `media.pause` | NowPlaying.state，并且 NowPlaying.bundleId == 目标应用 |
| `media.next` / `media.prev` | NowPlaying.title 发生变化 |
| `media.play_item(q)` | NowPlaying.title/artist 包含 q，并且 state=playing |
| `send_text(to, slot)` | 会话区出现 slot 文本的新消息，并且输入框已清空 |
| `navigate(target)` | 窗口标题 / 选中项 / 主内容区锚点符合 target |
| `generic` | Jev DONE，并做一次复核（沿用现有逻辑） |

### ② Channel Router：通道降级梯

| 层 | 通道 | 依据 | 典型耗时 | 前置条件 |
| --- | --- | --- | --- | --- |
| **L0** | Intent API：系统 MediaRemote 命令、`open` URL scheme | 系统或应用声明 | <100ms | 意图属于媒体/URL 类；执行前后都校验 NowPlaying 属于目标应用 |
| **L1** | AX 语义动作：Press / Activate / SetValue / Toggle | 控件自己声明 | 50–200ms | 元素确实暴露了该 action |
| **L2** | 菜单栏条目 / 条目上标注的快捷键（`AXMenuItemCmdChar`） | 应用声明，而且带文字 | 100–300ms | 菜单项 enabled，文字能和意图匹配 |
| **L3** | 结构化物理点击 | 结构推断（见 ④） | 200–500ms | 目标是**叶子节点或经过结构推断的控件**，不是容器 |
| **L4** | 视觉定位（局部截图，只截目标区域） | 视觉 | 1–3s | L0–L3 都用完；可以关闭 |

规则：

- Router 给每个意图生成**有序通道计划**，而不是把所有候选混在一起交给 Jev。
- 只有当前层用完（全部 `no_effect` / `side_effect`，或没有候选），才升级到下一层。
- L3 和 L4 的动作都附带 `speculative=true`，执行后**必须**验证，不能跳过。

以“汽水音乐：播放”为例：

```text
L0: NowPlaying.bundleId == 汽水音乐 ? → MediaRemote.play → 校验 state=playing ✔ 结束（约 150ms，0 次 Jev）
   否则 ↓
L2: 菜单栏里找到 “播放/Play” enabled → AXPress → 校验 ✔
   否则 ↓
L3: 在按钮簇里选出主按钮（居中、面积最大的那个）→ 单击 → 校验
```

### ③ Sensors

| 信号源 | 内容 | 实现 |
| --- | --- | --- |
| AX skeleton / drill | 现有能力 | `snapshot` |
| **AX diff** | 前后两次的结构化差异：新增或消失的覆盖层、焦点变化、value 变化、新增节点 | 新增。用来替代单一的指纹比较 |
| **MenuBar** | 应用菜单树：标题、enabled、快捷键 | 新增 `menubar --app`，按应用缓存，菜单结构变化时失效 |
| NowPlaying | title / artist / state / **bundleId** | 已有 `now_playing.rs`，**补充 bundleId** |
| Focus / Window | 前台应用、焦点元素、窗口列表 | 已有部分能力 |
| 局部截图（可选） | 只截某个 bounds 区域 | L4 才启用 |

### ④ Affordance Compiler：候选契约升级

```ts
type Candidate = {
  id: string
  op: Operation                 // 新增 MEDIA_COMMAND, MENU_ITEM, KEY_CHORD, UNDO
  target?: TargetRef
  channel: "L0" | "L1" | "L2" | "L3" | "L4"
  evidence: "declared" | "semantic" | "structural" | "geometric" | "visual"
  speculative: boolean          // L3/L4 = true
  expect: Expectation[]         // 预期效果，由 Verifier 核对
  cost: number                  // 预估耗时和风险，用于排序
  description: string           // 给 Jev 的描述：不能写没有依据的语义
}
```

**结构推断（全部与应用无关，不用关键词）：**

1. **ListRow（列表行）**：满足以下全部条件才算列表行，也只有列表行能拿到 `DOUBLE_CLICK`：
   - 祖先是可滚动容器，或者是 `list` / `table` / `outline`；
   - 至少 3 个“同形兄弟”：role、能力、高度都相同（±10%）；
   - 纵向排列。
   > 播放栏不在滚动容器里，也没有同形兄弟，**天然不满足**，不需要任何黑名单。
2. **ControlCluster（按钮簇）**：一组横向排列、尺寸相近的小叶子节点（面积 ≤ 64×64，间距均匀）。簇里每个成员带上几何描述：
   `第 2/3 个，簇中心，面积最大，位于窗口底部中央`。
   Jev 根据“播放通常是簇中心最大的那个”这样的**通用常识**来选择，而不是由代码硬编码。
3. **Container（容器）**：有子节点、没有声明 action 的 group，**只能 DRILL，不能点击**。这条规则直接修掉了这次的 bug。
4. **Overlay（覆盖层）**：menu / popover / sheet。记录它是不是本任务的动作触发的，触发时间和触发者是谁。

**描述规则**：description 里只写观察到的事实（role、文字、位置、结构），**不写“open or play”这类推测出的用途**。推测只放在 `speculative` 和 `evidence` 字段里，由 Decider 按依据等级来使用。

### ⑤ Decider

```text
if 意图有 L0 候选且前置条件成立          → 直接执行，不调用 Jev
elif 当前层只有 1 个候选且 expect 明确    → 直接执行
elif Affordance Memory 命中且结构签名一致 → 直接执行记住的通道和目标
else                                       → Jev Choice（只在当前层内选）
```

- 给 Jev 的候选**按层分组**，禁止它跳过 L1 去选 L3。
- 被禁用名单里的目标不再出现在候选中。
- Jev 的上下文里带上最近的验证结论（例如“上一步 side_effect：弹出菜单，已撤销”），而不只是 “changed=true”。

### ⑥ Executor

沿用现有的 ref 重识别、actionability 和 `disposition.delivery/retry` 语义。新增：

- `media-command play|pause|toggle|next|prev`（Rust，MediaRemote `MRMediaRemoteSendCommand`）
- `menu-press <menuPath>`（AXPress 菜单项）
- `key-chord <chord> --app`（只用于菜单里声明过的快捷键，不允许凭空编造组合键）
- `undo-overlay`（Esc，或者点击覆盖层外部）

### ⑦ Verifier：按预期验证

```ts
type Expectation =
  | { kind: "media_state"; state: "playing" | "paused"; bundleId: string }
  | { kind: "media_track_changed" }
  | { kind: "overlay_opened"; role?: string }     // 预期会弹菜单的动作
  | { kind: "no_overlay" }                        // 默认：普通点击不应该弹菜单
  | { kind: "value_equals"; ref: string; slotId: string }
  | { kind: "focus_on"; ref: string }
  | { kind: "node_appeared"; anchor: string }
  | { kind: "selection_changed"; container: string }
```

判定流程：

1. 用**事件驱动**的方式等待状态稳定（AX 通知或短轮询，上限 900ms）。满足 expect 就立即返回，不固定 sleep。
2. 结论：
   - `achieved`：expect 全部满足；
   - `side_effect`：出现了 expect 以外的覆盖层、窗口或导航，**这就是“点错了”**；
   - `no_effect`：没有相关变化；
   - `uncertain`：交付不确定（沿用现有语义）。

这次的案例：点击后出现了 `menu`，而 expect 里是 `no_overlay`，立刻判为 `side_effect`。

### ⑧ Recovery

| 结论 | 处理 | 耗时预算 |
| --- | --- | --- |
| `achieved` | 写入 Affordance Memory；如果满足意图的成功谓词，就 DONE | — |
| `side_effect` | ① `undo-overlay`（Esc）并验证覆盖层已关闭；② 把目标 ref、结构签名和 bounds 加入本任务禁用名单；③ 同层还有候选就继续，否则升级 | 1 次撤销 |
| `no_effect` | 禁用该目标，**立刻**换候选或升级。不再等连续三次 | 0 次重试 |
| `uncertain` | 停止，返回 needs_review，不重放（沿用现有语义） | — |

终止条件：通道梯全部用完才返回 `blocked`，并附带每一层的失败原因。**不是一出现歧义就阻塞。**

### Affordance Memory（学出来的经验，不是特判）

```text
key   = bundleId + intentKind + structuralSignature(目标区域)
value = { channel, targetDescriptor, successCount, failCount, lastVerifiedAt }
```

- 只有验证结果为 `achieved` 的动作才写入；`side_effect` 会记一次失败。
- 下次执行同一意图时，如果命中缓存且结构签名一致，直接走记住的通道，0 次 Jev。
- 结构签名不一致（应用更新了）时缓存自动失效。存储在本地，不上传。

---

## 4. 性能目标

| 场景 | 当前 | 目标 |
| --- | --- | --- |
| 媒体播放/暂停（L0 可用） | 多轮 Jev，数十秒 | **<300ms，0 次 Jev** |
| 媒体控制（只能走 L2 菜单） | — | <800ms，≤1 次 Jev |
| 第二次执行同一意图（命中 Memory） | 和第一次一样 | <500ms，0 次 Jev |
| 点错后恢复 | 连续三次无变化才停 | 1 次撤销加 1 次换通道，<1.5s |
| 通用 UI 任务每一步 | 观察 + Jev + 执行 + 固定 settle | 观察用 diff，settle 满足预期即返回 |

每一步都记录这些指标：`channel`、`evidence`、`verdict`、`jevCalls`、`ms`，写进 trace，方便做回归对比。

---

## 5. 与现有代码的映射

| 模块 | 改动 |
| --- | --- |
| `gui-task-contract.ts` | Candidate 增加 `channel/evidence/speculative/expect/cost`；新增 op：`MEDIA_COMMAND/MENU_ITEM/KEY_CHORD/UNDO`；新增 `Intent`、`Verdict` 类型 |
| `intent-resolver.ts`（新） | goal → Intent + successPredicate |
| `channel-router.ts`（新） | Intent → 通道计划；查询 Affordance Memory |
| `desktop-observation.ts` | 拆成 Sensors 和 Affordance Compiler；实现 ListRow / ControlCluster / Container / Overlay 结构推断；**删除“匿名 group → DOUBLE_CLICK”的旧规则和 `isTransportChrome`**；description 只写事实 |
| `verifier.ts`（新） | Expectation 核对；AX diff；判定 side_effect |
| `gui-task-engine.ts` | 循环改成 `route → compile → decide → execute → verify → recover`；用 verdict 驱动升级，替代“三次无变化” |
| `jev.ts` | 候选按层分组；上下文带上 verdict 历史 |
| `affordance-memory.ts`（新） | 本地 KV（JSON 或 sqlite） |
| `src-tauri/src/now_playing.rs` | 返回 bundleId；新增 `send_command` |
| `src-tauri/src/bin/ax_control.rs` | 新增 `media-command`、`menubar`、`menu-press`、`key-chord`、`undo-overlay` |

## 6. 分阶段落地（每个阶段都可以单独验收）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0 止血** | 回滚 `isTransportChrome`；Container 只能 DRILL；DOUBLE_CLICK 只给结构化 ListRow；默认 `no_overlay` 预期、出现覆盖层就 Esc 撤销并禁用目标 | 用汽水音乐的 AX fixture 断言：不生成对容器的点击；误弹菜单后能撤销 |
| **P1 通道** | L0 媒体命令（含 bundleId 校验）；L2 菜单栏 sensor 加 menu-press；Router 降级梯 | 汽水音乐“播放”：0 次 Jev，<300ms；NowPlaying 不属于目标应用时降到 L2 |
| **P2 验证** | Expectation 和 Verifier 全面接入；AX diff；按 verdict 驱动恢复 | 聊天发送、列表打开、设置切换这些已有测试全部通过，并新增 side_effect 用例 |
| **P3 结构** | ControlCluster 几何描述；事实化 description | 在 3 个无标签应用 fixture 上首选命中率 ≥95% |
| **P4 记忆** | Affordance Memory 与结构签名 | 第二次执行 0 次 Jev |
| **P5 可选** | L4 局部视觉 | 单独开关，单独度量 |

## 7. 不做的事

- 不做应用名或业务关键词黑白名单。
- 不用 osascript / System Events 驱动界面（L0 只调用系统框架 API，L2 只 AXPress 应用自己声明的菜单项）。
- 不凭空编造快捷键，只使用菜单里声明过的。
- 不重放交付状态不确定的动作。

## 8. 参考：Codex `cua_repl` 可借鉴点

| 对方做法 | 吸收方式 | 阶段 |
| --- | --- | --- |
| 动作后默认只返回 AX **diff**（新增/删除/变化） | Verifier 的 AX diff；同时作为 Jev 上下文，替代整棵树，省 token | P2 |
| 观察接口**内置自动等待**，禁止固定 sleep | 已有 settle 轮询，改为满足 expect 立即返回 | P2 |
| 确定性动作**批量执行**后一次观察（click+type+Enter+state） | 新增宏步骤：`TYPE_TEXT→PRESS_ENTER`、`DISMISS→重观察` 等可预测链路一轮完成，少一次 Jev | P2 |
| AX 不可用时**截图+坐标**兜底 | 即 L4，局部截图，单独开关 | P5 |
| `performSecondaryAction`：暴露元素**全部真实 AX action**（ShowMenu/Increment/Cancel…），不猜名字 | 候选编译器透传非标准 action 为 `AX_ACTION` 候选 | P3 |
| `pressKey` 任意按键 | 只开放通用导航键（Esc/Tab/方向键/Space）；组合键仅限菜单声明的快捷键 | P1 |
| macOS `paste`：剪贴板粘贴后**恢复原剪贴板** | Electron 输入框 TYPE_TEXT 失效时的第三条文本通道 | P2 |
| App 清单带 `isRunning/lastUsed/useCount` | resolver 歧义时作为排序事实 | P1 |
| “尝试不等于完成；结果可见就停止；不重复无变化的观察” | 已与 successPredicate / verdict 设计一致，写进 Jev 规则 | 已有 |
| 分级确认策略（交接 / 执行时确认 / 预授权 / 无需） | 替代单一 risk≥0.5 阈值 | 后续 |

不照搬：由大模型每步写代码加截图规划。这种方式通用但慢、贵；我们保留“本地编译候选 + Jev 选择”作为主路径。

---

## 9. P1 实施记录（已完成，全部通用，无应用特判）

原计划中 P2 的“AX diff + 按 verdict 驱动恢复”提前落地，另补齐了三类声明式能力。所有新能力仍走既有环路：候选编译 → Jev 选择 → 按预期验证 → 证据回喂 Jev。

| 项 | 实现 | 位置 |
| --- | --- | --- |
| 结构化 AX diff | `diffTrees(before, after)`：新增/删除节点（role+label 多重集）、值变化、焦点变化，`describeDiff` 输出≤300 字符摘要；每次 mutation 结算后追加到 history（`diff: +menu "操作"; changed=true`），Jev 从 recentActions 看到“到底发生了什么” | `tree-diff.ts` + 引擎 `pendingMutation` |
| `value_equals` 验证 | SET_VALUE/TYPE_TEXT 交付后（driver 未验证时）按身份重识别目标字段，核对 value 包含准备文本；成功记 `verified: ...`，失败判 `no_effect` 并把该目标从候选空间剔除（`verifiedFailures`，备选投递操作仍可用）；CLEAR 则要求清空后 value 为空 | 引擎验证块 + `findNodeByIdentity` |
| 目标身份键稳定化 | `targetKey` 剥离 `state` 和 `holds`：两者都会被被评判的动作本身改变，不能参与身份 | 引擎 |
| RIGHT_CLICK 通道 | 仅当元素声明 `RightClick` action（evidence=declared）且后端为 agent-desktop 时编译；不算破坏性 mutation（不触发风险确认、不进 risk fan-out），但参与 settle 跟踪和 diff；只读任务禁止 | `desktop-observation.ts` + 引擎 |
| CLEAR 通道 | 仅 agent-desktop、可编辑字段且当前有值时编译；属 mutation，走风险评估与验证 | 同上 |
| 多行文本安全路由 | slot 含换行时一律编译 SET_VALUE（语义写入原文，无 Return 副作用），禁止 TYPE_TEXT；即使 TypeText 字段也强制提供 SET_VALUE | `desktop-observation.ts` |
| Jev 规则同步 | 操作描述表新增 RIGHT_CLICK/CLEAR；新增规则：从 `diff:` 事实判断进展、RIGHT_CLICK 后下一步选菜单项 | `jev.ts` |

验证：`tests/tree-diff.test.ts`（8 项）+ `tests/computer-use-mode.test.ts` 新增 6 项（diff 证据、验证失败剔除、验证成功证据、CLEAR 验证、多行路由、只读禁选），58 项相关测试全部通过。

尚未做：`focus_on` 期望、L0 媒体命令与 L2 菜单栏通道、宏步骤、Affordance Memory。

## 10. 故障复盘：汽水音乐 WINDOW_NOT_FOUND（已修复）

**现象**：汽水音乐主窗口明明打开且可见，gui_task 却在启动阶段报 `WINDOW_NOT_FOUND`（窗口等待内未出现可观察 AX 窗口）。

**根因**：汽水音乐是 Chromium/CEF 应用。冷启动或后台运行的 Chromium 系进程默认只开“limited accessibility mode”——进程存在、窗口可见，但只暴露空/浅层 AX 树，直到有辅助客户端显式请求完整无障碍。请求方式是 macOS 标准属性写入：应用元素上的 `AXManualAccessibility`（Electron）或 `AXEnhancedUserInterface`（Chromium/CEF），Chromium 在约 2 秒 debounce 后才暴露完整树。之前能用的会话是因为应用已被碰过一次，AX 已开启。

**修复**（`fast_ax.rs` + `ax_control.rs`，通用机制，无应用名特判）：

- `activate_renderer_accessibility(pid)`：仅在应用元素**声明**了上述属性且当前读值为 false 时写入 true（true/未声明都不写，绝不盲写）；写后靠后续轮询等 debounce。
- `launch` 轮询循环：每轮 activate 后调用一次激活（属性驱动，幂等），继续用现有 15 秒轮询覆盖 debounce。
- `snapshot` 空窗口：先尝试激活并在 debounce 后重观察一次，再报 WINDOW_NOT_FOUND。

**排除项**：Spotlight 元数据、Info.plist 与运行实例的 bundle id 一致（均为 `com.soda.music`），解析器无错配；会话中出现的 `com.qoda.music` 是模型转述笔误。终端 shell 里复现的 PERM_DENIED 属终端自身未授权，与应用运行时无关。
