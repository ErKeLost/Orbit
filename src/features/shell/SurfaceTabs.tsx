import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { report } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { useTabCloseMotion } from "../../shared/hooks/useTabCloseMotion";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { TabLabel } from "../../shared/ui/TabLabel";
import { MenuItem, MenuSeparator, PointMenu } from "../../shared/ui/controls";
import { GripVertical, X } from "../../shared/ui/icons";
import { TabWidthMotion } from "./ClosingTab";
import { FileTypeIcon } from "./FileTypeIcon";
import { IS_MAC } from "./chrome";
import { setTabDrop, tabDropFromPoint } from "./paneDrop";
import { useActiveWorkspace, useShell, type OpenFile } from "./shellStore";
import { useDrafts } from "../../lib/drafts";

type TabMenu = { x: number; y: number; path: string };

/** Stable identity so a pane with no state yet does not invalidate memos. */
const NO_FILES: OpenFile[] = [];

/**
 * One editor pane's tab strip, ported from Orbit's
 * `features/workspace/ui/SurfaceTabs.tsx`. Every pane owns its tabs: the strip
 * holds the pane's drag handle, `w-56` tabs that reorder by dragging their
 * body, and a close button per tab. Dragging a tab onto another pane's strip
 * moves it there; onto a pane edge it opens in a new pane.
 */
