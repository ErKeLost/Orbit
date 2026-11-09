/**
 * 运行时性能监控（常驻、低开销）。
 *
 * 之前 `perf-log.ts` 只在 `localStorage['pi-gui.perfLog'] === '1'` 时才挂一个
 * rAF 循环，而且只会在「已经卡了」之后往 console 打一行。看不到数字，就只能
 * 靠肉眼看「卡成 ppt」——这一轮做的是可以把数字拿出来对照的东西：
 *
 * - **帧**：每秒实际绘制帧数、帧间隔中位数/p95、最长帧、刷新率估计；
 * - **停顿**：>120ms 记一次 jank，>400ms 记一次 stall，>1500ms 记一次 freeze，
 *   每一次都带上「当时正在做什么」（最近的 span）和当时的界面（panel / 会话）；
 * - **长任务**：有 `PerformanceObserver('longtask')` / `'long-animation-frame'`
 *   的引擎（CEF/Chromium）直接收引擎自己的主线程阻塞数据；
 * - **内存**：`performance.memory`（Chromium 专有）里的 JS 堆占用 + DOM 节点数。
 *   内存曲线比帧率更能解释「放一会儿再操作，整机卡十几秒」——那是内存压力，不是
 *   单帧渲染慢；
 * - **span**：`perfSpan('switch-session')` 圈住一次切标签/切会话/读历史，结束时
 *   记录耗时、期间掉了几帧、最长一帧，随后出现在 HUD 的「最近操作」里。
 *
 * 自动降级：可见状态下连续 5 秒帧率低于刷新率的 55% 就把 `data-perf-degraded`
 * 写到 `<html>`，样式表和 `appearance.ts` 会停掉装饰动画并撤掉 macOS 的
 * vibrancy（整窗混合是「整个电脑跟着卡」的结构性原因）。降级只发生一次，
 * 不会来回抖动；重启应用即恢复原样。
 *
 * HUD：`⌘⇧P`（`App: Perf HUD`），或 `localStorage['orbit.perfHud'] = '1'`。
 * 控制台也可以用 `__orbitPerf.report()` / `__orbitPerf.reset()`。
 */

export type PerfSpanRecord = {
  name: string;
  detail?: string;
  /** 墙钟耗时（含主线程阻塞与等待）。 */
  ms: number;
  /** span 期间绘制的帧数。 */
  frames: number;
  /** span 期间超过 1.5 倍刷新间隔的帧数。 */
  dropped: number;
  /** span 期间最长的一帧。 */
  worstMs: number;
  at: number;
};

export type PerfStall = {
  at: number;
  gapMs: number;
  kind: "jank" | "stall" | "freeze";
  span?: string;
  panel?: string;
};

export type PerfSnapshot = {
  running: boolean;
  visible: boolean;
  /** 最近一整秒的绘制帧数。 */
  fps: number;
  /** 最近一帧的间隔。 */
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  refreshHz: number;
  janks: number;
  stalls: number;
  freezes: number;
  longTasks: number;
  longTaskMs: number;
  heapMB: number | null;
  heapLimitMB: number | null;
  domNodes: number;
  spans: PerfSpanRecord[];
  stallsRecent: PerfStall[];
  fpsHistory: number[];
  degraded: boolean;
  degradeReason: string | null;
  uptimeMs: number;
};

export type PerfSpan = { end: (detail?: string) => void };

const FRAME_RING = 240; // ~4s @60Hz
const FPS_HISTORY = 120; // 2Hz 采样，约一分钟
const SPAN_HISTORY = 12;
const STALL_HISTORY = 10;
const JANK_MS = 120;
const STALL_MS = 400;
const FREEZE_MS = 1500;
const DEGRADE_AFTER_S = 5;
const DEGRADE_RATIO = 0.55;

const startedAt = typeof performance !== "undefined" ? performance.now() : 0;

let installed = false;
let running = false;
let raf = 0;
let lastFrame = 0;
let refreshMs = 1000 / 60;
let frameIndex = 0;
let framesInSecond = 0;
let secondMark = startedAt;
let fps = 0;
let worstMs = 0;
let janks = 0;
let stalls = 0;
let freezes = 0;
let longTasks = 0;
let longTaskMs = 0;
let lowSeconds = 0;
let degraded = false;
let degradeReason: string | null = null;
let diagnostics = false;

