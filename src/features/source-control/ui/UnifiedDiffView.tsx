import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FoldVertical,
  MessageSquarePlus,
  Undo2,
  UnfoldVertical,
} from "../../../shared/ui/icons";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileTypeIcon } from "../../files/ui/FileTypeIcon";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { useColorScheme } from "../../../shared/hooks/useColorScheme";
import { formatInteger } from "../../../shared/lib/numbers";
import type { ColorScheme } from "../../settings/model/appearance";
import { basename } from "../../../platform/tauri/fs";
import { highlightDiffFile, type SyntaxToken } from "../../files/editor/syntaxTokens";
import { DiffCommentComposer } from "./DiffCommentComposer";
import {
  expandFold,
  type FoldReveal,
  type UnifiedBlock,
  type UnifiedLine,
} from "../model/unifiedDiff";
import {
  flattenVisibleRows,
  layoutRows,
  UNIFIED_FOLD_PX,
  UNIFIED_LINE_PX,
  UNIFIED_OVERSCAN_PX,
  windowRows,
  type RowWindow,
} from "../model/unifiedDiffWindow";
import {
  splitColumnWidth,
  toSplitRows,
  type SplitCell,
  type SplitRow,
} from "../model/splitDiff";

export type UnifiedDiffFileModel = {
  id: string;
  path: string;
  label: string;
  binary?: boolean;
  tooLarge?: boolean;
  emptyMessage?: string;
  additions: number;
  deletions: number;
  blocks: UnifiedBlock[];
  canStage?: boolean;
  canDiscard?: boolean;
  canStageHunk?: boolean;
};

type FileLayout = "stacked" | "cards";
type InitialExpansion = "all" | "first" | "none";

type Props = {
  files: UnifiedDiffFileModel[];
  truncated?: boolean;
  fileCount?: number;
  focusPath?: string;
  focusId?: string;
  busyId?: string | null;
  totals?: { additions: number; deletions: number };
  /** Fill the parent pane and scroll inside. Off when the parent already scrolls. */
  fill?: boolean;
  /** Changes uses a continuous stack; embedded review surfaces can use cards. */
  fileLayout?: FileLayout;
  /** Applied when a new set of files is loaded. */
  initialExpansion?: InitialExpansion;
  onStageFile?: (id: string) => void;
  onDiscardFile?: (id: string) => void;
  onStageHunk?: (id: string, pos: number) => void;
};

