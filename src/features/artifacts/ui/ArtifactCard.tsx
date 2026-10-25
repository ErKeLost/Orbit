import { ChartBreakoutSquare, File } from "../../../shared/ui/icons";
import { artifactLabel, type ArtifactCard as Card } from "../artifacts";

export function ArtifactIcon({ kind, className }: { kind: Card["kind"]; className?: string }) {
  const Icon = kind === "html" ? ChartBreakoutSquare : File;
  return <Icon className={className} strokeWidth={1.75} />;
}

/**
 * 回复下方那一行：产物的图标和标题。
 *
 * 图标让它区别于旁边那些会话卡片（它们以状态打头），高度则和它们对齐——
 * 那一行的高度是项目芯片定的。
 */
export function ArtifactCard({ card, onOpen }: { card: Card; onOpen?: (id: string) => void }) {
  const label = artifactLabel(card.kind);
  return (
    <button
      type="button"
      data-artifact-card={card.id}
      aria-label={`打开${label} ${card.title}`}
      title={`打开${label}`}
      onClick={() => onOpen?.(card.id)}
      disabled={!onOpen}
      className="flex w-fit max-w-[min(24rem,100%)] min-w-0 items-center gap-2.5 min-h-[38px] rounded-xl border border-content/10 py-2 pr-3.5 pl-3 text-left font-sans transition-colors hover:border-content/20 hover:bg-content/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
    >
      <ArtifactIcon kind={card.kind} className="size-4 shrink-0 text-content/55" />
      <span className="min-w-0 truncate text-[13px] text-content">{card.title}</span>
    </button>
  );
}
