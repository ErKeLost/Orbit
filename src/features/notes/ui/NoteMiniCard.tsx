import { File, X } from "../../../shared/ui/icons";
import {
  noteSourceProject,
  type NoteCardMeta,
} from "../notes";

type Props = {
  card: NoteCardMeta;
  onDismiss?: () => void;
  embedded?: boolean;
};

export function NoteMiniCard({ card, onDismiss, embedded = false }: Props) {
  const project = noteSourceProject(card.sourceCwd);

  const inner = (
    <div
      className={`relative rounded-md border border-content/10 bg-content/6 px-2.5 py-2 ${
        onDismiss ? "pr-8" : ""
      }`}
    >
      <div className="flex w-full flex-col text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <File
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-[11px] text-content/50">
            Note{!embedded && card.slug ? ` · ${card.slug}` : ""}
          </span>
        </span>
        <span className="mt-1 line-clamp-1 text-[13px] font-semibold leading-snug text-content">
          {card.title || "Untitled"}
        </span>
        {!embedded && project ? (
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-content/45">
            <span className="min-w-0 truncate">{project}</span>
          </span>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          title="Remove"
          aria-label={`Remove note ${card.title || "Untitled"}`}
          onClick={onDismiss}
          className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );

  if (embedded) return inner;
  return <div className="px-3 pt-2">{inner}</div>;
}
