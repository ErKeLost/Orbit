import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../lib/store";
import { MatchText } from "../../shared/ui/MatchText";
import { Search } from "../../shared/ui/icons";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { mentionLabel, mentionTokenAt, rankMentionFiles, type MentionFile } from "./fileMentions";
import { useComposerTokens } from "./composerTokens";

export type PaletteRequest = { kind: "slash" | "mention"; query: string; start: number; end: number };

/** A row that was picked: the text to write, and the file it points at. */
export type PalettePick = { text: string; file?: MentionFile; label?: string };

/** What the caret is currently completing, if anything. */
export function paletteRequest(value: string, caret: number): PaletteRequest | null {
  // `@` mentions can appear anywhere; `/` commands only lead the message.
  const mention = mentionTokenAt(value, caret);
  if (mention) return { kind: "mention", query: mention.query, start: mention.start, end: mention.end };
  const before = value.slice(0, caret);
  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[1] ?? "", start: 0, end: caret };
  return null;
}

const SOURCE_LABEL: Record<string, string> = { skill: "技能", extension: "扩展", prompt: "模板" };

type Row = {
  id: string;
  pick: PalettePick;
  /** File name, or `/command`. */
  title: string;
  /** Command source badge, or the folder a file lives in. */
  note: string;
  description: string;
  file: MentionFile | null;
  positions: number[];
};

/**
 * Orbit's composer palettes: `/` lists the harness commands, `@` lists
 * project files and folders. Rows are keyboard-navigable; choosing one writes
 * the token into the draft.
 */
export function ComposerPalette({
  request: pending,
  onPick,
  onClose,
}: {
  request: PaletteRequest;
  onPick: (pick: PalettePick) => void;
  onClose: () => void;
}) {
  const cwd = useWorkspace((state) => state.cwd);
  const tokens = useComposerTokens(cwd, { commands: pending.kind === "slash" });
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const needle = pending.query.toLowerCase();
    if (pending.kind === "slash") {
      return tokens.commands
        .filter((command) => !command.name.startsWith("gui-"))
        .filter((command) => !needle || command.name.toLowerCase().includes(needle))
        .slice(0, 24)
        .map((command) => ({
          id: `/add-${command.name}`,
          pick: { text: `/${command.name} ` },
          title: `/${command.name}`,
          note: SOURCE_LABEL[command.source] ?? command.source,
          description: command.description ?? "",
          file: null,
          positions: [],
        }));
    }
    return rankMentionFiles(tokens.files, pending.query).map((file) => {
      const label = mentionLabel(file, tokens.index);
      return {
        id: `@${file.relative}`,
        pick: { text: `@${label}`, file, label },
        title: file.name,
        note: file.isDir ? "" : file.relative.split("/").slice(0, -1).join("/"),
        description: "",
        file,
        positions: file.positions,
      };
    });
  }, [pending.kind, pending.query, tokens.commands, tokens.files, tokens.index]);

  useEffect(() => setActive(0), [pending.kind, pending.query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The textarea keeps focus; the owner forwards arrow/Enter/Escape here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(rows.length - 1, index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Enter" || event.key === "Tab") {
        const row = rows[active];
        if (!row) return;
        event.preventDefault();
        onPick(row.pick);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onClose, onPick, rows]);

  const empty =
    pending.kind === "slash"
      ? tokens.commandsLoading
        ? "正在读取命令…"
        : pending.query.trim()
          ? "没有匹配的命令"
          : "没有可用的命令"
      : tokens.filesLoading
        ? "正在索引文件…"
        : pending.query.trim()
          ? "没有匹配的文件或文件夹"
          : "没有找到文件或文件夹";

  return (
    <div data-mention-picker className="overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl">
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-[12px] text-content/50">{empty}</p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label={pending.kind === "slash" ? "命令与技能" : "文件与文件夹"}
          className="max-h-[min(240px,40vh)] overflow-y-auto overscroll-none px-1 py-1"
        >
          {rows.map((row, index) => {
            const highlighted = index === active;
            if (pending.kind === "mention") {
              // Match positions index the whole relative path; the name and the
              // folder each paint their own slice of it.
              const relative = row.file?.relative ?? "";
              const slash = relative.lastIndexOf("/");
              const offset = slash === -1 ? 0 : slash + 1;
              const namePositions = row.positions.filter((position) => position >= offset).map((position) => position - offset);
              const dirPositions = row.positions.filter((position) => position < slash);
              const typed = Boolean(pending.query.trim());
              return (
                <button
                  key={row.id}
                  data-row={index}
                  type="button"
                  role="option"
                  aria-selected={highlighted}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onPick(row.pick)}
                  className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none ${
                    highlighted ? "bg-selection text-content" : "text-content"
                  }`}
                >
                  <span className="shrink-0">
                    <FileTypeIcon name={row.title} isDir={Boolean(row.file?.isDir)} size={15} />
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${highlighted ? "text-mention" : ""}`}>
                    <MatchText text={row.title} positions={namePositions} active={typed} />
                    {row.file?.isDir ? "/" : null}
                  </span>
                  {row.note ? (
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-content/40">
                      <MatchText text={row.note} positions={dirPositions} active={typed} />
                    </span>
                  ) : null}
                </button>
              );
            }
            return (
              <button
                key={row.id}
                data-row={index}
                type="button"
                role="option"
                aria-selected={highlighted}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(row.pick)}
                className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                  highlighted ? "bg-selection text-content" : "text-content"
                }`}
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="truncate text-[13px]">{row.title}</span>
                  {row.note ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-content/40">{row.note}</span>
                  ) : null}
                </span>
                {row.description ? (
                  <span className="line-clamp-2 text-[11px] leading-4 text-content/50">{row.description}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {pending.kind === "slash" ? (
        <div className="flex w-full items-center gap-2 border-t border-stroke px-2.5 py-2 text-left text-[12px] text-content/70">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          继续输入以筛选 · ↑↓ 选择 · Enter 插入 · Esc 关闭
        </div>
      ) : null}
    </div>
  );
}
