# Computer Use 架构

Orbit 的 Computer Use 使用唯一生产链路：

```text
User
  -> Pi: 目标 App、整体 goal、本地 textSlots、预算
  -> macOS App Resolver: 本地化显示名 / bundle 名 / bundle ID
  -> agent-desktop: 启动或连接 App，读取 AX skeleton
  -> local candidate compiler: 只保留当前 AX capability 支持的操作
  -> Jev: 每轮选择一个 operation + target，或 DRILL / WIDEN / WAIT / DONE / BLOCKED
  -> agent-desktop: ref 重识别、actionability、auto-wait、执行、局部 post-state
  -> successor AX observation
```

不保留预计算 UI 步骤、应用特判或双后端兼容路径。

## 职责边界

| 模块 | 职责 |
| --- | --- |
| `gui-task.ts` | 唯一 Pi 工具 Schema、进度和最终结果 |
| `gui-task-contract.ts` | `goal + target.app + textSlots + budget` 契约 |
| `desktop-app-resolver.ts` | 把自然语言 App 意图解析为已安装 App 的真实身份 |
| `agent-desktop-client.ts` | 调用捆绑的原生二进制，解析结构化响应，隔离任务状态 |
| `desktop-observation.ts` | AX skeleton / drill 转成有界、能力兼容的候选 |
| `jev.ts` | App 歧义解析和每轮 operation+target Choice |
| `gui-task-engine.ts` | observe-decide-act 循环、预算、文本所有权和不可重放语义 |

Pi 不预猜 UI 控件、步骤、坐标或完成谓词。agent-desktop 不拥有任务目标或模型决策。Jev 不拥有输入文本、元素 ref 或执行权限。

## App Resolver

`target.app` 是自然语言意图，例如“日历”“汽水音乐”或“浏览器”。resolver 不包含名称映射表：

1. 使用 macOS Spotlight 元数据查询真实安装包。
2. 对 `kMDItemDisplayName`、bundle 文件名和 `kMDItemCFBundleIdentifier` 做规范化精确匹配。
3. 唯一精确命中直接使用 bundle ID，不调用模型。
4. 类别词或歧义只把真实安装候选的最小元数据交给 Jev。
5. Jev 选择 `none`、候选为空或候选仍不唯一时拒绝，不猜测。
6. 启动后 agent-desktop 返回精确 process instance 和 window ID。

例如本机 Calendar 的 Spotlight 元数据为 `displayName=日历`、`bundleId=com.apple.iCal`。中文意图因此是本地事实匹配，不是硬编码翻译。

## 观察策略

默认路径完全不截图：

1. 首次观察使用 `snapshot --skeleton -i --compact --include-bounds`。
2. skeleton 只读浅层结构，截断分支携带 `children_count` 和可 drill ref。
3. Jev 可选择 `DRILL`，运行时使用 `snapshot --root @qualified-ref` 只读目标区域；局部读取保留非交互文本子节点，使匿名但可操作的父项获得真实后代语义。
4. overlay 出现时切换到 menu、sheet、alert 或 popover surface。
5. 只有当前 observation 的 AX actions 能产生候选。

截图/OCR 不属于当前正式路径。将来只有 AX 无法提供目标时，才可以作为独立、显式、可测量的 provider 增加，不能伪装成现有能力。

## Jev 边界

每轮只发一次 System One 请求。请求包含一个 operation head，以及每种当前可用 operation 对应的 capability-specific target head；只读取最终 operation 对应的 target 结果。没有低置信二次排序，也没有代码改写 Jev 已选择动作的 `inspect` 路线。

观察层按元素而不是按“元素 x 动作 x 所有文本槽”限制规模。每个 operation head 最多接收 254 个当前 AX 元素；文本槽按调用顺序消费，每轮只暴露下一个未满足槽的 ID 和用途，避免候选笛卡尔积挤掉后面的真实控件。候选描述只来自 AX 角色、名称、值、状态、结构路径、后代文本和动态 bounds，不含 App 名或业务词规则。

Jev 可以选择：

```text
ACTIVATE / FOCUS
CLICK / DOUBLE_CLICK / RIGHT_CLICK
SET_VALUE / TYPE_TEXT / CLEAR
CHECK / UNCHECK
EXPAND / COLLAPSE
SCROLL_TO / SCROLL_UP / SCROLL_DOWN
PRESS_ENTER / DISMISS
DRILL / WIDEN
WAIT / DONE / BLOCKED
```

