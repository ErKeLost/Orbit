# Browser Use

Orbit has two Computer-Use-class tools and they are deliberately separate:

| 工具 | 目标 | 观察方式 |
| --- | --- | --- |
| `gui_task` | 桌面应用 | macOS 辅助功能树（AX），Rust worker 驱动 |
| `browser_task` | 网页 | 真实 Chromium 的 DOM 快照，CDP 驱动 |

它们各自有开关、各自的决策循环，共用同一个 Jev 后端配置。选哪个由调用方按目标决定：网页用 `browser_task`，原生应用用 `gui_task`，其余工作用普通工具。

## 第三栏：真实内核渲染（不是把画面投过来）

「面板里放一个浏览器」有两条完全不同的路，必须分清：

| | 帧流（screencast） | 子 web view（现在这一栏） |
| --- | --- | --- |
| 画面 | 另一个进程渲染 → 编码 → 传 → 解码 → 画进 canvas：**是图** | 引擎直接画进这个窗口：**就是浏览器** |
| 文字 | 受编码/缩放影响，2× 也带 JPEG 振铃 | 和 app 自己的文字一样清晰 |
| 交互 | 指针/键盘要一条条回注，没有输入法、没有本地选中 | 原生滚动、选中、链接、输入法，鼠标键盘直接用 |
| 引擎 | Chrome（Blink） | macOS 上是 WebKit（WKWebView） |

这一栏现在走第二条：`Window::add_child`（Tauri 的 multi-webview，`unstable`）把一块真实的 web view 放进窗口，位置由这一栏的矩形决定（`browser_view.rs`）。**iframe 依然不行**（跨域拿不到 DOM、CSP 直接拒载），但「子 web view 是另一个内核、没有 CDP」这个代价现在由第三栏承担，而**不是**由 agent 的决策能力承担：

- **第三栏（用户看的）**：WebKit 子视图，原生渲染。它没有 CDP，但可以被脚本驱动 —— `browser_view_eval` 在页面里执行脚本并取回 JSON（实测能读到 `document.title` 与 `location.href`），而且这个页面**不在任何 capability 里**，网页碰不到 app 的任何命令。
- **agent（`browser_task`）**：仍然用 Orbit 自己启动的 Chrome + CDP。CDP 给的是 DOM 级别的观察与**可信输入**（`Input.*`，真实站点会当真人点击处理），这是 Jev 那套「元素编号 + 目标」决策最需要的东西，也是 WebKit 侧给不了的。

> 目前这两者是**两个浏览器**：栏里是 WebKit（用户看的），agent 跑在 headless Chrome 上（没有窗口）。把 agent 也接到子视图上（脚本点击/输入，必要时再用 Orbit 已有的物理输入通道产生可信事件）是下一步；那一步做完，栏里就是 agent 正在操作的那个页面。在此之前，栏是**给用户用的真实浏览器**，`browser_task` 是**agent 自己的浏览器**。

```text
agent：Pi ──browser_task──► 扩展里的循环（jev-ultrafast 的移植）
                              │  observe / act
                              ▼
                        CDP（loopback ws）
                              │
            ┌─────────────────┴──────────────────┐
            │  Orbit 拥有的 Chrome（headless）    │
            └────────────────────────────────────┘
                              ▲
            Rust（browser.rs）：启动/复用/关闭 + session.json

用户：第三栏 ──► Rust（browser_view.rs）──► 窗口里的 WKWebView 子视图
                              ▲
                          browser_view_eval（读页面/驱动页面）
```

## 谁在驾驶

`browser_task` 只接受一个完整目标、可选起始地址、可选本地 `textSlots`、`readOnly` 和预算。它不接受步骤、选择器、坐标或「什么算完成」。

每一轮：

1. **观察**：向页面注入 `snapshot.js`（browser-use/jev-ultrafast 的页面观察器，原样保留，MIT），一次读回可见控件表（元素编号、role、当前值、以及每个操作各自的目标列表）与可见文本。
2. **决策**：一次 Jev 请求，问的是
   - `operation`：`CLICK` / `TYPE_TEXT` / `SELECT` / `SCROLL_DOWN` / `SCROLL_UP` / `WAIT` / `DONE` / `BLOCKED` 里选一个（只提供当前页面确实支持的那些）；
   - 每个操作的 `<operation>_target`：该操作的最佳目标（推测式并发，只有被选中操作的那一份会被采用）；
   - `irreversible`：这一步是否难以撤销（noul）。
