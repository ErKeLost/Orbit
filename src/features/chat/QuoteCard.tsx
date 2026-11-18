import { Quote, X } from "../../shared/ui/icons";
import { quoteExcerpt } from "./quote";

/**
 * A quote is a solid card, not a hollow outline with a caption.
 * The mark is an icon; the words are the quoted text itself.
 */
export function QuoteCard({
  text,
  onClear,
  floating = false,
  lines = 2,
  className = "",
}: {
  text: string;
  onClear?: () => void;
  /** Sits on the composer. Transcript quotes stay in the message flow. */
  floating?: boolean;
  lines?: 2 | 4;
  className?: string;
}) {
  const excerpt = quoteExcerpt(text, lines === 2 ? 220 : 420);
  return (
    <div
      role="group"
      aria-label="引用"
      className={`flex w-fit max-w-[min(100%,36rem)] items-center gap-2.5 rounded-xl border border-line bg-surface-card py-2 pl-3 dark:bg-surface-raised ${
        onClear ? "pr-1.5" : "pr-3"
      } ${
        floating
          ? "shadow-[0_8px_24px_-10px_rgb(15_23_42/0.18),0_1px_2px_rgb(15_23_42/0.06)] dark:shadow-[0_10px_28px_-12px_rgb(0_0_0/0.55)]"
          : ""
      } ${className}`}
    >
      <Quote className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <p title={excerpt.endsWith("\u2026") ? excerpt : undefined} className={`min-w-0 break-words text-sm font-medium leading-5 text-ink-1 ${lines === 4 ? "line-clamp-4" : "line-clamp-2"}`}>
        {excerpt}
      </p>
      {onClear ? (
        <button
          type="button"
          title="取消引用"
          aria-label="取消引用"
          onClick={onClear}
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill-strong hover:text-ink-1"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