export function UnifiedDiffView({
  files,
  truncated,
  fileCount,
  focusPath,
  focusId,
  busyId,
  totals,
  fill = true,
  fileLayout = "stacked",
  initialExpansion = "all",
  onStageFile,
  onDiscardFile,
  onStageHunk,
}: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const colorScheme = useColorScheme();
  const [open, setOpen] = useState<Set<string>>(() =>
    initiallyOpenFiles(files, initialExpansion),
  );
  const [reveals, setReveals] = useState<
    Record<string, Record<string, FoldReveal>>
  >({});
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const fileKey = useMemo(
    () => files.map((file) => file.id).join("\n"),
    [files],
  );
  const resolvedFocusId = useMemo(
    () =>
      focusId ??
      files.find((file) => file.path === focusPath || file.id === focusPath)
        ?.id,
    [fileKey, files, focusId, focusPath],
  );

  useEffect(() => {
    setOpen(initiallyOpenFiles(files, initialExpansion));
    setReveals({});
  }, [fileKey, initialExpansion]);

  useEffect(() => {
    if (!resolvedFocusId) return;
    const node = fileRefs.current.get(resolvedFocusId);
    if (!node) return;
    const scroller = scrollerRef.current;
    if (!scroller) {
      // Embedded review surfaces jump in from a file list, so open the file
      // and let the ancestor that owns scrolling bring it up.
      setOpen((current) =>
        current.has(resolvedFocusId)
          ? current
          : new Set(current).add(resolvedFocusId),
      );
      node.scrollIntoView({ block: "start" });
      return;
    }
    const top = node.offsetTop - 8;
    scroller.scrollTo({ top: Math.max(0, top) });
  }, [resolvedFocusId, fileKey]);

  const bindScroller = useCallback(
    (el: HTMLDivElement | null) => {
      // In embedded mode an ancestor owns vertical scrolling. Leaving this
      // null makes each file discover that real scroll root.
      scrollerRef.current = fill ? el : null;
      lockOverscroll(fill ? el : null);
    },
    [fill, lockOverscroll],
  );

  const toggleFile = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const revealFold = useCallback(
    (
      fileId: string,
      foldId: string,
      total: number,
      direction: "up" | "down" | "all",
    ) => {
      setReveals((current) => ({
        ...current,
        [fileId]: {
          ...current[fileId],
          [foldId]: expandFold(current[fileId]?.[foldId], total, direction),
        },
      }));
    },
    [],
  );

  const bindFileRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node) fileRefs.current.set(id, node);
    else fileRefs.current.delete(id);
  }, []);

  if (files.length === 0) {
    return (
      <p className="px-4 py-6 text-[13px] text-content/45">没有文件更改</p>
    );
  }

  const count = fileCount ?? files.length;
  const fileLabel = count === 1 ? "1 file" : `${count} files`;
  const additions =
    totals?.additions ?? files.reduce((sum, file) => sum + file.additions, 0);
  const deletions =
    totals?.deletions ?? files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div
      className={
        fill
          ? "flex h-full min-h-0 flex-1 flex-col overflow-hidden"
          : "flex flex-col"
      }
    >
      <div
        className={`flex h-8 shrink-0 items-center gap-3 border-b border-stroke px-3 text-[12px]`}
      >
        <span className="text-content/70">{fileLabel}</span>
        <DiffCounts additions={additions} deletions={deletions} />
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title="展开全部文件"
            aria-label="展开全部文件"
            onClick={() => setOpen(new Set(files.map((file) => file.id)))}
            className="grid size-7 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <UnfoldVertical className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="折叠全部文件"
            aria-label="折叠全部文件"
            disabled={open.size === 0}
            onClick={() => setOpen(new Set())}
            className="grid size-7 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:opacity-40"
          >
            <FoldVertical className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>
      <div
        ref={bindScroller}
        className={
          fill
            ? "unified-diff min-h-0 flex-1 overflow-y-auto overscroll-none"
            : "unified-diff"
        }
      >
        {truncated ? (
          <p className="px-3 py-3 text-[12px] text-content/45">
            Diff is too large to display in full. File list is shown without
            patches.
          </p>
        ) : null}
        <div
          className={
            fileLayout === "cards"
              ? "flex flex-col gap-2 pt-2"
              : "flex flex-col"
          }
        >
          {files.map((file) => (
            <FileSection
              key={file.id}
              file={file}
              expanded={open.has(file.id)}
              focused={resolvedFocusId === file.id}
              busy={busyId === file.id}
              reveals={reveals[file.id] ?? EMPTY_REVEALS}
              fileLayout={fileLayout}
              colorScheme={colorScheme}
              scrollerRef={scrollerRef}
              onToggle={toggleFile}
              onReveal={revealFold}
              onStageFile={onStageFile}
              onDiscardFile={onDiscardFile}
              onStageHunk={onStageHunk}
              bindRef={bindFileRef}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

type FileSectionProps = {
  file: UnifiedDiffFileModel;
  expanded: boolean;
  focused: boolean;
  busy: boolean;
  reveals: Record<string, FoldReveal>;
  fileLayout: FileLayout;
  colorScheme: ColorScheme;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onToggle: (id: string) => void;
  onReveal: (
    fileId: string,
    foldId: string,
    total: number,
    direction: "up" | "down" | "all",
  ) => void;
  onStageFile?: (id: string) => void;
  onDiscardFile?: (id: string) => void;
  onStageHunk?: (id: string, pos: number) => void;
  bindRef: (path: string, node: HTMLElement | null) => void;
};

const FileSection = memo(function FileSection({
  file,
  expanded,
  focused,
  busy,
  reveals,
  fileLayout,
  colorScheme,
  scrollerRef,
  onToggle,
  onReveal,
  onStageFile,
  onDiscardFile,
  onStageHunk,
  bindRef,
}: FileSectionProps) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const name = basename(file.path);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [near, setNear] = useState(false);
  const [tokens, setTokens] = useState<Map<UnifiedLine, SyntaxToken[]> | null>(
    null,
  );

  useEffect(() => {
    if (!expanded || !near) return;
    let cancelled = false;
    void highlightDiffFile(file, colorScheme).then((next) => {
      if (!cancelled) setTokens(next);
    });
    return () => {
      cancelled = true;
    };
  }, [colorScheme, expanded, file, near]);

  const setSection = useCallback(
    (node: HTMLElement | null) => {
      sectionRef.current = node;
      bindRef(file.id, node);
    },
    [bindRef, file.id],
  );

  useLayoutEffect(() => {
    if (!expanded) return;
    const section = sectionRef.current;
    if (!section) return;
    const root = scrollerRef.current ?? verticalScrollParent(section);
    setNear(isNearViewport(section, root, 800));
  }, [expanded, scrollerRef, file.id]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || !expanded) return;
    const root = scrollerRef.current ?? verticalScrollParent(section);
    const observer = new IntersectionObserver(
      ([entry]) => {
        const next = entry.isIntersecting;
        setNear((current) => (current === next ? current : next));
      },
      { root, rootMargin: "800px 0px", threshold: 0 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, [expanded, scrollerRef]);

  return (
    <section
      ref={setSection}
      data-diff-file={file.path}
      className={`${
        fileLayout === "cards"
          ? "overflow-hidden rounded-md border border-content/10"
          : ""
      } ${focused ? "bg-content/[0.03]" : ""}`}
    >
      <header
        className={`${
          fileLayout === "stacked" ? "sticky top-0 z-30 backdrop-blur-xl" : ""
        } flex items-center gap-2 bg-content/2 px-3 py-1.5 ${
          fileLayout === "stacked" || expanded
            ? "border-b border-stroke"
            : ""
        }`}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggle(file.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Chevron
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <FileTypeIcon name={name} isDir={false} size={16} />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-content/85"
            title={file.label}
          >
            {/* Codex-style file header: the directories recede, the file name
                carries the row. */}
            {name.length < file.label.length ? (
              <span className="text-content/45">
                {file.label.slice(0, file.label.length - name.length)}
              </span>
            ) : null}
            {name}
          </span>
          <DiffCounts additions={file.additions} deletions={file.deletions} />
        </button>
        {file.canDiscard && onDiscardFile ? (
          <IconButton
            title="放弃此文件"
            disabled={busy}
            onClick={() => onDiscardFile(file.id)}
          >
            <Undo2 className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        ) : null}
        {file.canStage && onStageFile ? (
          <button
            type="button"
            title="暂存此文件"
            aria-label="暂存此文件"
            disabled={busy}
            onClick={() => onStageFile(file.id)}
            className="grid size-4 place-items-center rounded-[3px] bg-content text-background-base hover:opacity-80 disabled:opacity-40"
          >
            <Check className="size-2.5" strokeWidth={2.5} />
          </button>
        ) : null}
      </header>
      {expanded ? (
        <FileBody
          file={file}
          reveals={reveals}
          near={near}
          tokens={tokens}
          scrollerRef={scrollerRef}
          onReveal={(foldId, direction) => {
            const block = file.blocks.find(
              (entry) => entry.kind === "fold" && entry.id === foldId,
            );
            const total = block?.kind === "fold" ? block.lines.length : 0;
            onReveal(file.id, foldId, total, direction);
          }}
          onStageHunk={onStageHunk}
        />
      ) : null}
    </section>
  );
}, equalFileSectionProps);

const EMPTY_REVEALS: Record<string, FoldReveal> = {};

function equalFileSectionProps(
  previous: FileSectionProps,
  next: FileSectionProps,
): boolean {
  return (
    equalFileModel(previous.file, next.file) &&
    previous.expanded === next.expanded &&
    previous.focused === next.focused &&
    previous.busy === next.busy &&
    previous.reveals === next.reveals &&
    previous.fileLayout === next.fileLayout &&
    previous.colorScheme === next.colorScheme &&
    previous.scrollerRef === next.scrollerRef &&
    previous.onToggle === next.onToggle &&
    previous.onReveal === next.onReveal &&
    previous.onStageFile === next.onStageFile &&
    previous.onDiscardFile === next.onDiscardFile &&
    previous.onStageHunk === next.onStageHunk &&
    previous.bindRef === next.bindRef
  );
}

function equalFileModel(
  previous: UnifiedDiffFileModel,
  next: UnifiedDiffFileModel,
): boolean {
  return (
    previous.id === next.id &&
    previous.path === next.path &&
    previous.label === next.label &&
    previous.binary === next.binary &&
    previous.tooLarge === next.tooLarge &&
    previous.emptyMessage === next.emptyMessage &&
    previous.additions === next.additions &&
    previous.deletions === next.deletions &&
    (previous.blocks === next.blocks ||
      (previous.blocks.length === 0 && next.blocks.length === 0)) &&
    previous.canStage === next.canStage &&
    previous.canDiscard === next.canDiscard &&
    previous.canStageHunk === next.canStageHunk
  );
}

function FileBody({
  file,
  reveals,
  near,
  tokens,
  scrollerRef,
  onReveal,
  onStageHunk,
}: {
  file: UnifiedDiffFileModel;
  reveals: Record<string, FoldReveal>;
  near: boolean;
  tokens: Map<UnifiedLine, SyntaxToken[]> | null;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onReveal: (foldId: string, direction: "up" | "down" | "all") => void;
  onStageHunk?: (id: string, pos: number) => void;
}) {
  if (file.binary) return <EmptyBody>二进制文件有改动</EmptyBody>;
  if (file.tooLarge) return <EmptyBody>差异过大，无法显示</EmptyBody>;
  if (file.emptyMessage) return <EmptyBody>{file.emptyMessage}</EmptyBody>;
  if (file.blocks.length === 0) return <EmptyBody>没有文本差异</EmptyBody>;

  return (
    <VirtualRows
      fileId={file.id}
      filePath={file.path}
      blocks={file.blocks}
      reveals={reveals}
      near={near}
      tokens={tokens}
      canStageHunk={file.canStageHunk}
      scrollerRef={scrollerRef}
      onReveal={onReveal}
      onStageHunk={onStageHunk}
    />
  );
}

function VirtualRows({
  fileId,
  filePath,
  blocks,
  reveals,
  near,
  tokens,
  canStageHunk,
  scrollerRef,
  onReveal,
  onStageHunk,
}: {
  fileId: string;
  filePath: string;
  blocks: UnifiedBlock[];
  reveals: Record<string, FoldReveal>;
  near: boolean;
  tokens: Map<UnifiedLine, SyntaxToken[]> | null;
  canStageHunk?: boolean;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onReveal: (foldId: string, direction: "up" | "down" | "all") => void;
  onStageHunk?: (id: string, pos: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const mouseYRef = useRef<number | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<DiffCommentDraft | null>(
    null,
  );
  const rows = useMemo(
    () =>
      // Fold mechanics first — they own the reveal state — then the split
      // pairing: the k-th deletion meets the k-th insertion, the short side
      // gets a void cell that renders as hatching.
      toSplitRows(
        flattenVisibleRows(
          blocks,
          (foldId) => reveals[foldId],
          !!canStageHunk && !!onStageHunk,
        ),
      ),
    [blocks, canStageHunk, fileId, onStageHunk, reveals],
  );
  const rowLayout = useMemo(() => layoutRows(rows), [rows]);
  const totalHeight = rowLayout.totalHeight;
  // Both columns size to the longest line either shows, so the halves stay
  // aligned while the whole grid scrolls horizontally together; the slack per
  // column covers gutter, marker and padding.
  const minWidthCh = useMemo(() => splitColumnWidth(rows) * 2 + 26, [rows]);
  const [range, setRange] = useState<RowWindow>(() => ({
    start: 0,
    end: 0,
    padTop: 0,
    padBottom: totalHeight,
  }));

  const updateWindow = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const root = scrollerRef.current ?? verticalScrollParent(body);
    const rootRect = root
      ? root.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const bodyRect = body.getBoundingClientRect();
    const next = windowRows(
      rows,
      rootRect.top - bodyRect.top,
      rootRect.bottom - bodyRect.top,
      UNIFIED_OVERSCAN_PX,
      rowLayout,
    );
    setRange((current) =>
      current.start === next.start &&
      current.end === next.end &&
      current.padTop === next.padTop &&
      current.padBottom === next.padBottom
        ? current
        : next,
    );
  }, [rowLayout, rows, scrollerRef]);

  const hoverAtY = useCallback(
    (clientY: number | null) => {
      const body = bodyRef.current;
      if (clientY == null || !body) {
        setHoverKey((current) => (current == null ? current : null));
        return;
      }
      let y = clientY - body.getBoundingClientRect().top - range.padTop;
      if (y < 0) {
        setHoverKey((current) => (current == null ? current : null));
        return;
      }
      for (let index = range.start; index < range.end; index += 1) {
        const row = rows[index];
        if (!row) break;
        if (y < row.height) {
          const key = splitRowKey(row, index);
          setHoverKey((current) => (current === key ? current : key));
          return;
        }
        y -= row.height;
      }
      setHoverKey((current) => (current == null ? current : null));
    },
    [range.end, range.padTop, range.start, rows],
  );

  useLayoutEffect(() => {
    if (!near) return;
    updateWindow();
  }, [near, updateWindow, totalHeight]);

  useLayoutEffect(() => {
    if (!near) return;
    hoverAtY(mouseYRef.current);
  }, [hoverAtY, near]);

  useEffect(() => {
    if (!near) return;
    const body = bodyRef.current;
    const root =
      scrollerRef.current ?? (body ? verticalScrollParent(body) : null);
    const target: HTMLElement | Window = root ?? window;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateWindow();
        hoverAtY(mouseYRef.current);
      });
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [hoverAtY, near, scrollerRef, updateWindow]);

  useEffect(() => {
    if (!near) return;
    const code = codeRef.current;
    if (!code) return;

    // WebKit can latch a wheel gesture to this horizontal scroller instead of
    // chaining its vertical delta to the surrounding unified diff.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const ownScroller = scrollerRef.current;
      const verticalScroller =
        ownScroller && ownScroller.scrollHeight > ownScroller.clientHeight + 1
          ? ownScroller
          : verticalScrollParent(code, true);
      if (!verticalScroller) return;

      const scale =
        event.deltaMode === 1
          ? UNIFIED_LINE_PX
          : event.deltaMode === 2
            ? verticalScroller.clientHeight
            : 1;
      const before = verticalScroller.scrollTop;
      const max = verticalScroller.scrollHeight - verticalScroller.clientHeight;
      const next = Math.min(max, Math.max(0, before + event.deltaY * scale));
      if (next === before) return;

      event.preventDefault();
      verticalScroller.scrollTop = next;
    };

    code.addEventListener("wheel", onWheel, { passive: false });
    return () => code.removeEventListener("wheel", onWheel);
  }, [near, scrollerRef]);

  if (!near) {
    return <div style={{ height: totalHeight }} />;
  }

  const visible = rows.slice(range.start, range.end);
  const lanePad = {
    paddingTop: range.padTop,
    paddingBottom: range.padBottom,
  };

  const renderRow = (row: SplitRow, index: number) => {
    const key = splitRowKey(row, range.start + index);
    return (
      <SplitRowView
        key={key}
        row={row}
        hovered={hoverKey === key}
        commenting={commentTarget?.key === key}
        tokensLeft={
          row.type === "pair" && row.left.kind !== "void"
            ? tokens?.get(row.left.line)
            : undefined
        }
        tokensRight={
          row.type === "pair" && row.right.kind !== "void"
            ? tokens?.get(row.right.line)
            : undefined
        }
        onReveal={
          row.type === "fold"
            ? (direction) => onReveal(row.id, direction)
            : undefined
        }
        onComment={
          row.type === "pair"
            ? (line, anchor) => setCommentTarget({ key, line, anchor })
            : undefined
        }
        onStage={
          row.type === "pair" && row.stage && row.stagePos != null
            ? () => onStageHunk?.(fileId, row.stagePos as number)
            : undefined
        }
      />
    );
  };

  return (
    <>
      <div
        ref={bodyRef}
        className="min-w-0 flex-1"
        onMouseMove={(event) => {
          mouseYRef.current = event.clientY;
          hoverAtY(event.clientY);
        }}
        onMouseLeave={() => {
          mouseYRef.current = null;
          hoverAtY(null);
        }}
      >
        <div
          ref={codeRef}
          className="min-w-0 flex-1 overflow-x-auto overscroll-x-none"
        >
          <div style={{ ...lanePad, minWidth: `max(100%, ${minWidthCh}ch)` }}>
            {visible.map(renderRow)}
          </div>
        </div>
      </div>
      {commentTarget ? (
        <DiffCommentComposer
          path={filePath}
          target={commentTarget}
          onDismiss={() => setCommentTarget(null)}
        />
      ) : null}
    </>
  );
}

type DiffCommentDraft = {
  key: string;
  line: UnifiedLine;
  anchor: DOMRect;
};

function splitRowKey(row: SplitRow, index: number) {
  if (row.type === "fold") return `fold-${row.id}`;
  const left =
    row.left.kind === "void"
      ? "void"
      : `${row.left.line.oldNumber ?? "x"}/${row.left.line.newNumber ?? "x"}`;
  const right =
    row.right.kind === "void"
      ? "void"
      : `${row.right.line.newNumber ?? "x"}`;
  return `${index}-${left}-${right}`;
}

function SplitRowView({
  row,
  hovered,
  commenting,
  tokensLeft,
  tokensRight,
  onReveal,
  onComment,
  onStage,
}: {
  row: SplitRow;
  hovered: boolean;
  commenting: boolean;
  tokensLeft?: SyntaxToken[];
  tokensRight?: SyntaxToken[];
  onReveal?: (direction: "up" | "down" | "all") => void;
  onComment?: (line: UnifiedLine, anchor: DOMRect) => void;
  onStage?: () => void;
}) {
  if (row.type === "fold") {
    return <FoldBar hidden={row.hidden} onReveal={onReveal!} />;
  }
  return (
    <div className="flex items-stretch" style={{ height: row.height }}>
      <SplitHalf
        side="left"
        cell={row.left}
        hovered={hovered}
        commenting={commenting}
        tokens={tokensLeft}
        onComment={row.left.kind !== "void" ? onComment : undefined}
      />
      <SplitHalf
        side="right"
        cell={row.right}
        hovered={hovered}
        commenting={commenting}
        tokens={tokensRight}
        onComment={row.right.kind !== "void" ? onComment : undefined}
        onStage={onStage}
      />
    </div>
  );
}

function FoldBar({
  hidden,
  onReveal,
}: {
  hidden: number;
  onReveal: (direction: "up" | "down" | "all") => void;
}) {
  return (
    <div
      className="relative z-20 flex items-center gap-1 bg-content/8 px-2"
      style={{ height: UNIFIED_FOLD_PX }}
    >
      <button
        type="button"
        title="向上展开"
        aria-label="向上展开未修改的行"
        onClick={() => onReveal("up")}
        className="grid size-5 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
      >
        <ChevronUp className="size-3" strokeWidth={2} />
      </button>
      <button
        type="button"
        title="向下展开"
        aria-label="向下展开未修改的行"
        onClick={() => onReveal("down")}
        className="grid size-5 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content"
      >
        <ChevronDown className="size-3" strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => onReveal("all")}
        className="min-w-0 flex-1 py-1 text-left font-mono text-[11px] text-content/45 hover:text-content/70"
      >
        {hidden} unmodified {hidden === 1 ? "line" : "lines"}
      </button>
    </div>
  );
}

/** The hatched placeholder opposite a change: this side has no line here. */
function SplitVoid({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden="true"
      className={`split-diff-void w-1/2 shrink-0 grow-0 ${
        side === "right" ? "border-l border-stroke" : ""
      }`}
    />
  );
}

const SplitHalf = memo(function SplitHalf({
  side,
  cell,
  hovered,
  commenting,
  tokens,
  onComment,
  onStage,
}: {
  side: "left" | "right";
  cell: SplitCell;
  hovered: boolean;
  commenting: boolean;
  tokens?: SyntaxToken[];
  onComment?: (line: UnifiedLine, anchor: DOMRect) => void;
  onStage?: () => void;
}) {
  if (cell.kind === "void") return <SplitVoid side={side} />;
  const line = cell.line;
  const added = cell.kind === "add";
  const deleted = cell.kind === "del";
  const number = deleted ? line.oldNumber : line.newNumber;
  const row = added ? "bg-diff-add-bg" : deleted ? "bg-diff-del-bg" : "";
  // The change bar sits on each half's left edge — red before a removed line,
  // green before an added one, the middle divider for the new column.
  const markerBar = added
    ? "bg-diff-add-fg"
    : deleted
      ? "bg-diff-del-fg"
      : "";
  const gutterText = added
    ? "text-diff-add-fg"
    : deleted
      ? "text-diff-del-fg"
      : "text-content/35";
  const glyph = added ? "+" : deleted ? "−" : "";
  return (
    <div
      className={`relative flex w-1/2 min-w-0 items-center overflow-hidden ${
        side === "right" ? "border-l border-stroke" : ""
      } ${row}`}
      style={{ height: "100%" }}
    >
      {added || deleted ? (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 w-[2px] ${markerBar}`}
        />
      ) : null}
      <span className="w-10 shrink-0 pr-2 text-right font-mono text-[11px] leading-none tabular-nums text-content/35">
        {number ?? ""}
      </span>
      {/* Width is counted in minWidthCh. select-none keeps the glyph and the
          screen-reader cue out of copied code. */}
      <span
        className={`w-7 shrink-0 select-none pl-3 font-mono text-[12px] leading-none font-semibold ${gutterText}`}
      >
        <span aria-hidden="true">{glyph}</span>
        {added || deleted ? (
          <span className="sr-only">{added ? "Added: " : "Removed: "}</span>
        ) : null}
      </span>
      <span
        className={`whitespace-pre pr-3 font-mono text-[12px] leading-none text-content/80 ${
          cell.kind === "context" ? "opacity-70" : ""
        }`}
      >
        {renderLineText(line, tokens)}
      </span>
      {onComment ? (
        <button
          type="button"
          title={`Comment on line ${number ?? ""}`.trim()}
          aria-label={`Comment on line ${number ?? ""}`.trim()}
          onClick={(event) =>
            onComment(line, event.currentTarget.getBoundingClientRect())
          }
          className={`absolute top-0.5 left-0.5 z-10 grid size-4 place-items-center rounded-[3px] bg-content text-background-base outline-none transition-opacity hover:opacity-80 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/50 ${
            hovered || commenting
              ? "opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        >
          <MessageSquarePlus className="size-2.5" strokeWidth={2} />
        </button>
      ) : null}
      {onStage ? (
        <button
          type="button"
          title="暂存此块"
          aria-label="暂存此块"
          onClick={onStage}
          className={`absolute top-0.5 left-6 z-10 grid size-4 place-items-center rounded-[3px] bg-white text-[11px] font-bold text-black ${
            hovered ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          +
        </button>
      ) : null}
    </div>
  );
});

function renderLineText(line: UnifiedLine, tokens?: SyntaxToken[]) {
  const pieces = tokens && tokens.length > 0 ? tokens : [{ text: line.text }];
  if (pieces.length === 1 && !pieces[0]?.color) {
    return line.text;
  }
  return (
    <>
      {pieces.map((piece, index) => (
        <span
          key={index}
          style={piece.color ? { color: piece.color } : undefined}
        >
          {piece.text}
        </span>
      ))}
    </>
  );
}

function EmptyBody({ children }: { children: string }) {
  return <p className="px-3 py-3 text-[12px] text-content/45">{children}</p>;
}

function DiffCounts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-sans text-[11px] font-semibold tabular-nums">
      {additions > 0 ? (
        <span className="text-diff-add-fg">+{formatInteger(additions)}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-diff-del-fg">-{formatInteger(deletions)}</span>
      ) : null}
    </span>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function verticalScrollParent(
  el: HTMLElement,
  requireScrollable = false,
): HTMLElement | null {
  let current = el.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      (!requireScrollable || current.scrollHeight > current.clientHeight + 1)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isNearViewport(
  section: HTMLElement,
  root: HTMLElement | null,
  margin: number,
) {
  const bounds = section.getBoundingClientRect();
  const view = root
    ? root.getBoundingClientRect()
    : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  return bounds.bottom + margin > view.top && bounds.top - margin < view.bottom;
}

function initiallyOpenFiles(
  files: readonly UnifiedDiffFileModel[],
  mode: InitialExpansion,
): Set<string> {
  if (mode === "none" || files.length === 0) return new Set();
  if (mode === "first") return new Set([files[0].id]);
  return new Set(files.map((file) => file.id));
}