3. **执行**：把目标编号换回**它观察到的那个真实节点**，在输入前再校验一次（仍然连着、未禁用、可见、在视口内、`elementFromPoint` 没有被遮挡），然后经 `Input.*` 投递。

模型输出永远不会变成选择器、坐标、脚本或命令。下拉框的每个可选值本身就是独立目标（`3:2` = 元素 3 的第二个选项），所以「选第 4 个选项」不需要模型引用任何值。

## 值从哪来：先本地槽，再由运行自己的模型写

上游用一个小的 OpenAI 兼容模型现场生成字段值（`TEXT_VALUE`）。Orbit 用**用户已经配好的模型**做同一件事：一次 `--print --no-session --no-extensions --no-skills --no-tools` 的 Pi 一次性提问，返回值必须是一个只有 `text` 键的 JSON（`text-helper.ts`）。所以「搜索 X」这样的目标不需要先准备 X。

优先级：

1. **调用方准备好的 `textSlots`**（精确字符串，调用方自己选的），
2. **运行自己的模型**：读目标、字段含义与页面可见文本，只为这一个字段写一个值，
3. 两者都没有 → `needs_text`，指名是哪个字段。

硬规则：

- 只接受 `{"text": "…"}`。多一个键、不是字符串、超过 2000 字符、或夹带整段解释，一律拒收。
- **绝不编造个人信息**：邮箱、电话、地址、账号、密码只能来自目标或页面，说不出就返回 `{"text": null}` → 运行以 `needs_text` 停下，让调用方补上。
- 字段已经持有「这次运行会写入的那个值」时，这个 fill 目标**不再提供**：决定论地防住「同一个输入反复输入、页面一直等着被提交」的循环。
- `allowGeneratedText: false` 时完全不生成，只认槽位。
- 决策模型**只看到槽位的用途**；槽位的值也永远不会被送进 helper 的提示里。

配对方式沿用上游给下拉框编号的思路：文本字段的候选目标写成 `元素:槽位`（`19:query` = 把调用方准备的那个值填进元素 19）。这样一个决策同时定下「哪个字段」和「填哪条值」——分开问是问不出来的，因为单独的问题看不到该步骤要写哪个字段（实测 Jev 在那样的问法下答成了 missing）。

字段需要值而槽位里没有 → 立刻以 `needs_text` 停下，并指名是哪个字段；**不会**编造值。

## 新鲜度：两道校验，一次命中测试

- 决策作废的条件不是「页面变了」，而是「这个决策针对的东西变了」。点击/选择目标比较的是目标本身 + 它所在的 form/dialog/row 文本 + 文档与表单字段状态；`DONE`/`BLOCKED` 比较整页。
- 输入前再校验一次，并做 `elementFromPoint` 命中测试：**没有文字的遮罩不会改变语义状态，但仍然必须挡住点击**。
- 决策过期（`StalePage`）意味着**什么都没交付**，于是重新观察、重新决策，不计数、不重放。已经交付的动作永不重试。
- 动作**先记账再观察结果**：事后读页面失败（导航、渲染进程崩溃）不能抹掉已经发生的事。

## 不可撤销的步骤

每轮附带一条 `irreversible` 判断。当它 ≥ 0.6 且这一步不是 `wait` 时：

- 有交互界面 → 弹确认，用户同意后继续；
- 没有 → 以 `needs_review` 停下，不执行。

`readOnly` 运行根本不提供 `CLICK` / `TYPE_TEXT` / `SELECT`，只剩观察、滚动与两个终态。

## 第三栏（BrowserDock）

- **默认开、一直在**：标题栏地球按钮可以收起；收起只是把子视图 `hide()`，页面和历史都留着，展开即回到原处。切到设置/收件箱这些整页界面时它也在右侧。
- **是个真的 dock**：拖边框调大小、双击边框复位、菜单里可移到 top/bottom/left/right 四边、另有「清空这一栏（回到空白页）」。
- **工具栏**：后退 / 前进 / 重新加载（加载中变停止）/ 地址栏 / 位置菜单 / 收起。地址栏是 omnibox：带 scheme 的原样用；`localhost`、IP、`host:port`、含点的都自动补 `https://`；**不含点的词（含中文）当搜索词**，走 `SEARCH_TEMPLATE`（默认百度，一个常量就能换）。
- **摆放**：子视图不是 React 的一部分，所以它的矩形由这一栏在每次布局变化后上报（挂载、拖拽、换边、窗口缩放、打开），窗口缩放与 `ResizeObserver` 都会触发；`[view] rect=…` 会写进桌面日志 —— 这正是核验「点击落在哪里」「按钮有没有被盖住」的手段。
- **收起不销毁**：`hide()` 保留页面与历史；清空（菜单里）才回到空白页。
- **输入法、选中、拖拽、右键**都由系统提供 —— 这一栏就是一个 web view，中间没有层。
- **加载状态**来自引擎自己的 `on_page_load`，不是猜的，所以「重新加载」能在加载中变成「停止」。

