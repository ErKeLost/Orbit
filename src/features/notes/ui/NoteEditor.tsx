import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMarkdownMode } from "../../chat/MarkdownModeToggle";
import { Markdown as AgentMarkdown } from "../../../components/Markdown";
import { mdxToMarkdown } from "../../../shared/lib/mdxLite";
import { MarkdownSourceEditor } from "../../chat/MarkdownSourceEditor";
import { SearchableProjectPicker } from "../../projects/ui/SearchableProjectPicker";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { formatRelativeTime } from "../../../lib/time";
import { MAX_NOTE_TAGS, noteTitle, upsertNote, type Note } from "../notes";
import {
  insertNoteImagesMarkdown,
  saveNoteImagesFromFiles,
  saveNoteImagesFromPaths,
  type NoteImageAsset,
} from "../noteImages";
import type { RecentProject } from "../../projects/model/recents";
import {
  addNoteTag,
  canAddNoteToChat,
  enqueueNoteSave,
  hasDroppedFiles,
  isBlankNote,
  isDropThrottled,
  isNoteDirty,
  isPointInRect,
  noteDraft,
  noteUpsertInput,
  parseTagInput,
  remainingNoteEdits,
  resolveNoteTitle,
  resolveTagKeyDown,
  resolveTitleKeyDown,
  sameTags,
  toClientPoint,
  type NoteEdits,
} from "../model/notesView";
import { File, Trash2, X } from "../../../shared/ui/icons";

function NoteDetailTab({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`relative flex h-9 items-center text-[12px] leading-none ${
        selected ? "text-content" : "text-content/50 hover:text-content"
      }`}
    >
      {label}
      {selected ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-content" />
      ) : null}
    </button>
  );
}

export function NoteDetail({
  note,
  recents,
  activeCwd,
  onSaved,
  onDelete,
  onAddToChat,
}: {
  note: Note | null;
  recents: RecentProject[];
  activeCwd?: string;
  onSaved: (note: Note) => void;
  onDelete: (id: string) => void | Promise<void>;
  onAddToChat: (note: Note) => void;
}) {
  if (!note) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <File className="mb-3 size-6 text-content/30" strokeWidth={1.75} />
        <p className="text-[13px] text-content/45">Select a note</p>
      </div>
    );
  }
  return (
    <NoteEditor
      key={note.id}
      note={note}
      recents={recents}
      activeCwd={activeCwd}
      onSaved={onSaved}
      onDelete={onDelete}
      onAddToChat={onAddToChat}
    />
  );
}

