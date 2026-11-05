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
