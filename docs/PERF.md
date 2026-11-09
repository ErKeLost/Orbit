# 性能：我们和 t3code 差在哪

这份文档只回答一个问题：t3code 是 Electron，Orbit 是 Tauri，为什么前者的手感
更好，以及在**不改视觉**的前提下我们已经做了什么、还差什么。

结论先说：**差异不在 WebView 引擎，在我们喂给引擎的形状。** Tauri 的 WKWebView
在滚动、合成、文本排版这些基础能力上不比 Chromium 差；差别在于 t3code 的界面
从来不把「一屏都放不下的东西」整块交给引擎。

## 1. t3code 做对的四件事

| 做法 | 位置 | 为什么有效 |
| --- | --- | --- |
| 消息列表虚拟化 | `apps/web/src/components/chat/MessagesTimeline.tsx`（`@legendapp/list`） | 只有视口附近的十几行在 DOM 里。几百轮会话的滚动、布局、命中测试全部是常数成本，跟会话长度无关 |
| 行身份稳定 + 增量派生 | `apps/web/src/components/chat/useTimelineRows.ts`（`useIncrementalTimelineRows` / `useStableRows`） | 流式更新只 patch 变化的那一行；`rows` 数组里没变的行还是同一个对象，`memo` 才有意义 |
| **不透明**窗口 | `apps/desktop/src/window/DesktopWindow.ts`（`backgroundColor`，无 `transparent`、无 vibrancy） | macOS 上不透明窗口能走「根层不透明」的合成快路；带 vibrancy 的窗口每一帧都要和桌面混合 |
| React Compiler + 增量 markdown | `vite.config.ts`（`oxc-transform-react`，lint 禁用 `useMemo/useCallback`）、`apps/web/src/markdown-incremental.ts` | 组件级自动记忆化，不再靠人肉 `memo`；流式 markdown 只解析新长出来的那段，已闭合的代码围栏不重解析 |

t3code 的 `AGENTS.md` 把这几条写成了硬约束：「no continuously repainting
animations; they peg the GPU on high-refresh displays」「lists being hard to
render」都是性能事故的常见根因。

## 2. 我们已经对齐的

- 增量 markdown 解析：`src/shared/lib/markdown/incremental.ts`（移植自 t3code）。
- 高亮不在流式期间跑：`src/components/CodeBlock.tsx` 的 `useSettled(180ms)`，
  shiki 走 Worker + LRU 缓存（`src/lib/highlight/`），t3code 同款策略。
- 流式提交按帧合并：`src/features/chat/ChatPane.tsx` 的 `useFrameStream`，后台
  连接按 100ms（`src/lib/rpc-core.ts`）。
- 分组对象、渲染对象、时间值三级缓存：`reuseGroups` + `groupViewCache` +
  `groupTimeCache`，保证流式帧只让「正在跑的那一组」换引用。
- 装饰动画不常驻：`GalaxyDotBackground` 在面板 0×0 或 `document.hidden` 时停
  循环；`GridReveal` 跑完就 `cancelAnimationFrame`，离屏用 IntersectionObserver
  暂停。
- 窄选择器订阅：全仓库没有 `useWorkspace()` 整体订阅；`statuses` 这类每 5 秒
  换引用的对象在订阅前先压成字符串（`extensionStatusLine`）。

## 3. 这一轮改的

1. **长会话按段挂载**（`ChatPane.tsx`）。超过 80 段（约 40 轮）的会话只挂最近
   40 段，顶部按钮每次往前放 40 段，展开时用 `scrollHeight` 差值把阅读位置补回
   去。这就是 t3code 虚拟列表要解决的问题的保守版本：不做逐项虚拟化（聊天行
   高度差异太大，闪进闪出风险高），只把「几百段的 DOM」变成「几十段」。
   窗口在挂载时判定一次，所以不会在阅读历史的中途抽掉上面的内容。
   `PromptOutline` 本来就是从 DOM 推导的，注释里写明了「分页或过滤时仍然正确」。
2. **性能降级开关真的生效了**。`perf-tier.ts` 写的是 `data-perf`，样式表读的是
   `[data-perf-tier="low"]`——低配档从上线起就是空转的。现在两个属性都写，并且
   低配档会停掉 shimmer、思考呼吸、工具转圈、打字点，也会撤掉 macOS 的 vibrancy
   （`appearance.ts`），退回不透明窗口。
3. **后台窗口不画**。`html[data-page-visible="false"] *` 这条规则一直存在，但没
   有人写过这个属性；现在 `installPageVisibility()` 在启动时挂上监听。切到别的
   应用后，装饰动画不再继续吃合成器。
4. **会话面每帧重渲时不再带着无关子树**：`TerminalDock`、`PromptOutline`、
   `TranscriptJumpToBottom` 加 `memo`（它们的 props 都是稳定的），空会话的
   `GalaxyDotBackground` 在低配档只画一帧。