## 一次启动失败是怎么变成「永远启动不了」的（已修）

Chrome 用资料目录里的 `SingletonLock` 保证同一 profile 只有一个实例。它是软链接，名字里带持有者 pid（`host-pid`）：

- **持有者已死** → 启动被拒（exit 21，`Failed to create SingletonLock: File exists`），而且没有任何地方说明原因。
- **持有者还活着但我们不知道它**（launcher 被 kill、session.json 被删、`browser_close` 只删了文件没杀掉进程）→ 同样拒启，而且 `--browser-close` 也找不到它（它原本只看 session.json）。

现在两处都补上了：启动前 `clear_orphan` —— 从 `SingletonLock` 取 pid，再用 `ps` 确认该进程的命令行里确实带着**我们的** profile 路径（用户自己的 Chrome 永远不会用它），然后 SIGTERM/SIGKILL 并清掉 lock/socket/cookie；持有者已死则直接清文件。`browser_close` 在没有 session.json 时做同样的事，所以它现在真的意味着「让浏览器消失」。原始报错都留在 `chrome.log` 里。

## 会话文件与启动

### 第三栏的视图

- 标签固定为 `browser-view`，**不在任何 capability 里**：网页读不到 app 的命令，唯一的通道是 app → 页面（`browser_view_eval`，实测能读回 `document.title` / `location.href`）。
- 起步于 `about:blank` 且隐藏，由这一栏上报矩形后才 `show()`；`requested=""` 时不上报 URL（空栏就是空栏）。
- macOS 上是 WKWebView：UA 是 Safari 的，不是 Chrome 的。按 Safari 行为渲染，是选「原生渲染」必然的代价。

### agent 的浏览器（Chrome）

- `~/.pi/agent/browser/session.json`：`{port, targetId, url, pid, executable, startedAt, browserVersion, browserWs, userAgent}`。Rust 写，扩展读；两边都靠它定位同一个 tab。
- `~/.pi/agent/browser/profile/`：专用 Chrome 资料目录（首次运行是干净的，登录信息只属于这一栏）。
- `~/.pi/agent/browser/chrome.log`：内核自己的 stderr —— 被拒绝的调试连接、渲染进程崩溃、资料目录被别的实例占用，都只在这里出现。
- `ORBIT_BROWSER_HOME` 整体挪走浏览器目录（测试与沙箱用；`scripts/check-browser-guards.ts` 就靠它，绝不碰用户自己的资料目录）。
- `ORBIT_BROWSER_BINARY` 指定内核；否则依次找 Chrome / Chromium / Brave / Edge / Vivaldi。
- `ORBIT_BROWSER_SCALE` 决定内核栅格化倍率（默认 2 = 屏幕像素级）；`ORBIT_BROWSER_ALLOW_ORIGINS` 追加允许连调试口的来源。
- 启动标记只写在 Rust 一处（`browser.rs::launch_args`）。扩展不复制这份参数表，而是执行 `Orbit --browser-ensure [--url <url>]`（`main.rs` 在 Tauri 起来之前就退出），因此**栏和 agent 不可能对「浏览器怎么跑」产生分歧**。

## 边界（可信地不做什么）

页面观察器支持常见 HTML/ARIA 控件；以下仍未支持，遇到时应以 `blocked`/`error` 如实报告，而不是绕过去：

- shadow root、frame/iframe 内容（`document.querySelectorAll` 不穿透）；
- canvas / WebGL 应用、文件上传、下载、嵌套滚动、任意键盘组件、拖拽；
- 输入法（IME）与原生右键菜单；
- `DONE` 永远只是「模型认为页面满足了目标」，不是独立验证。真正的验证是页面上可见的内容 —— 工具结果会带上页面自己的可见文本，调用方必须自己看。

其它已知取舍：