const gaps = new Float32Array(FRAME_RING);
const fpsHistory: number[] = [];
const spans: PerfSpanRecord[] = [];
const stallsRecent: PerfStall[] = [];

type SpanState = {
  name: string;
  detail?: string;
  start: number;
  frames: number;
  dropped: number;
  worstMs: number;
};

const spanStack: SpanState[] = [];
const listeners = new Set<() => void>();
const degradeListeners = new Set<(reason: string) => void>();

let snapshotCache: PerfSnapshot = buildSnapshot();
let snapshotDirty = true;
let lastBuild = 0;

function readFlag(key: string): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function panelOf(): string | undefined {
  // 直接读 DOM 上的标记，不 import store：监控层不该把 store 拉进启动路径。
  return document.documentElement.dataset.perfPanel ?? undefined;
}

function activeSpanName(): string | undefined {
  return spanStack.length ? spanStack[spanStack.length - 1]!.name : undefined;
}

function heap(): { used: number | null; limit: number | null } {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
  const used = memory?.usedJSHeapSize;
  const limit = memory?.jsHeapSizeLimit;
  return {
    used: typeof used === "number" ? used / 1048576 : null,
    limit: typeof limit === "number" ? limit / 1048576 : null,
  };
}

function buildSnapshot(): PerfSnapshot {
  const memory = heap();
  return {
    running,
    visible: typeof document === "undefined" ? true : !document.hidden,
    fps,
    frameMs: Math.round((gaps[(frameIndex + FRAME_RING - 1) % FRAME_RING] ?? 0) * 10) / 10,
    p95Ms: percentile(0.95),
    worstMs: Math.round(worstMs * 10) / 10,
    refreshHz: Math.round((1000 / refreshMs) * 10) / 10,
    janks,
    stalls,
    freezes,
    longTasks,
    longTaskMs: Math.round(longTaskMs),
    heapMB: memory.used === null ? null : Math.round(memory.used * 10) / 10,
    heapLimitMB: memory.limit === null ? null : Math.round(memory.limit),
    domNodes: typeof document === "undefined" ? 0 : document.getElementsByTagName("*").length,
    spans: spans.slice(-SPAN_HISTORY),
    stallsRecent: stallsRecent.slice(-STALL_HISTORY),
    fpsHistory: fpsHistory.slice(-FPS_HISTORY),
    degraded,
    degradeReason,
    uptimeMs: Math.round(performance.now() - startedAt),
  };
}

/** p 分位（0–1），忽略 0（未填满的环）与异常大的值。 */
function percentile(p: number): number {
  const values: number[] = [];
  for (let index = 0; index < FRAME_RING; index += 1) {
    const gap = gaps[index]!;
    if (gap > 0 && gap < 5000) values.push(gap);
  }
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const at = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * p)));
  return Math.round(values[at]! * 10) / 10;
}

/**
 * 刷新率估计：取「最快的那 20% 帧」的中位数。60Hz 上是 16.7，120Hz 上是 8.3；
 * 一次卡顿不会把它带偏，因为卡顿的帧都落在慢的那一侧。
 */
function estimateRefresh(): void {
  const fast = percentile(0.2);
  if (fast > 0) refreshMs = Math.min(34, Math.max(4, fast));
}

