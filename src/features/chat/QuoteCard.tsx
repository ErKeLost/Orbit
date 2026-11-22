import { Quote, X } from "../../shared/ui/icons";
import { quoteExcerpt } from "./quote";

/**
 * A quote attached to the draft. Same column as the field — same inset, same
 * type size — not a card, a rule, or a hairline inside the box. `ink-3` / `ink-2`
 * is what marks it as context; the draft stays `ink-1`.
 */
export function ComposerQuote({
  text,
  role,
  onClear,
}: {
  text: string;
  role: "user" | "assistant";
  onClear: () => void;
}) {
  const excerpt = quoteExcerpt(text, 220);
  return (
    <div role="group" aria-label="引用" data-composer-quote className="flex items-start gap-1 px-3 pt-2">
      <span className="min-w-0 flex-1">
        <span className="block text-2xs leading-4 text-ink-3">{role === "assistant" ? "引用回复" : "引用消息"}</span>
        <span className="block line-clamp-2 break-words font-sans text-sm leading-5.5 text-ink-2" title={excerpt.endsWith("\u2026") ? text : undefined}>
          {excerpt}
        </span>
      </span>
      <button
        type="button"
        title="取消引用"
        aria-label="取消引用"
        onClick={onClear}
        className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-fill-strong hover:text-ink-1 focus-visible:bg-fill-strong focus-visible:text-ink-1"
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** Sent quotes stay in the message flow, above the bubble. */
export function QuoteCard({
  text,
  onClear,
  lines = 2,
  className = "",
}: {
  text: string;
  onClear?: () => void;
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
