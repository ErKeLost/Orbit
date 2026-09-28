import { memo, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MetalFx } from "metal-fx";
import { useTheme } from "next-themes";
import { useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useMetrics } from "../../hooks/use-metrics";
import { useWorkspace } from "../../lib/store";
import { contextSegments, type ContextSegment } from "../../lib/context-breakdown";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const formatTokens = (tokens: number) => tokens > 0 && tokens < 1000 ? tokens.toLocaleString("en-US") : compact.format(tokens);
const ICON_RADIUS = 10;
const ICON_CENTER = 12;

function UsageIcon({ used, max }: { used: number; max: number }) {
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = max > 0 ? Math.min(1, used / max) : 0;
  return <svg aria-hidden="true" height="22" viewBox="0 0 24 24" width="22">
    <circle cx={ICON_CENTER} cy={ICON_CENTER} fill="none" opacity="0.25" r={ICON_RADIUS} stroke="currentColor" strokeWidth="2" />
    <circle cx={ICON_CENTER} cy={ICON_CENTER} fill="none" opacity="0.7" r={ICON_RADIUS} stroke="currentColor" strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - usedPercent)} strokeLinecap="round" strokeWidth="2" style={{ transform: "rotate(-90deg)", transformOrigin: "center" }} />
  </svg>;
}

function UsageBar({ segments, total, windowTokens }: { segments: ContextSegment[]; total: number; windowTokens: number }) {
  const width = Math.max(1, windowTokens);
  return <div className="context-usage-bar" role="img" aria-label="上下文分段用量">
    {segments.map(segment => segment.tokens > 0 ? <span key={segment.id} style={{ width: `${(segment.tokens / width) * 100}%`, background: segment.color }} /> : null)}
    {total < windowTokens ? <span className="context-usage-rest" style={{ width: `${((windowTokens - total) / width) * 100}%` }} /> : null}
  </div>;
}

function UsagePanel({
  className,
  percent,
  waiting,
  usedTokens,
  reportedMaxTokens,
  maxTokens,
  segments,
  onClose,
  panelRef,
}: {
  className: string;
  percent: number | null;
  waiting: boolean;
  usedTokens: number | null;
  reportedMaxTokens: number | null;
  maxTokens: number;
  segments: ContextSegment[];
  onClose: () => void;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return <div ref={panelRef} className={className} role="dialog" aria-label="Context Usage">
    <header>
      <strong>Context Usage</strong>
      <Button type="button" variant="ghost" size="icon-sm" className="context-usage-close" aria-label="关闭" onClick={onClose}><X /></Button>
    </header>
    <div className="context-usage-headline">
      <span>{percent == null ? "—" : `${Math.round(percent)}% Full`}</span>
      <span>{waiting || reportedMaxTokens == null ? "等待数据" : `~${formatTokens(usedTokens ?? 0)} / ${formatTokens(reportedMaxTokens)} Tokens`}</span>
    </div>
    <UsageBar segments={waiting ? [] : segments} total={usedTokens ?? 0} windowTokens={reportedMaxTokens ?? maxTokens} />
    <ul>
      {segments.map(segment => <li key={segment.id}>
        <span><i style={{ background: segment.color }} />{segment.label}</span>
        <span>{waiting && segment.id === "messages" ? "—" : `~${formatTokens(segment.tokens)}`}</span>
      </li>)}
    </ul>
  </div>;
}

function ComposerContextImpl({ placement = "composer", container }: { placement?: "composer" | "header"; container?: RefObject<HTMLElement | null> } = {}) {
  const { stats, runtime, online } = useMetrics();
  const state = useWorkspace(workspace => workspace.state);
  const compacting = useWorkspace(workspace => workspace.transcript.compacting);
  const { resolvedTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const usage = stats?.contextUsage;
  const usedTokens = usage?.tokens ?? null;
  const reportedMaxTokens = usage?.contextWindow ?? state?.model?.contextWindow ?? null;
  const maxTokens = Math.max(1, reportedMaxTokens ?? 1);
  const percent = usage?.percent ?? (usedTokens == null || reportedMaxTokens == null ? null : (usedTokens / reportedMaxTokens) * 100);
  const segments = contextSegments(runtime?.breakdown ?? {}, usedTokens);
  const waiting = usedTokens == null;

  useEffect(() => {
    if (!open || placement !== "composer") return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, placement]);

  const trigger = compacting
    ? <MetalFx preset="chromatic" variant="circle" strength={1} innerShadow theme={resolvedTheme === "dark" ? "dark" : "light"} paused={!!reducedMotion} className="composer-context-metal">
        <Button type="button" variant="ghost" className={`composer-context-trigger composer-context-trigger-${placement}`} title="正在压缩上下文" aria-label="正在压缩上下文" aria-busy="true" aria-expanded={open} onClick={() => setOpen(value => !value)}><UsageIcon used={usedTokens ?? 0} max={maxTokens} /></Button>
      </MetalFx>
    : <Button type="button" variant="ghost" className={`composer-context-trigger composer-context-trigger-${placement}`} disabled={!online} title="Context Usage" aria-label="上下文用量" aria-expanded={open} onClick={() => setOpen(value => !value)}><UsageIcon used={usedTokens ?? 0} max={maxTokens} /></Button>;

  const panel = <UsagePanel
    className={`context-usage-popover context-usage-popover-${placement}`}
    percent={percent}
    waiting={waiting}
    usedTokens={usedTokens}
    reportedMaxTokens={reportedMaxTokens}
    maxTokens={maxTokens}
    segments={segments}
    onClose={() => setOpen(false)}
    panelRef={panelRef}
  />;

  if (placement === "header") {
    return <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={compacting
        ? <MetalFx preset="chromatic" variant="circle" strength={1} innerShadow theme={resolvedTheme === "dark" ? "dark" : "light"} paused={!!reducedMotion} className="composer-context-metal">
            <Button type="button" variant="ghost" className={`composer-context-trigger composer-context-trigger-${placement}`} title="正在压缩上下文" aria-label="正在压缩上下文" aria-busy="true"><UsageIcon used={usedTokens ?? 0} max={maxTokens} /></Button>
          </MetalFx>
        : <Button type="button" variant="ghost" className={`composer-context-trigger composer-context-trigger-${placement}`} disabled={!online} title="Context Usage" aria-label="上下文用量"><UsageIcon used={usedTokens ?? 0} max={maxTokens} /></Button>} />
      <PopoverContent side="top" align="center" sideOffset={8} className="context-usage-popover context-usage-popover-header">
        <UsagePanel
          className="context-usage-popover-inner"
          percent={percent}
          waiting={waiting}
          usedTokens={usedTokens}
          reportedMaxTokens={reportedMaxTokens}
          maxTokens={maxTokens}
          segments={segments}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>;
  }

  return <div ref={triggerRef} className="composer-context-anchor">
    {trigger}
    {open && container?.current ? createPortal(panel, container.current) : null}
  </div>;
}

export const ComposerContext = memo(ComposerContextImpl);
