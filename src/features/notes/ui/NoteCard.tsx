import { formatRelativeTime } from "../../../lib/time";
import { notePreview, noteSourceProject, type Note } from "../notes";
import { projectName } from "../../../shared/lib/paths";

function NoteProjectMark({ cwd }: { cwd: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">{projectName(cwd)}</span>
    </span>
  );
}

export function NoteCard({
  note,
  active,
  onSelect,
}: {
  note: Note;
  active: boolean;
  onSelect: () => void;
}) {
  const preview = notePreview(note.body, note.title);
  const project = noteSourceProject(note.sourceCwd);
  const time = formatRelativeTime(new Date(note.updatedAt).toISOString());
  const hint = [note.title, project].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      title={hint}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={`flex w-full flex-col rounded-md border px-2.5 py-2 text-left ${
        active
          ? "border-transparent bg-selection text-ink-1"
          : "border-transparent text-ink-1 hover:bg-fill hover:text-ink-1"
      }`}
    >
      <span className="flex items-center gap-2">
        {project && note.sourceCwd ? (
          <span className="min-w-0 flex-1 text-2xs text-ink-3">
            <NoteProjectMark cwd={note.sourceCwd} />
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {time ? (
          <span className="shrink-0 text-2xs tabular-nums text-ink-3">
            {time}
          </span>
        ) : null}
      </span>
      <span className="mt-1 line-clamp-1 text-ui font-semibold leading-snug text-ink-1">
        {note.title}
      </span>
      {preview ? (
        <span className="mt-1 line-clamp-1 text-xs leading-snug text-ink-3">
          {preview}
        </span>
      ) : null}
      {note.tags.length > 0 ? (
        <span className="mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden">
          {note.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="max-w-24 truncate rounded bg-fill-strong px-1.5 py-0.5 text-2xs leading-none text-ink-2"
            >
              #{tag}
            </span>
          ))}
          {note.tags.length > 3 ? (
            <span className="shrink-0 text-2xs text-ink-3">
              +{note.tags.length - 3}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
