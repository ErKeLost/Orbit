import { useCallback, useEffect, useState } from "react";
import { toast } from "../shared/ui/toast";
import {
  getPerfSnapshot,
  onPerfDegrade,
  perfHudEnabled,
  perfReport,
  resetPerfStats,
  subscribePerf,
  togglePerfHud,
  PERF_HUD_EVENT,
  type PerfSnapshot,
} from "../lib/perf-monitor";

/**
 * 实时性能 HUD。
 *
 * 不是给用户看的功能，是「卡了到底卡在哪」的仪表盘：帧率、帧间隔、最近操作
 * 花了多久、掉了几帧、最近几次停顿发生在哪个操作里。默认关闭，
 * `⌘⇧P` 或 `__orbitPerf.hud(true)` 打开，`localStorage` 记住选择。
 *
 * 采样 4Hz，只 re-render 这一小块，不影响被测量的界面。
 */
function tone(fps: number, refreshHz: number): string {
  if (!fps) return "text-content/40";
  const ratio = fps / Math.max(30, refreshHz);
  if (ratio >= 0.85) return "text-emerald-400";
  if (ratio >= 0.55) return "text-amber-400";
  return "text-red-400";
}

function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  const width = Math.max(2, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-content/10">
      <span className={`block h-full rounded-full ${className ?? "bg-accent"}`} style={{ width: `${width}%` }} />
    </span>
  );
}