- **只有一个受管 tab**。新地址会开新 tab 并关掉旧的。
- **headless 可被识别**：UA 已修正，但站点仍可能有其它探测手段；被挡住时用 `ORBIT_BROWSER_HEADFUL=1`，或让用户先在第三栏里手动登录。
- **不绕过任何登录墙、付费墙、验证码或权限提示**：观察器读到什么就是什么，指令里明确要求遇到时选 `BLOCKED`。
- **桌面端功能**：手机没有这一栏（它的「屏幕」通道给的是桌面像素，不是浏览器的 DOM），因此 `browser_open` / `browser_status` / `browser_close` 在远端命令边界里是显式排除项。
- **图片与 Box 尚未接入**：Jev 1.14 的 Box 问题（图片里某个目标的位置，归一化四边）正好可以补上 canvas / 难以读取的 iframe —— 驱动里已经保留了 `screenshot()`，但决策循环不使用截图，接入前不动。

## 文件

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/browser_view.rs` | **第三栏的引擎视图**：创建/摆放/隐藏子 web view、导航、在页面里执行脚本并取回 JSON、加载状态 |
| `src/lib/browser-view.ts` | 上面那些命令的前端封装 + 地址栏的 omnibox 规则 |
| `src-tauri/src/browser.rs` | agent 的 Chrome：发现/启动/复用/关闭、session.json、`--browser-*` 帮助入口 |
| `src/features/browser/BrowserDock.tsx` | 第三栏本体：工具栏、画面、坐标换算、横幅、空态、四边 dock |
| `src/features/shell/dock.ts` | dock 几何（尺寸/下限/四边/拖拽→尺寸），终端栏与浏览器栏共用 |
| `src-tauri/resources/browser-use/snapshot.js` | 页面观察器（上游原样，MIT） |
| `src-tauri/resources/browser-use/browser-driver.ts` | CDP 驱动：观察/新鲜度/执行（`browser.py` 的移植） |
| `src-tauri/resources/browser-use/browser-engine.ts` | 循环：候选表、Jev 请求、预算、文本槽、风险门 |
| `src-tauri/resources/browser-use/browser-task.ts` | 工具注册与结果格式化 |
| `src-tauri/resources/browser-use/mode.ts` | `browser_task` 的激活与系统提示 |
| `src-tauri/resources/browser-use/text-helper.ts` | 用用户自己的模型为单个字段写值（上游 `TEXT_VALUE` 的移植） |

## 验证

```sh
bun test tests/browser-use.test.ts        # 离线契约：候选表、指纹、循环规则（无需浏览器/模型）
bun run check:browser-guards              # 真实 Chrome + 本地 fixture，无模型调用
```

`tests/browser-use.test.ts` 覆盖：元素编号与下拉框目标编码、几何变化不影响指纹、**动作先记账后观察**、过期决策不执行也不计数、缺少槽位时 `needs_text` 而不是编造、连续三步无变化即停、不可撤销步骤必须有确认、预算即停止线、以及 read-only 不提供任何改动操作。

`scripts/check-browser-guards.ts` 移植自上游 `scripts/check_guards.py`（MIT），32 项，包含：移动后的控件仍在原决策的目标上被点击；9 种真实变化（可见上下文、无障碍名、字段值、勾选状态、禁用、只读、隐藏、节点替换、下拉选项）必须让决策作废；无文字遮罩不改语义状态但必须挡住点击；密码值不暴露；禁用控件不出现；原生下拉真的选中；输入后等待异步候选。实测中还确认了一处上游注释与行为不符：**同 scope 内「视口外」的文本仍然在守卫范围内**，因此它的变化会作废决策（代价是多一次决策，不是错点一次）；没有渲染的文本才不在范围内。脚本在缺少 Chrome 或未构建 Orbit 时自行 skip。

实测（2026-10-15，Chrome 155，Jev 1.14，macOS arm64）：

- Wikipedia 任务「找到并打开哥德尔不完备定理条目」：**5.0 秒**（含 Chrome 冷启动）、5 次 Jev 调用、2 次动作；在同一页面上重跑同一目标：**1.06 秒 / 1 次 Jev 调用 / 0 次动作**。
- **不准备任何值的任务**（`allowGeneratedText` 默认开）：起点 `Special:Search`，目标「用搜索框找到并打开关于不完备定理的条目」→ 运行自己的模型写出查询 → CLICK Search → 落在 `Gödel's_incompleteness_theorems`，**10.7 秒 / 5 次 Jev 调用 / 1 次生成值**（其中约 3–4 秒是那一次生成值的模型进程），`done` 且 Jev 判定目标达成。
