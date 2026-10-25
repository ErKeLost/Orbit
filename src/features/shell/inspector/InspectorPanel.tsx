import { useActiveWorkspace, useShell, type InspectorTab } from "../shellStore";
import { useWorkspace } from "../../../lib/store";
import { useDragResize } from "../../../shared/hooks/useDragResize";
import { ResizeHandle } from "../chrome";
import { FileTree } from "../files/FileTree";
import { GitChangesPanel } from "../../source-control/ui/GitChangesPanel";
import { ArtifactReader } from "../../artifacts/ui/ArtifactReader";
import { useGitHead } from "../../source-control/hooks/useGitHead";
import { GitHistoryGraph } from "../../source-control/ui/GitHistoryGraph";

const WIDTH_MIN = 200;
const WIDTH_MAX = 420;
const WIDTH_DEFAULT = 260;

/**
 * 右侧检视栏（monocode 新布局的右栏）：文件和历史共用一栏，分段切换。
 *
 * 两个分段各自都是一个完整的工作面，不是「附加信息」：文件树和提交历史
 * 原来分别挤在左侧会话栏的「文件 / 变更」标签里，而它们在读代码时是**一直
 * 想看着**的东西，和会话列表抢同一块屏幕才是最挤的。分出来之后左侧只剩会话，
 * 右侧只剩项目状态。
 *
 * 这一栏属于窗口而不属于工作区：它看的是这个项目，切会话、切 pane 不该让它
 * 消失或重挂。
 */
export function InspectorPanel({ visible, online }: { visible: boolean; online: boolean }) {
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const tab = useShell((state) => state.inspectorTab);
  const setTab = useShell((state) => state.setInspectorTab);
  const open = useShell((state) => state.inspectorOpen);
  const setOpen = useShell((state) => state.setInspectorOpen);
  const width = useShell((state) => state.inspectorWidth);
  const setWidth = useShell((state) => state.setInspectorWidth);
  const openFile = useShell((state) => state.openFile);
  const readingArtifact = useShell((state) => state.inspectorArtifact);
  const setReadingArtifact = useShell((state) => state.setInspectorArtifact);
  // 历史里正在看的那个 commit：它可能是在别处（左栏「变更」、搜索、命令面板）
  // 打开的，所以从打开的文件反推，而不是各自记一份选中状态。
  const activeFile = useActiveWorkspace((workspace) => workspace.panes[workspace.activePane]?.activeFile);
  const openCommit = activeFile?.startsWith("commit:") ? activeFile.slice("commit:".length) : undefined;

  const project = cwd && cwd !== homeDir ? cwd : "";
  // 徽章和顶栏的 chip 共用一份轮询：同一个 checkout 只有一个 git 进程。
  const index = useGitHead(project, open && Boolean(project) && online);
  const changed = index?.files.length ?? 0;

  const resize = useDragResize({
    direction: "left",
    min: WIDTH_MIN,
    max: () => WIDTH_MAX,
    defaultWidth: WIDTH_DEFAULT,
    initial: width,
    onCommit: setWidth,
  });

  if (!visible || !open) return null;

  // 对话里的产物卡片点了过来：这一栏先当读者页用，关掉回到分段。
  if (readingArtifact)
    return (
      <aside
        ref={resize.setPaneRef}
        aria-label="产物"
        className="body-glass relative flex h-full min-h-0 shrink-0 flex-col border-l border-stroke"
      >
        <ResizeHandle
          side="left"
          label="调整检视栏宽度"
          dragging={resize.dragging}
          onPointerDown={resize.onPointerDown}
          onDoubleClick={resize.onDoubleClick}
        />
        <ArtifactReader id={readingArtifact} onClose={() => setReadingArtifact(null)} />
      </aside>
    );

  const items: { id: InspectorTab; label: string }[] = [
    { id: "explorer", label: "文件" },
    { id: "history", label: "历史" },
  ];

  return (
    <aside
      ref={resize.setPaneRef}
      aria-label="项目检视栏"
      className="body-glass relative flex h-full min-h-0 shrink-0 flex-col border-l border-stroke"
    >
      <ResizeHandle
        side="left"
        label="调整检视栏宽度"
        dragging={resize.dragging}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
      <div
        role="tablist"
        aria-label="项目"
        className="flex h-9 shrink-0 items-center gap-px border-b border-stroke px-2"
      >
        {items.map((item) => {
          const active = tab === item.id;
          const badge = item.id === "explorer" && changed > 0 ? changed : 0;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-tauri-drag-region="false"
              title={item.id === "explorer" && changed > 0 ? `${changed} 个文件有变更` : undefined}
              onClick={() => {
                // 再点一次当前分段就收起这一栏，和侧栏的开关手感一致。
                if (active) setOpen(false);
                else setTab(item.id);
              }}
              className={`flex h-6 min-w-0 flex-1 items-center justify-center gap-1 self-center rounded-md px-2 text-[12px] leading-none ${
                active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
              }`}
            >
              <span className="block truncate leading-label">{item.label}</span>
              {badge > 0 ? (
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-accent">+{badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${tab === "explorer" ? "" : "hidden"}`}>
        {project ? (
          <FileTree cwd={project} />
        ) : (
          <p className="px-3 py-2 text-[12px] text-content/45">没有项目文件夹</p>
        )}
      </div>

      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${tab === "history" ? "" : "hidden"}`}>
        {project ? (
          <>
            {/* 变更在历史上面：提交框、待提交文件的暂存/取消，和下面的提交历史
                是同一件事的两端——写一次提交，它立刻出现在下面那条时间线上。 */}
            <div className="flex max-h-[58%] min-h-0 shrink-0 flex-col overflow-hidden border-b border-stroke">
              <GitChangesPanel
                cwd={project}
                enabled={visible && tab === "history" && online}
                onOpenFile={(path, kind, pin) => openFile(path, { pin: pin ?? true, diff: kind })}
                onOpenAllChanges={(kind) =>
                  openFile(`changes:${kind}`, {
                    pin: true,
                    diff: kind,
                    changes: true,
                    name: kind === "staged" ? "已暂存的变更" : "未暂存的变更",
                  })
                }
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <GitHistoryGraph
                key={project}
                cwd={project}
                enabled={visible && tab === "history" && online}
                expanded
                headerless
                selectedSha={openCommit}
                onToggleExpanded={() => setTab("explorer")}
                onOpenCommit={(commit, pin) => {
                  openFile(`commit:${commit.sha}`, {
                    pin: pin ?? true,
                    commit: { sha: commit.sha, shortSha: commit.shortSha, subject: commit.subject },
                    name: commit.subject,
                  });
                }}
              />
            </div>
          </>
        ) : (
          <p className="px-3 py-2 text-[12px] text-content/45">没有项目文件夹</p>
        )}
      </div>
    </aside>
  );
}
