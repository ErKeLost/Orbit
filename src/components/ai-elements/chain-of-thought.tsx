// Adapted from Beautiful UI's Reasoning variant. See docs/licenses/beautiful-ui.txt.
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/Icon";
import { ElapsedTime } from "./elapsed-time";
import { StableShimmer } from "./stable-shimmer";
import "./thinking-state.css";

export function ProcessingPanel({
  running,
  startedAt,
  durationMs,
  defaultExpanded,
  clock,
  children,
}: {
  running: boolean;
  /** live: 本轮计时一直挂在这一段（轮次首段）；hidden: 同一轮被 steer 拆出的后续段，不重复计时。 */
  clock?: "live" | "hidden";
  startedAt?: number;
  durationMs?: number;
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? defaultExpanded ?? running;
  const panelId = useId();

  return (
    <section className="turn-activity" data-open={expanded} data-working={running}>
      <Button
        type="button"
        variant="ghost"
        className="turn-activity-header"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpandedOverride(!expanded)}
      >
        {clock === "hidden"
          ? (running ? <StableShimmer text="正在处理" className="ai-elapsed-time processing-time-shimmer" /> : <span className="ai-elapsed-time"><span className="ai-elapsed-time-label">处理过程</span></span>)
          : <ElapsedTime
            running={running || clock === "live"}
            startedAt={startedAt}
            durationMs={durationMs}
            locale="zh"
            prefix={running || clock === "live" ? "正在处理 " : "用时 "}
            shimmer={running || clock === "live"}
          />}
        <Icon name="caret-right" className="turn-activity-chevron" aria-hidden="true" />
      </Button>
      <span className="turn-activity-rule" aria-hidden="true" />
      <div id={panelId} className="turn-activity-panel" aria-hidden={!expanded} inert={!expanded}>
        <div className="turn-activity-panel-inner">{children}</div>
      </div>
    </section>
  );
}

export function ThinkingSummary({ text, running }: { text: string; running: boolean }) {
  const summary = text.replace(/\s+/g, " ").trim() || "正在思考";
  // 流式期间这一行以 background-clip:text 的流动渐变逐帧重绘，且每批 delta
  // 都更新一次；文本越长重绘面积越大。视觉上本来就是单行截断，这里只保留
  // 尾部展示，完整内容仍在 title 里。
  const visible = summary.length > 200 ? `…${summary.slice(-199)}` : summary;
  return (
    <div className="thinking-summary" data-working={running} title={summary}>
      {running
        ? <StableShimmer text={visible} className="thinking-summary-text" />
        : <span className="thinking-summary-text">{visible}</span>}
    </div>
  );
}