function pushFrame(now: number, gap: number): void {
  gaps[frameIndex] = gap;
  frameIndex = (frameIndex + 1) % FRAME_RING;
  if (gap > worstMs) worstMs = gap;

  // span 掉帧统计
  if (spanStack.length) {
    const dropped = gap > refreshMs * 1.5;
    for (const span of spanStack) {
      if (now < span.start) continue;
      span.frames += 1;
      if (dropped) span.dropped += 1;
    }
  }

  if (gap >= JANK_MS) {
    janks += 1;
    const kind: PerfStall["kind"] = gap >= FREEZE_MS ? "freeze" : gap >= STALL_MS ? "stall" : "jank";
    if (kind === "freeze") freezes += 1;
    else if (kind === "stall") stalls += 1;
    stallsRecent.push({ at: Math.round(now), gapMs: Math.round(gap), kind, span: activeSpanName(), panel: panelOf() });
    if (stallsRecent.length > STALL_HISTORY) stallsRecent.shift();
    for (const span of spanStack) span.worstMs = Math.max(span.worstMs, gap);
    if ((diagnostics || gap >= STALL_MS) && typeof console !== "undefined") {
      const where = activeSpanName();
      console.warn(
        `[perf] ${kind === "freeze" ? "卡死" : kind === "stall" ? "停顿" : "掉帧"} ${Math.round(gap)}ms` +
          `${where ? `（${where}）` : ""}${panelOf() ? ` · ${panelOf()}` : ""}`,
      );
    }
  }
}

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  if (!lastFrame) {
    lastFrame = now;
    secondMark = now;
    return;
  }
  const gap = now - lastFrame;
  if (gap <= 0) return;
  lastFrame = now;
  framesInSecond += 1;
  pushFrame(now, gap);

  const elapsed = now - secondMark;
  if (elapsed >= 1000) {
    // 一整个窗口的帧数 ÷ 实际秒数：120Hz 上会给出 120，掉到 10 也是真的 10。
    fps = Math.round((framesInSecond * 1000) / elapsed);
    framesInSecond = 0;
    secondMark = now;
    fpsHistory.push(fps);
    if (fpsHistory.length > FPS_HISTORY) fpsHistory.shift();
    estimateRefresh();
    evaluateDegrade();
    snapshotCache = buildSnapshot();
    snapshotDirty = true;
    for (const listener of listeners) listener();
    if (diagnostics) reportLine();
  } else {
    // 帧级变化也要让 HUD 看到（它是 4Hz 采样，不跟着每帧重渲）。
    snapshotDirty = true;
  }
}

function evaluateDegrade(): void {
  if (degraded || !running) return;
  if (typeof document !== "undefined" && document.hidden) {
    lowSeconds = 0;
    return;
  }
  // 一次「卡死十几秒」和持续 25fps 是同一个结论：装饰动画 + 整窗混合不再值得。
  // 用户的症状是周期性的（平时好好的，放一会儿再操作就卡十几秒），只看连续低
  // 帧率会永远等不到——所以一次 >=3s 的冻结、或者 30s 内 3 次 >=400ms 的停顿，
  // 也直接降级。
  const now = performance.now();
  const recent = stallsRecent.filter((stall) => stall.kind !== "jank" && now - stall.at <= 30_000);
  const froze = recent.some((stall) => stall.gapMs >= 3000);
  if (froze || recent.length >= 3) {
    const worst = Math.max(0, ...recent.map((stall) => stall.gapMs));
    degradeReason = froze
      ? `检测到一次 ${Math.round(worst)}ms 的冻结`
      : `30s 内 ${recent.length} 次停顿（最长 ${Math.round(worst)}ms）`;
    markDegraded(degradeReason);
    return;
  }
  const target = (1000 / refreshMs) * DEGRADE_RATIO;
  if (fps > 0 && fps < target) lowSeconds += 1;
  else lowSeconds = 0;
  if (lowSeconds >= DEGRADE_AFTER_S) {
    degradeReason = `连续 ${DEGRADE_AFTER_S}s 帧率 ${fps} < ${Math.round(target)}（刷新率 ${Math.round(1000 / refreshMs)}Hz）`;
    markDegraded(degradeReason);
  }
}

function markDegraded(reason: string): void {
  if (degraded) return;
  degraded = true;
  degradeReason = reason;
  if (typeof document !== "undefined") document.documentElement.dataset.perfDegraded = "1";
  if (typeof console !== "undefined") {
    console.warn(`[perf] 自动降级：${reason}。已停掉装饰动画并撤掉窗口 vibrancy。`);
  }
  for (const listener of degradeListeners) {
    try {
      listener(reason);
    } catch {
      // 降级回调不能把监控自己带崩。
    }
  }
  snapshotCache = buildSnapshot();
}

