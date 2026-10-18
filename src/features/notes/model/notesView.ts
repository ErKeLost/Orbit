import {
  normalizeNoteTags,
  noteSourceProject,
  noteTitle,
  type Note,
  type NoteUpsert,
} from "../notes";

/**
 * Pure Notes view model: list filtering/sorting/selection, the draft → save
 * state machine, tag input parsing and drop-target math. The modal shell and
 * editor keep their hooks; persistence still goes through `../notes`.
 */

export type NoteEdits = Partial<Pick<Note, "title" | "body" | "tags">>;

export function filterNotes(notes: readonly Note[], query: string): readonly Note[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return notes;
  const tagNeedle = needle.replace(/^#/, "");
  return notes.filter((note) => {
    const project = noteSourceProject(note.sourceCwd)?.toLowerCase() ?? "";
    return (
      note.title.toLowerCase().includes(needle) ||
      note.body.toLowerCase().includes(needle) ||
      note.slug.toLowerCase().includes(needle) ||
      note.tags.some((tag) => tag.includes(tagNeedle)) ||
      project.includes(needle)
    );
  });
}

/** Newest first; the id tiebreaker keeps list order stable across saves. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function applySavedNote(notes: readonly Note[], saved: Note): Note[] {
  return sortNotes(notes.map((item) => (item.id === saved.id ? saved : item)));
}

export function pickNoteAfterLoad(
  next: readonly Note[],
  current: string | null,
  remembered: string | null,
): string | null {
  const preferred = current ?? remembered;
  if (preferred && next.some((note) => note.id === preferred)) return preferred;
  return next[0]?.id ?? null;
}

export function pickNoteAfterDelete(
  next: readonly Note[],
  deletedId: string,
  current: string | null,
): string | null {
  if (current !== deletedId) return current;
  return next[0]?.id ?? null;
}

export function selectVisibleNote(
  visible: readonly Note[],
  notes: readonly Note[],
  selectedId: string | null,
): Note | null {
  return (
    visible.find((note) => note.id === selectedId) ??
    notes.find((note) => note.id === selectedId) ??
    null
  );
}

export function isBlankNote(note: Pick<Note, "body" | "title">): boolean {
  return !note.body.trim() && note.title === "Untitled";
}

export function canAddNoteToChat(body: string): boolean {
  return Boolean(body.trim());
}

export function noteDraft(
  note: Note,
  edits: { title: string; body: string; tags: string[]; sourceCwd?: string },
): Note {
  return {
    ...note,
    title: edits.title.trim() || noteTitle(edits.body),
    body: edits.body,
    tags: edits.tags,
    sourceCwd: edits.sourceCwd,
  };
}

export function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/**
 * A focused title keeps blank/spaced drafts verbatim; on blur an empty title
 * falls back to the first markdown heading, then to "Untitled".
 */
export function resolveNoteTitle(input: {
  draftTitle?: string;
  currentTitle: string;
  body: string;
  titleFocused: boolean;
}): string {
  return (
    (input.draftTitle ?? input.currentTitle).trim() ||
    (input.titleFocused ? input.currentTitle : noteTitle(input.body))
  );
}

export function isNoteDirty(
  current: Pick<Note, "title" | "body" | "tags" | "sourceCwd">,
  next: { title: string; body: string; tags: readonly string[]; projectPath?: string | null },
): boolean {
  const hasProject = next.projectPath !== undefined && next.projectPath !== null;
  return !(
    next.title === current.title &&
    next.body === current.body &&
    sameTags(next.tags, current.tags) &&
    (!hasProject || next.projectPath === current.sourceCwd)
  );
}

/** Drop only the edits that were part of the accepted save request. */
export function remainingNoteEdits(
  edits: NoteEdits,
  changes: NoteEdits,
  options: { titleFocused: boolean },
): NoteEdits {
  const remaining = { ...edits };
  if (remaining.title === changes.title && !options.titleFocused) delete remaining.title;
  if (remaining.body === changes.body) delete remaining.body;
  if (remaining.tags === changes.tags) delete remaining.tags;
  return remaining;
}

export function noteUpsertInput(
  current: Pick<Note, "id">,
  next: { title: string; body: string; tags: string[]; projectPath?: string | null },
): NoteUpsert {
  const hasProject = next.projectPath !== undefined && next.projectPath !== null;
  return {
    id: current.id,
    title: next.title,
    body: next.body,
    tags: next.tags,
    ...(hasProject ? { sourceCwd: next.projectPath! } : {}),
  };
}

/* -------------------------------------------------------------- tag input */

export function parseTagInput(value: string): { action: "add" | "draft"; value: string } {
  if (value.endsWith(",")) return { action: "add", value: value.slice(0, -1) };
  return { action: "draft", value };
}

export function resolveTagKeyDown(input: {
  key: string;
  value: string;
  tagCount: number;
}): "add" | "remove-last" | null {
  if (input.key === "Enter" || input.key === ",") return "add";
  if (input.key === "Backspace" && !input.value && input.tagCount > 0) return "remove-last";
  return null;
}

export function resolveTitleKeyDown(key: string): "blur" | null {
  return key === "Enter" ? "blur" : null;
}

export function resolveNotesEscapeKey(key: string): "close" | null {
  return key === "Escape" ? "close" : null;
}

/* ----------------------------------------------------------- image drops */

export function hasDroppedFiles<T extends { types: ArrayLike<string> }>(data: T | null | undefined): data is T {
  if (!data) return false;
  return Array.from(data.types).some(
    (type) => type === "Files" || type === "application/x-moz-file",
  );
}

/** Tauri reports physical pixels on Retina; React drag events use CSS pixels. */
export function toClientPoint(input: {
  x: number;
  y: number;
  devicePixelRatio: number;
  innerWidth: number;
  innerHeight: number;
}): { x: number; y: number } {
  const scale = input.devicePixelRatio || 1;
  if (scale !== 1 && (input.x > input.innerWidth || input.y > input.innerHeight)) {
    return { x: input.x / scale, y: input.y / scale };
  }
  return { x: input.x, y: input.y };
}

export function isPointInRect(
  point: { x: number; y: number },
  rect: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

export function isDropThrottled(lastDropAt: number, now: number, windowMs = 250): boolean {
  return now - lastDropAt < windowMs;
}

/* ------------------------------------------------------------ save queue */

type NoteSaveQueue = { pending: Promise<void>; saved?: Note };

// Keep pending saves ordered across editor unmounts and reopened notes.
const noteSaveQueues = new Map<string, NoteSaveQueue>();

export function enqueueNoteSave(
  id: string,
  save: (latest?: Note) => void | Promise<Note | void>,
): Promise<void> {
  const queue = noteSaveQueues.get(id) ?? { pending: Promise.resolve() };
  const persist = async () => {
    const saved = await save(queue.saved);
    if (saved) queue.saved = saved;
  };
  const pending = queue.pending.then(persist, persist).finally(() => {
    if (queue.pending === pending) noteSaveQueues.delete(id);
  });
  queue.pending = pending;
  noteSaveQueues.set(id, queue);
  return pending;
}

/** Test hook: forget queued/persisted state between cases. */
export function resetNoteSaveQueues() {
  noteSaveQueues.clear();
}

/** Normalize the tags editor draft list through the storage rules. */
export function addNoteTag(tags: readonly string[], input: string): string[] {
  return normalizeNoteTags([...tags, input]);
}
