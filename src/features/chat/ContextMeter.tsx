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
  const headline = compacting ? "正在压缩上下文" : `${Math.round(ratio * 100)}% context used`;
  const detail = usage ? `${compact.format(usage.used)} / ${compact.format(usage.window)} tokens` : "等待 Pi 更新用量";
  return (
    <div ref={root} className="relative shrink-0" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button
        type="button"
        title="Context usage"
        aria-label={`${headline}, ${detail}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-m-1 grid rounded-sm p-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <MeterRing ratio={ratio} spinning={compacting} />
      </button>
      {hovered || open ? (
        <Popover anchor={root} side="top" align="end" onDismiss={() => setOpen(false)} className={`w-max px-2.5 py-1.5 ${open ? "" : "pointer-events-none"}`}>
          <div className="text-[12px] leading-4 text-content">{headline}</div>
          <div className="text-[11px] leading-4 text-content/50">{detail}</div>
          {open ? (
            <button
              type="button"
              disabled={running || compacting}
              title={running ? "等待当前回复结束" : "压缩这段对话的上下文"}
              onClick={() => {
                setOpen(false);
                void request({ type: "compact" }, 180000).then(() => loadMessages(cwd)).catch(report);
              }}
              className="mt-1.5 w-full rounded-md bg-content/10 px-2 py-1 text-[11px] text-content hover:bg-content/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              立即压缩
            </button>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