function reportLine(): void {
  const snapshot = getPerfSnapshot();
  const heap = snapshot.heapMB === null ? "" : ` · 堆 ${snapshot.heapMB}MB`;
  console.info(
    `[perf] ${snapshot.fps}fps（帧 ${snapshot.frameMs}ms · p95 ${snapshot.p95Ms}ms · 刷新 ${snapshot.refreshHz}Hz）` +
      ` · jank ${snapshot.janks} / 停顿 ${snapshot.stalls} / 卡死 ${snapshot.freezes}` +
      `${snapshot.longTasks ? ` · 长任务 ${snapshot.longTasks}（${snapshot.longTaskMs}ms）` : ""}` +
      `${heap} · DOM ${snapshot.domNodes}`,
  );
}

function observeLongTasks(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longTaskMs += entry.duration;
        if (entry.duration >= STALL_MS && typeof console !== "undefined") {
          const where = activeSpanName();
          console.warn(`[perf] 长任务 ${Math.round(entry.duration)}ms${where ? `（${where}）` : ""}`);
        }
      }
      snapshotDirty = true;
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // 引擎没有 longtask：rAF 漂移那份数据仍然有效。
  }
}

/** 装一次就够；重复调用无副作用。 */
export function installPerfMonitor(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  diagnostics = readFlag("pi-gui.perfLog");
  observeLongTasks();
  window.addEventListener("visibilitychange", () => {
    // 看不见的时候不统计（rAF 本来也会停），回来时把基线重置，避免把
    // 「切后台的 3 分钟」算成一次卡死。
    if (document.hidden) {
      lowSeconds = 0;
    } else {
      lastFrame = 0;
      secondMark = performance.now();
      framesInSecond = 0;
    }
    snapshotDirty = true;
  });
  start();
  expose();
}

function start(): void {
  if (running) return;
  running = true;
  lastFrame = 0;
  secondMark = performance.now();
  framesInSecond = 0;
  raf = requestAnimationFrame(tick);
}