5. **markdown 插件数组不再跟着每个 token 换引用**（`Markdown.tsx`）：把
   `source` 换成一个布尔值进依赖，`react-markdown` 不必每个 token 重建一次管线。

守卫：`tests/regression-guards.test.ts` 新增一条——样式表里所有
`html[data-*="…"]` 开关，必须在 TS 里有对应的写入，避免再出现「开关没人拨」。

## 4. 还没做，按收益排序

1. **窗口透明 + 原生 vibrancy**（`tauri.conf.json` 的 `transparent: true` +
   `appearance.ts` 的 `setEffects(Effect.Sidebar)`）。这是和 t3code 最大的结构性
   差异：整窗非不透明，`--sidebar-opacity: 0.85` 让会话面本身也是半透明的，
   合成器每帧都要和桌面混合。要不要保留是产品决定，不是性能决定——所以这一轮
   只把它接进了低配档，没有动默认外观。**验证方法**：把 `bodyGlass` 关掉
   （设置里或 `localStorage orbit.bodyGlass=false`），对比 `perf-log` 的停顿次数。
2. **滚动容器上的 `mask-image`**（`orbit-theme.css` 的
   `.transcript-composer-fade .agent-transcript`）。给滚动容器加 mask 在 WebKit
   上是很常见的滚动卡顿来源（掩码层要随滚动重算），而它只负责底部 2.5rem 的
   渐隐。**验证方法**：临时把这条规则改成 `mask-image: none`，滚动同一段长会话，
   对比 `perf-log` 的 150ms+ 停顿计数；确认有效再换成「wrapper 加 mask」或
   「底部渐隐覆盖层」，两种都能保住现在的观感。
3. **React Compiler**。t3code 全量启用并用 lint 禁止手写 `useMemo/useCallback`；
   我们的 `@vitejs/plugin-react` 目前没开 `babel-plugin-react-compiler`。开了之后
   所有组件的记忆化边界自动就位，人肉 `memo` 漏掉的地方（这一轮手工补了三处）
   会一起消失。风险中等：需要跑一遍 `bun run check` + 手动过一遍主流程。
4. **`ChangesPanel` 的每帧 diff 解析**（`src/components/panels/ChangesPanel.tsx`）。
   它订阅整个 `transcript`，流式时每帧对全部工具调用重跑 `getChange`。只在「变更」
   面板打开时才会发生，但打开时是纯浪费。
5. **流式提交频率**。现在是每帧一次（60/120fps）。超长回答（几十 KB）时每帧的
   markdown 渲染会逐渐逼近 16ms。t3code 用 `@tanstack/react-pacer` 的地方就是
   这类节流；我们可以在「活动消息超过 N 字符」时降到 ~30fps，视觉上几乎无感。

## 5. 怎么量，别靠感觉

```js
localStorage.setItem('pi-gui.perfLog', '1')   // 重启应用
localStorage.setItem('pi-gui.perfTier', 'low') // 对比低配档（可选）
```

`src/lib/perf-log.ts` 会在控制台报：发送 → 首帧耗时、150ms 以上的主线程停顿
（标注「流式中」）、每 10 秒的汇总。改前改后跑同一段会话（同一条长回答 + 一次
向上滚动），比较「停顿次数 / 最长停顿」，不要用肉眼记忆。

WKWebView 没有 longtask API，所以这里量的是 rAF 漂移——它等价于「用户看到的
掉帧」，比主线程耗时更接近手感。

## 6. 这一轮：先把「量」做出来，再拆掉常驻的渲染

### 6.1 运行时监控（`src/lib/perf-monitor.ts` + `src/components/PerfHud.tsx`）

以前只有一个可选的 `perf-log.ts`，而且它只在卡完之后往控制台打一行，没有帧率、
没有内存、没有「这次卡在哪个操作上」。现在的监控常驻（一个 rAF 回调，几帧算术），
`⌘⇧P` 打开 HUD 就能看到：

| 读数 | 含义 |
| --- | --- |
| `fps` / `frameMs` / `p95` | 最近一秒实际画了多少帧、帧间隔、95 分位 |
| jank / 停顿 / 卡死 | >120ms / >400ms / >1500ms 的帧，逐次记下「当时在哪个操作、哪个面板」 |
| 长任务 | 引擎自己的 `longtask`（CEF/Chromium 提供；WebKit 没有就退回 rAF 漂移） |
| 堆 / DOM | `performance.memory` 的 JS 堆 + DOM 节点数——**内存压力**比单帧慢更能解释「整机卡十几秒」 |
| 最近操作 | `switch-surface` / `open-session` / `load-history` / `paint:xxx` / `prefetch-session` 的耗时、掉帧数 |

控制台：`__orbitPerf.report()`（整份报告）、`__orbitPerf.reset()`、
`__orbitPerf.hud(true)`。HUD 的「复制报告」按钮给的就是同一份文本。

