import { artifactLabel, type ArtifactCard as Card } from "../artifacts";
import { ArtifactIcon } from "./ArtifactCard";
import { openArtifactPanel } from "./openArtifact";

/**
 * 对话里的产物卡片。
 *
 * 它只是**指路**：内容是另外一栏的事（`openArtifactPanel`）。早期版本点开是
 * 就地展开，但一页 HTML 会把回复撑成很长一段，读起来反而找不到刚才那句。
 */
export function InlineArtifact({ card }: { card: Card }) {
  return (
    <button
      type="button"
      data-artifact-card={card.id}
      onClick={() => openArtifactPanel(card.id)}
      title={`在右栏打开${artifactLabel(card.kind)}`}
      className="flex w-fit max-w-[min(24rem,100%)] min-w-0 items-center gap-2.5 min-h-[38px] rounded-xl border border-line py-2 pr-3.5 pl-3 text-left text-ink-1 transition-colors hover:border-line-strong hover:bg-fill focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <ArtifactIcon kind={card.kind} className="size-4 shrink-0 text-ink-2" />
      <span className="min-w-0 truncate text-ui">{card.title}</span>
      <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-3">{artifactLabel(card.kind)}</span>
    </button>
  );
}