function stop(): void {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

export function getPerfSnapshot(): PerfSnapshot {
  // 构建一次要排 240 个帧间隔、数一遍 DOM：HUD 每帧重渲时不能每个 getSnapshot
  // 都算一遍。250ms 的粒度对读数是够的（fps 本身就是 1s 的窗口）。
  const now = performance.now();
  if (snapshotDirty && now - lastBuild >= 250) {
    snapshotCache = buildSnapshot();
    snapshotDirty = false;
    lastBuild = now;
  }
  return snapshotCache;
}

export function subscribePerf(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 帧率持续过低时回调一次（自动降级）。 */
export function onPerfDegrade(listener: (reason: string) => void): () => void {
  degradeListeners.add(listener);
  return () => {
    degradeListeners.delete(listener);
  };
}

export function isDegraded(): boolean {
  return degraded;
}

/**
 * 圈住一次操作。结束时记录耗时和期间掉帧；超过 120ms 会立刻在控制台留一行，
 * 这样「切一次标签卡了 2.3s」不用靠回忆。
 */
export function perfSpan(name: string, detail?: string): PerfSpan {
  if (!installed) return { end: () => undefined };
  const state: SpanState = { name, detail, start: performance.now(), frames: 0, dropped: 0, worstMs: 0 };
  spanStack.push(state);
  let closed = false;
  return {
    end: (extra?: string) => {
      if (closed) return;
      closed = true;
      const index = spanStack.lastIndexOf(state);
      if (index >= 0) spanStack.splice(index, 1);
      const ms = performance.now() - state.start;
      const record: PerfSpanRecord = {
        name,
        detail: extra ?? detail,
        ms: Math.round(ms),
        frames: state.frames,
        dropped: state.dropped,
        worstMs: Math.round(state.worstMs),
        at: Math.round(performance.now()),
      };
      spans.push(record);
      if (spans.length > SPAN_HISTORY) spans.shift();
      snapshotDirty = true;
      for (const listener of listeners) listener();
      if (ms >= JANK_MS && typeof console !== "undefined") {
        console.info(`[perf] ${name} 用了 ${Math.round(ms)}ms（掉 ${record.dropped} 帧，最长 ${record.worstMs}ms）`);
      }
    },
  };
}

/** 给一次操作计时：同步或异步都行。 */
export async function timePerf<T>(name: string, run: () => Promise<T> | T, detail?: string): Promise<T> {
  const span = perfSpan(name, detail);
  try {
    return await run();
  } finally {
    span.end();
  }
}

export function perfMark(name: string, detail?: string): void {
  if (typeof performance === "undefined") return;
  performance.mark(name);
  if (diagnostics) console.info(`[perf] mark ${name}${detail ? ` · ${detail}` : ""}`);
}

/** 人类可读的报告；HUD 的「复制」按钮和控制台都用它。 */
export function perfReport(): string {
  const snapshot = getPerfSnapshot();
  const lines = [
    `Orbit 运行时性能报告 · 已运行 ${(snapshot.uptimeMs / 1000).toFixed(0)}s`,
    `帧率 ${snapshot.fps}fps · 帧 ${snapshot.frameMs}ms · p95 ${snapshot.p95Ms}ms · 刷新率 ${snapshot.refreshHz}Hz`,
    `掉帧 jank ${snapshot.janks} · 停顿 ${snapshot.stalls} · 卡死 ${snapshot.freezes} · 最长帧 ${snapshot.worstMs}ms`,
    snapshot.longTasks ? `长任务 ${snapshot.longTasks} 次 / ${snapshot.longTaskMs}ms` : "长任务：引擎不提供",
    `JS 堆 ${snapshot.heapMB === null ? "不可用" : `${snapshot.heapMB}MB / ${snapshot.heapLimitMB}MB`} · DOM 节点 ${snapshot.domNodes}`,
    snapshot.degraded ? `已自动降级：${snapshot.degradeReason}` : "未降级",
    "",
    "最近操作：",
    ...(snapshot.spans.length
      ? snapshot.spans.map((span) => `  ${span.name}${span.detail ? ` (${span.detail})` : ""} · ${span.ms}ms · 掉 ${span.dropped} 帧 · 最长 ${span.worstMs}ms`)
      : ["  （还没有记录）"]),
    "",
    "最近停顿：",
    ...(snapshot.stallsRecent.length
      ? snapshot.stallsRecent.map((stall) => `  ${stall.kind} ${stall.gapMs}ms${stall.span ? ` @ ${stall.span}` : ""}${stall.panel ? ` · ${stall.panel}` : ""}`)
      : ["  （没有）"]),
    "",
    `fps 采样（每秒一个，最近 ${snapshot.fpsHistory.length}s）：${snapshot.fpsHistory.join(" ")}`,
  ];
  return lines.join("\n");
}

export function resetPerfStats(): void {
  gaps.fill(0);
  frameIndex = 0;
  fpsHistory.length = 0;
  spans.length = 0;
  stallsRecent.length = 0;
  worstMs = 0;
  janks = 0;
  stalls = 0;
  freezes = 0;
  longTasks = 0;
  longTaskMs = 0;
  lowSeconds = 0;
  snapshotDirty = true;
  snapshotCache = buildSnapshot();
}

export function setPerfDiagnostics(on: boolean): void {
  diagnostics = on;
}

export const PERF_HUD_EVENT = "orbit:perf-hud";

/** 打开/关闭 HUD（快捷键、控制台、外部脚本都走这一条）。 */
export function togglePerfHud(force?: boolean): boolean {
  const next = force ?? !readFlag("orbit.perfHud");
  try {
    if (next) localStorage.setItem("orbit.perfHud", "1");
    else localStorage.removeItem("orbit.perfHud");
  } catch {
    // storage 不可用时只影响本次会话。
  }
  window.dispatchEvent(new CustomEvent(PERF_HUD_EVENT, { detail: next }));
  return next;
}

export function perfHudEnabled(): boolean {
  return readFlag("orbit.perfHud");
}

function expose(): void {
  const api = {
    snapshot: getPerfSnapshot,
    report: perfReport,
    reset: resetPerfStats,
    span: perfSpan,
    hud: togglePerfHud,
    setDiagnostics: setPerfDiagnostics,
    start,
    stop,
  };
  (window as unknown as { __orbitPerf?: typeof api }).__orbitPerf = api;
}