**自动降级**：可见状态下连续 5 秒低于刷新率 55%，**或**一次 ≥3s 的冻结、30 秒内
3 次 ≥400ms 的停顿，就把 `data-perf-degraded` 写到 `<html>`：停掉 shimmer / 呼吸 /
转圈 / 打字点，撤掉 macOS vibrancy，并把窗口底色压实成不透明。只降一次，重启恢复，
同时弹一条提示说明原因（否则「特效没了」看起来就像界面坏了）。

### 6.2 拆掉的常驻渲染

| 之前 | 现在 |
| --- | --- |
| 语音页常驻 → `Orb` 的 R3F 循环**永远** 60fps（看不见也一样） | `frameloop="never"` 暂停（保留 WebGL 上下文，切回去不重建），`dpr` 上限 2，低功耗 GL |
| `LiveWaveform` 未激活时仍每帧 `getBoundingClientRect()` + `requestAnimationFrame` | 尺寸走 ResizeObserver 缓存；没有新数据就**停循环** |
| 银河背景每 40ms 用 `CanvasPattern` 对整屏描一遍 6px 网格 | 网格层离屏画一次，每帧一次 `drawImage`；低配/降级/窗口失焦只画一帧就停 |
| 银河背景在 `pointermove` 里每次 `getBoundingClientRect()`（120Hz 强制布局） | 用布局时缓存的矩形；失焦/降级/离屏直接不处理 |
| 银河背景的主题观察者逐条重刷整块画布 | 合并到下一帧，最多刷一次 |
| 会话图片缓存「最多 120 条」→ 120 张 5MB 截图 ≈ 600MB JS 堆 | 按**字符预算**（24M 字符）+ 单图上限 6M 字符，超了丢最旧 |
| 历史图片以 base64 走 IPC（一张 5MB 截图 = 6.7MB JSON + 一份 UTF-16 副本） | 新增 `session_image_file`：Rust 落盘，`<img>` 走 asset 协议，IPC 只剩一条路径 |
| 活事件（`tool_execution_*` / `message_*`）里的截图永远是 base64，**整场会话都留在 transcript 里** | Rust 出口处把 `{type:image,data}` 改成 `{file}`：同一张图按内容哈希去重，写盘一次；手机仍然收到原样 base64 |
| `git diff` 每 2 秒起两个 git 进程（空闲也一样） | 连续 2 轮没变化后拉到 10 秒；聚焦/切回前台/收到 git 事件立刻恢复 |
| 底部渐隐的 `mask-image` 挂在滚动容器上 | 挂到不滚动的包裹层，滚动仍是纯位移 |
| 切标签时 `ChatPane` 重挂，长会话的 markdown 解析/布局在**同一帧**里跑完 | 首帧只画骨架，正文放到下一轮 task 的 `startTransition` 里（可中断、可让位给输入） |
| 会话列表 hover 直接读整份 JSONL + hydrate | 220ms 悬停意图 + 单飞队列（最多排 2 条），已有干净缓存直接跳过 |
| 同一条连接可能并发两次历史装载 | `loadMessages` / `primeProjection` 单飞；transcript 缓存 6 → 16 条 |

### 6.3 默认外观变了：窗口玻璃（半透明）默认关闭

窗口透明 + vibrancy 是上面所有「停掉常驻动画」的乘数：窗口非不透明时，合成器
每一帧都要和桌面混合，代价落 `WindowServer` 上——所以「整个电脑都卡」而不是只有
这个 app 卡。现在：

- `orbit.bodyGlass` 默认 `false`（`readBodyGlass`），也就是**默认不挂 NSVisualEffect、
  不写 `has-native-glass`、侧栏/主面板都是不透明底色**，合成走不透明快路。
- 「设置 → 外观 → 透明度」里第一行是「窗口玻璃」开关。打开后与以前默认的外观完全
  一样（vibrancy + 半透明侧栏 + 可调不透明度/模糊半径），下面的两个滑块只在它开着
  时可用。浅色主题始终不透明。
- 低配档、`prefers-reduced-motion`、以及运行时自动降级都会强制走不透明；降级撤
  vibrancy 的那条路和手动关掉是同一个（`applyNativeGlass` 的 `eligible`）。

开机时在 `index.html` 的预绘制脚本里也没有任何玻璃类：首帧就是不透明的，不会闪
一下半透明再变。

### 6.4 还没做 / 需要你决定

1. **React Compiler**（`babel-plugin-react-compiler`）仍未启用。
2. `ChangesPanel` 在流式时仍会对所有工具调用重跑 `getChange`（仅当该面板打开时）。
3. `tauri.conf.json` 的 `transparent: true` 还在：它是「窗口玻璃」开关能生效的前提，
   默认关闭时页面本身已是完全不透明（Chromium 会把根层当不透明处理），但 AppKit
   层面窗口仍是非不透明的。如果以后确认玻璃这个功能不要了，把这一项改成 `false`
   还能再省一点。