export function PerfHud() {
  const [enabled, setEnabled] = useState(() => perfHudEnabled());
  const [snapshot, setSnapshot] = useState<PerfSnapshot>(() => getPerfSnapshot());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onToggle = () => setEnabled(perfHudEnabled());
    window.addEventListener(PERF_HUD_EVENT, onToggle);
    return () => window.removeEventListener(PERF_HUD_EVENT, onToggle);
  }, []);

  // 降级是自动发生的，必须让用户知道为什么画面「变朴素了」，否则那看起来就
  // 像界面坏了。只在真正降级时播一次。
  useEffect(
    () =>
      onPerfDegrade((reason) => {
        toast.info("已进入性能模式", {
          description: `${reason}。已停掉装饰动画并关闭窗口特效，重启应用即恢复。`,
          showTimestamp: false,
        });
      }),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setSnapshot(getPerfSnapshot());
    refresh();
    const timer = window.setInterval(refresh, 250);
    const unsubscribe = subscribePerf(refresh);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [enabled]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(perfReport());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用时把报告打到控制台，仍然拿得到。
      console.info(perfReport());
    }
  }, []);

  if (!enabled) return null;

  const refreshHz = Math.max(30, Math.round(snapshot.refreshHz));
  const history = snapshot.fpsHistory.slice(-48);
  const peak = Math.max(refreshHz, ...history, 1);
  const worstSpan = snapshot.spans.reduce<PerfSnapshot["spans"][number] | null>(
    (worst, span) => (!worst || span.ms > worst.ms ? span : worst),
    null,
  );

  return (
    <div
      data-perf-hud
      className="pointer-events-auto fixed bottom-3 left-3 z-[2147483000] w-[268px] select-none rounded-lg border border-stroke/70 bg-background-base/95 p-2.5 font-mono text-[11px] leading-4 text-content/80 shadow-2xl backdrop-blur"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className={`text-base font-semibold tabular-nums ${tone(snapshot.fps, refreshHz)}`}>
          {snapshot.fps}
          <span className="ml-0.5 text-[10px] font-normal text-content/40">fps</span>
        </span>
        <span className="tabular-nums text-content/45">
          {snapshot.frameMs}ms · p95 {snapshot.p95Ms}ms
        </span>
        <button
          type="button"
          onClick={() => togglePerfHud(false)}
          className="rounded px-1 text-content/40 hover:bg-content/10 hover:text-content"
          title="关闭"
          aria-label="关闭性能面板"
        >
          ×
        </button>
      </div>

      {/* 最近 48 秒的帧率：一眼看出「什么时候开始掉的」。 */}
      <div className="mb-2 flex h-7 items-end gap-[2px]">
        {history.length ? (
          history.map((value, index) => (
            <span
              key={index}
              className={`flex-1 rounded-[1px] ${value >= refreshHz * 0.85 ? "bg-emerald-400/70" : value >= refreshHz * 0.55 ? "bg-amber-400/80" : "bg-red-400/85"}`}
              style={{ height: `${Math.max(6, Math.min(100, (value / peak) * 100))}%` }}
              title={`${value} fps`}
            />
          ))
        ) : (
          <span className="text-content/30">正在采样…</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums text-content/60">
        <span>
          jank <b className="text-content/85">{snapshot.janks}</b>
        </span>
        <span>
          停顿 <b className={snapshot.stalls ? "text-amber-400" : "text-content/85"}>{snapshot.stalls}</b>
        </span>
        <span>
          卡死 <b className={snapshot.freezes ? "text-red-400" : "text-content/85"}>{snapshot.freezes}</b>
        </span>
        <span>
          最长 <b className="text-content/85">{snapshot.worstMs}ms</b>
        </span>
        <span>
          长任务 <b className="text-content/85">{snapshot.longTasks || "—"}</b>
        </span>
        <span>
          堆 <b className="text-content/85">{snapshot.heapMB === null ? "—" : `${snapshot.heapMB}MB`}</b>
        </span>
      </div>

      <div className="mt-1.5 space-y-1">
        <Bar value={snapshot.fps} max={refreshHz} className={snapshot.fps >= refreshHz * 0.85 ? "bg-emerald-400" : "bg-red-400"} />
        <div className="flex items-center justify-between text-[10px] text-content/40">
          <span>DOM {snapshot.domNodes}</span>
          <span>{snapshot.refreshHz}Hz · {snapshot.visible ? "前台" : "后台"}</span>
        </div>
      </div>

      {worstSpan ? (
        <div className="mt-1.5 truncate text-[10px] text-content/45" title={`${worstSpan.name} ${worstSpan.ms}ms`}>
          最近操作 · {worstSpan.name} {worstSpan.ms}ms{worstSpan.dropped ? `（掉 ${worstSpan.dropped} 帧）` : ""}
        </div>
      ) : null}

      {snapshot.stallsRecent.length ? (
        <div className="mt-1.5 space-y-0.5 border-t border-stroke/50 pt-1.5 text-[10px] text-content/45">
          {snapshot.stallsRecent.slice(-3).map((stall, index) => (
            <div key={index} className="truncate" title={`${stall.gapMs}ms · ${stall.span ?? ""}`}>
              <span className={stall.kind === "freeze" ? "text-red-400" : stall.kind === "stall" ? "text-amber-400" : "text-content/55"}>
                {stall.kind}
              </span>{" "}
              {stall.gapMs}ms{stall.span ? ` · ${stall.span}` : ""}
            </div>
          ))}
        </div>
      ) : null}

      {snapshot.degraded ? (
        <div className="mt-1.5 rounded bg-amber-400/10 px-1.5 py-1 text-[10px] text-amber-400">已自动降级：{snapshot.degradeReason}</div>
      ) : null}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded border border-stroke/60 px-1.5 py-0.5 text-[10px] text-content/70 hover:bg-content/10 hover:text-content"
        >
          {copied ? "已复制" : "复制报告"}
        </button>
        <button
          type="button"
          onClick={() => {
            resetPerfStats();
            setSnapshot(getPerfSnapshot());
          }}
          className="rounded border border-stroke/60 px-1.5 py-0.5 text-[10px] text-content/70 hover:bg-content/10 hover:text-content"
        >
          重置
        </button>
        <span className="ml-auto text-[10px] text-content/25">⌘⇧P</span>
      </div>
    </div>
  );
}