function NoteEditor({
  note,
  recents,
  activeCwd,
  onSaved,
  onDelete,
  onAddToChat,
}: {
  note: Note;
  recents: RecentProject[];
  activeCwd?: string;
  onSaved: (note: Note) => void;
  onDelete: (id: string) => void | Promise<void>;
  onAddToChat: (note: Note) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const blank = isBlankNote(note);
  const [mode, setMode] = useMarkdownMode(note.id);
  const [edits, setEdits] = useState<NoteEdits>({});
  const title = edits.title ?? note.title;
  const body = edits.body ?? note.body;
  // 预览同样过一层 MDX 折叠：粘贴进来的 docs 片段里的 <Tip>/<img> 能正常渲染。
  const noteMarkdown = useMemo(() => mdxToMarkdown(body), [body]);
  const tags = edits.tags ?? note.tags;
  // Keep only an unsaved choice locally so completed moves survive reopening.
  const [projectChange, setProjectChange] = useState<{ path: string } | null>(
    null,
  );
  const sourceCwd = projectChange?.path ?? note.sourceCwd;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageDrag, setImageDrag] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const editsRef = useRef(edits);
  const bodyRef = useRef(body);
  const projectChangeRef = useRef(projectChange);
  const noteRef = useRef(note);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const titleFieldRef = useRef<HTMLInputElement>(null);
  const sourceFieldRef = useRef<HTMLTextAreaElement>(null);
  const lastDropAt = useRef(0);
  const skipSave = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const onSavedRef = useRef(onSaved);
  bodyRef.current = body;
  noteRef.current = note;
  onSavedRef.current = onSaved;
  const time = formatRelativeTime(new Date(note.updatedAt).toISOString());

  useEffect(() => {
    if (blank) setMode("source");
    // New untitled notes open in source so typing isn't behind the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editNote = useCallback((change: NoteEdits) => {
    const next = { ...editsRef.current, ...change };
    editsRef.current = next;
    if (change.body !== undefined) bodyRef.current = change.body;
    setEdits(next);
  }, []);

  const persist = useCallback(async (latest?: Note) => {
    if (skipSave.current) return;
    const current = latest ?? noteRef.current;
    const changes = editsRef.current;
    const nextBody = changes.body ?? current.body;
    const titleFocused = document.activeElement === titleFieldRef.current;
    const nextTitle = resolveNoteTitle({
      draftTitle: changes.title,
      currentTitle: current.title,
      body: nextBody,
      titleFocused,
    });
    const nextTags = changes.tags ?? current.tags;
    const nextProject = projectChangeRef.current;
    const acceptSaved = (saved: Note) => {
      noteRef.current = saved;
      // A completed save only clears the edits included in that request.
      const remaining = remainingNoteEdits(editsRef.current, changes, {
        titleFocused: document.activeElement === titleFieldRef.current,
      });
      editsRef.current = remaining;
      bodyRef.current = remaining.body ?? saved.body;
      setEdits(remaining);
      if (projectChangeRef.current === nextProject) {
        projectChangeRef.current = null;
        setProjectChange(null);
      }
      setSaveError(null);
    };
    if (
      !isNoteDirty(current, {
        title: nextTitle,
        body: nextBody,
        tags: nextTags,
        projectPath: nextProject?.path ?? null,
      })
    ) {
      acceptSaved(current);
      return current;
    }
    try {
      const saved = await upsertNote(
        noteUpsertInput(current, {
          title: nextTitle,
          body: nextBody,
          tags: nextTags,
          projectPath: nextProject?.path ?? null,
        }),
      );
      acceptSaved(saved);
      onSavedRef.current(saved);
      return saved;
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return current;
    }
  }, []);

  const saveNow = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    return enqueueNoteSave(note.id, persist);
  }, [note.id, persist]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void saveNow();
    }, 400);
  }, [saveNow]);

  const insertionRange = useCallback(() => {
    const field = sourceFieldRef.current;
    if (!field) {
      const end = bodyRef.current.length;
      return { start: end, end };
    }
    return {
      start: field.selectionStart,
      end: field.selectionEnd,
    };
  }, []);

  const addDroppedImages = useCallback(
    async (
      load: () => Promise<NoteImageAsset[]>,
      range: { start: number; end: number },
    ) => {
      setImageBusy(true);
      setImageDrag(false);
      try {
        const images = await load();
        const inserted = insertNoteImagesMarkdown(
          bodyRef.current,
          range.start,
          range.end,
          images,
        );
        editNote({ body: inserted.value });
        setSaveError(null);
        scheduleSave();
        window.requestAnimationFrame(() => {
          const field = sourceFieldRef.current;
          if (!field) return;
          field.focus();
          field.setSelectionRange(inserted.cursor, inserted.cursor);
        });
      } catch (err: unknown) {
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setImageBusy(false);
      }
    },
    [editNote, scheduleSave],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const toPoint = (x: number, y: number) =>
      toClientPoint({
        x,
        y,
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      });
    const overDropZone = (x: number, y: number) => {
      const zone = dropZoneRef.current;
      if (!zone) return false;
      return isPointInRect(toPoint(x, y), zone.getBoundingClientRect());
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          setImageDrag(false);
          return;
        }
        const { x, y } = event.payload.position;
        const over = overDropZone(x, y);
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setImageDrag(over);
          return;
        }
        if (event.payload.type !== "drop") return;
        setImageDrag(false);
        if (!over || isDropThrottled(lastDropAt.current, Date.now())) return;
        lastDropAt.current = Date.now();
        const range = insertionRange();
        const paths = event.payload.paths;
        void addDroppedImages(
          () => saveNoteImagesFromPaths(note.id, paths),
          range,
        );
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addDroppedImages, insertionRange, note.id]);

  useEffect(() => {
    return () => {
      void saveNow();
    };
  }, [saveNow]);

  const onTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (resolveTitleKeyDown(event.key) !== "blur") return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  const canAddToChat = canAddNoteToChat(body);
  const draft = noteDraft(note, { title, body, tags, sourceCwd });

  return (
    <div
      ref={lockOverscroll}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-8 py-8">
        <header className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-content/50">
            <File className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span>Note</span>
            {note.slug ? (
              <span className="min-w-0 truncate">{note.slug}</span>
            ) : null}
            <SearchableProjectPicker
              cwd={sourceCwd ?? "~"}
              recents={recents}
              mode="move"
              railCwd={activeCwd}
              buttonClassName="px-1.5"
              onSelectProject={(path) => {
                const change = { path };
                projectChangeRef.current = change;
                setProjectChange(change);
                void saveNow();
              }}
            />
          </div>
          <input
            ref={titleFieldRef}
            value={title}
            onChange={(event) => {
              editNote({ title: event.target.value });
              scheduleSave();
            }}
            onBlur={() => {
              const next = title.trim() || noteTitle(body);
              if (next !== title) editNote({ title: next });
              void saveNow();
            }}
            onKeyDown={onTitleKeyDown}
            aria-label="Note title"
            className="w-full border-0 bg-transparent p-0 text-[20px] font-semibold leading-tight text-content outline-none placeholder:text-content/35"
            placeholder="Untitled"
          />
          {time ? (
            <div className="text-[12px] text-content/50">Updated {time}</div>
          ) : null}
          <NoteTagsEditor
            tags={tags}
            onChange={(next) => {
              editNote({ tags: next });
              scheduleSave();
            }}
          />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={!canAddToChat}
              onClick={() => onAddToChat(draft)}
              className="inline-flex items-center gap-1 rounded-md bg-content px-3 h-6.5 text-[12px] text-background-base hover:bg-content/80 disabled:cursor-default disabled:opacity-40"
            >
              Add to chat
            </button>
            <button
              type="button"
              onClick={() => {
                skipSave.current = true;
                if (saveTimer.current != null)
                  window.clearTimeout(saveTimer.current);
                void enqueueNoteSave(note.id, () => onDelete(note.id));
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-3 h-7 text-[12px] text-content/70 hover:bg-content/10 hover:text-red-400"
            >
              <Trash2 className="size-3.5" strokeWidth={1.75} />
              Delete
            </button>
          </div>
          {saveError ? (
            <div
              role="alert"
              className="flex items-center gap-2 text-[12px] text-red-400/90"
            >
              <span>Could not save note: {saveError}</span>
              <button
                type="button"
                onClick={() => {
                  setSaveError(null);
                  void saveNow();
                }}
                className="shrink-0 underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          ) : null}
        </header>
        <div
          role="tablist"
          aria-label="Note sections"
          className="flex h-9 items-stretch gap-4 border-b border-stroke"
        >
          <NoteDetailTab
            label="Preview"
            selected={mode === "preview"}
            onSelect={() => setMode("preview")}
          />
          <NoteDetailTab
            label="Source"
            selected={mode === "source"}
            onSelect={() => setMode("source")}
          />
        </div>
        <div
          ref={dropZoneRef}
          aria-busy={imageBusy}
          className={`relative min-h-[448px] rounded-lg border transition-colors ${
            imageDrag ? "border-accent/60 bg-accent/5" : "border-transparent"
          }`}
          onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasDroppedFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setImageDrag(true);
          }}
          onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
            const next = event.relatedTarget as Node | null;
            if (next && event.currentTarget.contains(next)) return;
            setImageDrag(false);
          }}
          onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasDroppedFiles(event.dataTransfer)) return;
            event.preventDefault();
            setImageDrag(false);
            if (isDropThrottled(lastDropAt.current, Date.now())) return;
            lastDropAt.current = Date.now();
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            const range = insertionRange();
            void addDroppedImages(
              () => saveNoteImagesFromFiles(note.id, files),
              range,
            );
          }}
        >
          {imageDrag || imageBusy ? (
            <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-lg bg-background-base/80 text-[12px] text-content/70 backdrop-blur-sm">
              {imageBusy ? "Adding images…" : "Drop images here"}
            </div>
          ) : null}
          {mode === "source" ? (
            <MarkdownSourceEditor
              textareaRef={sourceFieldRef}
              autoFocus={blank}
              value={body}
              onChange={(next) => {
                editNote({ body: next });
                scheduleSave();
              }}
            />
          ) : body.trim() ? (
            <AgentMarkdown content={noteMarkdown} />
          ) : (
            <p className="text-[13px] text-content/45">No description</p>
          )}
        </div>
      </div>
    </div>
  );
}

function NoteTagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [value, setValue] = useState("");

  const addTag = (input = value) => {
    const next = addNoteTag(tags, input);
    setValue("");
    if (!sameTags(next, tags)) onChange(next);
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      aria-label="Tags"
    >
      <span className="mr-0.5 text-[11px] text-content/45">Tags</span>
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-6 max-w-48 items-center gap-1 rounded-md bg-content/8 pl-2 pr-1 text-[11px] text-content/70"
        >
          <span className="truncate">#{tag}</span>
          <button
            type="button"
            title={`Remove #${tag}`}
            aria-label={`Remove #${tag}`}
            onClick={() => onChange(tags.filter((item) => item !== tag))}
            className="grid size-4 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
          >
            <X className="size-2.5" strokeWidth={1.75} />
          </button>
        </span>
      ))}
      {tags.length < MAX_NOTE_TAGS ? (
        <input
          value={value}
          onChange={(event) => {
            const parsed = parseTagInput(event.target.value);
            if (parsed.action === "add") addTag(parsed.value);
            else setValue(parsed.value);
          }}
          onBlur={() => {
            if (value.trim()) addTag();
          }}
          onKeyDown={(event) => {
            const action = resolveTagKeyDown({
              key: event.key,
              value,
              tagCount: tags.length,
            });
            if (action === "add") {
              event.preventDefault();
              addTag();
              return;
            }
            if (action === "remove-last") {
              onChange(tags.slice(0, -1));
            }
          }}
          aria-label="Add note tag"
          placeholder="Add tag…"
          spellCheck={false}
          autoComplete="off"
          className="h-6 min-w-20 flex-1 border-0 bg-transparent px-1 text-[11px] text-content outline-none placeholder:text-content/35"
        />
      ) : null}
    </div>
  );
}