export function SurfaceTabs({
  paneId,
  showGrip,
  onPaneDragStart,
  trailing,
}: {
  paneId: string;
  showGrip: boolean;
  /** Orbit's pane grip: dragging it moves this pane onto another pane's edge. */
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  trailing?: ReactNode;
}) {
  const pane = useActiveWorkspace((workspace) => workspace.panes[paneId]);
  const focusPane = useShell((state) => state.focusPane);
  const focusFile = useShell((state) => state.focusFile);
  const pinFile = useShell((state) => state.pinFile);
  const closeFile = useShell((state) => state.closeFile);
  const reorderFiles = useShell((state) => state.reorderFiles);
  const moveFileToPane = useShell((state) => state.moveFileToPane);
  const openFileInNewPane = useShell((state) => state.openFileInNewPane);
  const cwd = useWorkspace((state) => state.cwd);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const files = pane?.files ?? NO_FILES;
  // Which open tabs have unsaved text (`lib/drafts`), so a dot can stand where
  // the close button normally sits.
  const drafts = useDrafts((state) => state.drafts);

  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const items = useMemo(() => files.map((file) => ({ id: file.path, file })), [files]);
  const externalDrop = useMemo(
    () => ({
      onMove: (path: string, event: globalThis.PointerEvent) => {
        // The dragged tab rides under the pointer; ignore it when hit-testing.
        const skip = (element: Element) => Boolean(element.closest('[data-tab-dragging="true"]'));
        const target = tabDropFromPoint(event.clientX, event.clientY, skip);
        if (!target || target.toPane === paneId) {
          setTabDrop(null);
          return false;
        }
        setTabDrop({ path, fromPane: paneId, toPane: target.toPane, edge: target.edge });
        return true;
      },
      onDrop: (path: string, event: globalThis.PointerEvent) => {
        const skip = (element: Element) => Boolean(element.closest('[data-tab-dragging="true"]'));
        const target = tabDropFromPoint(event.clientX, event.clientY, skip);
        setTabDrop(null);
        if (!target || target.toPane === paneId) return false;
        if (target.edge) openFileInNewPane(path, target.toPane, target.edge);
        else moveFileToPane(path, paneId, target.toPane);
        return true;
      },
      onEnd: () => setTabDrop(null),
    }),
    [moveFileToPane, openFileInNewPane, paneId],
  );
  const sortable = useAnimatedReorder(paths, (ids) => reorderFiles(paneId, ids), "x", externalDrop);
  const { displayed, setTabNode, finishMotion } = useTabCloseMotion(items);
  const menuFile = menu ? files.find((file) => file.path === menu.path) : undefined;

  const leaveStrip = useCallback(() => setTabDrop(null), []);

  useLayoutEffect(() => {
    if (sortable.draggingId) return;
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [pane?.activeFile, sortable.draggingId]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(report);
  };
  const relative = (path: string) =>
    cwd && path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\//, "") : path;

  const runMenuAction = (action: string) => {
    if (!menuFile) return;
    setMenu(null);
    switch (action) {
      case "close":
        closeFile(menuFile.path, paneId);
        return;
      case "close-others":
        for (const file of files) {
          if (file.path !== menuFile.path) closeFile(file.path, paneId);
        }
        focusFile(menuFile.path, paneId);
        return;
      case "open-default":
        void openPath(menuFile.path).catch(report);
        return;
      case "reveal":
        void revealItemInDir(menuFile.path).catch(report);
        return;
      case "copy-path":
        copy(menuFile.path);
        return;
      case "copy-relative-path":
        copy(relative(menuFile.path));
        return;
      case "copy-name":
        copy(menuFile.name);
        return;
      default:
        return;
    }
  };

  return (
    <div className="flex h-9 min-w-0 shrink-0 items-center border-b border-stroke">
      <div
        ref={lockOverscroll}
        role="tablist"
        aria-label="打开的文件"
        data-tab-strip={paneId}
        onPointerLeave={leaveStrip}
        className="scrollbar-none flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-none pl-1.5 pr-2.5"
      >
        {showGrip && onPaneDragStart ? (
          <div
            role="button"
            tabIndex={-1}
            title="拖动以调整面板位置"
            aria-label="拖动以调整面板位置"
            className="grid h-7.5 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-md text-content/35 hover:bg-content/5 hover:text-content/70 active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              onPaneDragStart(event);
            }}
          >
            <GripVertical className="size-3.5" strokeWidth={1.75} />
          </div>
        ) : null}
        {displayed.map((entry) => {
          const file = entry.item.file;
          const closing = entry.closing;
          const opening = entry.opening;
          const active = !closing && file.path === pane?.activeFile;
          const dirty = file.path in drafts;
          const tab = (
            <div
              ref={(el) => {
                if (closing) return;
                setTabNode(file.path, el);
                sortable.setItemRef(file.path, el);
                if (el && file.path === pane?.activeFile) activeTabRef.current = el;
              }}
              className={
                closing || opening
                  ? "tab-motion group relative flex h-full w-full min-w-0 items-center overflow-hidden"
                  : "reorder-item tab-motion group relative flex h-full w-56 min-w-28 shrink touch-none items-center"
              }
              data-tab-dragging={!closing && sortable.draggingId === file.path ? "true" : undefined}
              onPointerDown={(event) => {
                if (closing || event.button !== 0) return;
                if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
                focusPane(paneId);
                focusFile(file.path, paneId);
                sortable.onItemPointerDown(file.path, event);
              }}
              onAuxClick={(event) => {
                if (closing || event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                closeFile(file.path, paneId);
              }}
              onContextMenu={(event) => {
                if (closing) return;
                event.preventDefault();
                event.stopPropagation();
                focusFile(file.path, paneId);
                setMenu({ x: event.clientX, y: event.clientY, path: file.path });
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={file.path}
                onClick={() => {
                  if (sortable.consumeClick()) return;
                  focusFile(file.path, paneId);
                }}
                onDoubleClick={() => pinFile(file.path, paneId)}
                className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 pr-7 text-left text-[13px] ${
                  active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
                }`}
              >
                <span className="grid shrink-0 place-items-center">
                  <FileTypeIcon name={file.name} isDir={false} size={14} />
                </span>
                <TabLabel className={`flex-1 ${file.preview ? "italic" : ""}`}>{file.name}</TabLabel>
              </button>
              {dirty ? <span aria-label="有未保存的修改" title="有未保存的修改" className="absolute right-1 top-1/2 size-2 -translate-y-1/2 rounded-full bg-accent group-hover:opacity-0" /> : null}
              <button
                type="button"
                data-no-drag
                data-tauri-drag-region="false"
                title={`关闭 ${file.name}`}
                aria-label={`关闭 ${file.name}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  closeFile(file.path, paneId);
                }}
                className={`absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <X className="size-3" strokeWidth={1.75} />
              </button>
            </div>
          );
          if (entry.closing || entry.opening) {
            return (
              <TabWidthMotion
                key={file.path}
                phase={entry.closing ? "closing" : "opening"}
                width={entry.width}
                onFinish={() => finishMotion(file.path)}
              >
                {tab}
              </TabWidthMotion>
            );
          }
          return (
            <div key={file.path} className="contents">
              {tab}
            </div>
          );
        })}
        {showGrip && onPaneDragStart ? (
          // Orbit makes the empty area to the right of the tabs a pane drag
          // handle too, so the whole strip moves the pane.
          <div
            className="h-full min-w-4 flex-1 cursor-grab active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              onPaneDragStart(event);
            }}
          />
        ) : null}
      </div>
      {trailing}
      {menu && menuFile ? (
        <PointMenu x={menu.x} y={menu.y} label="文件标签操作" onClose={() => setMenu(null)}>
          <MenuItem danger onClick={() => runMenuAction("close")}>
            关闭
          </MenuItem>
          <MenuItem disabled={files.length < 2} onClick={() => runMenuAction("close-others")}>
            关闭其他
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => runMenuAction("open-default")}>用默认应用打开</MenuItem>
          <MenuItem onClick={() => runMenuAction("reveal")}>
            {IS_MAC ? "在访达中显示" : "在文件管理器中显示"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => runMenuAction("copy-path")}>复制路径</MenuItem>
          <MenuItem onClick={() => runMenuAction("copy-relative-path")}>复制相对路径</MenuItem>
          <MenuItem onClick={() => runMenuAction("copy-name")}>复制文件名</MenuItem>
        </PointMenu>
      ) : null}
    </div>
  );
}