RIGHT_CLICK 和 CLEAR 只在元素声明了对应能力（`RightClick` action / `SetValue` 且有值）且后端为 agent-desktop 时编译；两者都是右键菜单和清空输入框这类通用意图的入口。多行 caller 文本只走 SET_VALUE，避免物理输入把换行变成 Return。

候选 ID 是不透明本地 ID。Jev 不接收 agent-desktop ref、本地输入值或命令行参数。安全文本只通过 `textSlots` 留在本地；候选只暴露 slot ID 和 purpose。

## 执行语义

1. agent-desktop ref 绑定 snapshot，并保存进程实例、窗口、路径、语义身份和 bounds 证据。
2. 动作时重新识别 live element，而不是直接复用旧 native handle。
3. 动作前检查 visibility、enabled、editability、stability、occlusion 和支持的 action。
4. 默认使用无焦点窃取的 AX semantic route。`SET_VALUE`、semantic `TYPE_TEXT` 和 Web 内容需要的 exact-window 实体键盘输入是 Jev 事前可选的独立能力；某一路线失败后不会自动切换另一路线。文本交付后引擎按 `value_equals` 预期用身份重识别目标字段并核对 value：成功记为证据，失败判 `no_effect` 并从候选空间剔除该目标（另一投递操作仍可选）。
5. 响应携带 `disposition.delivery` 与 `disposition.retry`。
6. 只有 `retry=safe` 且 `STALE_REF` 才允许刷新后重新决策；任何 uncertain、unverified 或已交付动作都不重放。
7. 每次 mutation 后重新读取 successor AX state；密集页面仍从 skeleton 开始。相同动作不会被永久移除，因此滚动、下一首等合法重复操作仍可执行；连续三次已交付 mutation 都没有 AX 变化才停止。每次已交付 mutation 都会对前后两棵树做结构化 diff（新增/删除节点、值变化、焦点变化），摘要进入 Jev 的 recentActions，进展判断基于“实际发生了什么”而不是 changed 布尔值。
8. 任务在 `DONE`、`BLOCKED`、不确定交付、取消、错误或预算耗尽时终止。

## 运行与打包

固定依赖：

- `agent-desktop` 0.9.4
- `@typesafe-ai/sdk` 0.6.0

`scripts/sync-computer-use.mjs` 将 TypeSafe SDK、agent-desktop npm 包、当前平台原生二进制和 macOS helper 复制到 Tauri resources，并校验运行文件可执行。每个任务使用独立的临时 `AGENT_DESKTOP_HOME`，结束后删除，避免不同任务共享隐式 latest snapshot。

上游完整源码固定在本地忽略目录 `work/reference/agent-desktop` 的 `v0.9.4` 标签，用于核对 skeleton/ref、actionability、delivery 和官方 `jev-desktop` loop；产品运行时只依赖官方 npm 预编译包，不编译或分叉这份 Rust 源码。

当前 agent-desktop 正式平台是 macOS。Windows/Linux 在上游仍为 planned，因此 Orbit 不宣称这两个平台已经具备同等 Computer Use 能力。

## 验证边界

- 中文“日历”通过系统本地化元数据解析到 `com.apple.iCal`。
- agent-desktop 成功启动并连接日历窗口。
- 日历 AX skeleton 在本机约 0.24 秒完成。
- 正式 Jev loop 对“打开日历”在一次决策后返回 `done`。
- 隔离 fixture 的 `set-value` 返回 `delivered_verified`，live AXValue 独立读回一致。
- 正式 Jev loop 以 0.99 置信度选择 fixture 的目标输入框，写入后重新观察并完成。
- 单元测试覆盖本地化解析、bundle 名解析、语义歧义选择、拒绝猜测、AX 候选、零动作完成、输入/提交序列和不确定交付不重放。

上述真实 App 结果来自 `0.9.2` 阶段。`0.9.4` 和当前收敛后的单请求 loop 已通过类型、资源同步和静态检查；按当前调试约定，最终真实 App 行为由开发版手动验证，不用自动化桌面任务代替验收。
