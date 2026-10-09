import { useRef, useState } from "react";
import { Popover } from "../../shared/ui/Popover";
import { loadMessages, report, request } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function ringClass(ratio: number) {
  if (ratio >= 0.9) return "text-red-400";
  if (ratio >= 0.75) return "text-amber-400";
  return "text-content/45";
}

function MeterRing({ ratio, spinning }: { ratio: number; spinning?: boolean }) {
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className={`${ringClass(ratio)} ${spinning ? "animate-spin" : ""}`} aria-hidden>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} className="opacity-25" />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
}

/** MonoCode's context ring; its action is Pi's `compact`. */
export function ContextMeter({ usage, compacting }: { usage?: { used: number; window: number }; compacting: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const running = useWorkspace((state) => state.transcript.running);
  const cwd = useWorkspace((state) => state.cwd);
  const ratio = usage ? Math.min(1, Math.max(0, usage.used / usage.window)) : compacting ? 0.25 : null;
  if (ratio === null) return null;
  // The ring, the headline and the bar share one scale: calm is neutral, 75%
  // turns amber, 90% turns red — the same thresholds everywhere.
  const levelClass = ratio >= 0.9 ? "text-red-400" : ratio >= 0.75 ? "text-amber-400" : "text-content";
  const barClass = ratio >= 0.9 ? "bg-red-400" : ratio >= 0.75 ? "bg-amber-400" : "bg-accent";
  const headline = compacting ? "正在压缩上下文" : `${Math.round(ratio * 100)}% context used`;
  return (
    <div ref={root} className="relative shrink-0" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button
        type="button"
        title="Context usage"
        aria-label={`${headline}, ${usage ? `${compact.format(usage.used)} / ${compact.format(usage.window)} tokens` : "等待 Pi 更新用量"}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-m-1 grid rounded-sm p-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <MeterRing ratio={ratio} spinning={compacting} />
      </button>
      {hovered || open ? (
        <Popover anchor={root} side="top" align="end" onDismiss={() => setOpen(false)} className={`w-60 px-3 py-2.5 ${open ? "" : "pointer-events-none"}`}>
          <div className="space-y-2">
            <div className={`text-[13px] font-semibold leading-4 ${compacting ? "text-content" : levelClass}`}>{headline}</div>
            {/* A stale bar under “正在压缩” would be a lie: the old usage died with the compaction. */}
            {usage && !compacting ? (
              <>
                <div className="h-1 overflow-hidden rounded-full bg-content/10">
                  <div className={`h-full rounded-full transition-[width] duration-300 ${barClass}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
                </div>
                <div className="flex items-baseline justify-between text-[11px] leading-4 text-content/50">
                  <span className="font-mono">{compact.format(usage.used)} / {compact.format(usage.window)}</span>
                  <span>tokens</span>
                </div>
              </>
            ) : (
              <div className="text-[11px] leading-4 text-content/50">等待 Pi 更新用量</div>
            )}
            {open ? (
              <button
                type="button"
                disabled={running || compacting}
                title={running ? "等待当前回复结束" : "压缩这段对话的上下文"}
                onClick={() => {
                  setOpen(false);
                  void request({ type: "compact" }, 180000).then(() => loadMessages(cwd)).catch(report);
                }}
                className="w-full rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[11px] text-content hover:bg-content/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                立即压缩
              </button>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
