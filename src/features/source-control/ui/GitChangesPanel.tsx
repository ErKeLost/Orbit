import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  FileDiff,
  FolderTree,
  GitBranch,
  GitPullRequest,
  ListBullet,
  Loader,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Undo,
  WandSparkles,
  X,
} from "../../../shared/ui/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileTypeIcon } from "../../files/ui/FileTypeIcon";
import {
  gitCommit,
  gitDiscardAll,
  gitDiscardFile,
  gitHeadMessage,
  gitPrCreate,
  gitPull,
  gitPush,
  gitRangeContext,
  gitStageAll,
  gitStageFile,
  gitSync,
  gitUnstageAll,
  gitUnstageFile,
  notifyGitChanged,
  type GitChangedFile,
  type GitDiffIndex,
  type GitFileDiffKind,
  type GitPr,
} from "../../../platform/tauri/fs";
import type { HarnessId } from "../../sessions/model/session";
import { recordInboxSelfActivity } from "../../inbox/model/inboxSelfActivity";
import {
  loadChangesView,
  saveChangesView,
  type ChangesView,
} from "../../settings/model/appearance";
import {
  generateCommitMessage,
  generatePrContent,
} from "../../../integrations/harness";
import { invalidateWatchedFiles } from "../../files/model/fileWatch";
import { MOD } from "../../../platform/tauri/platform";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { isRemoteProjectPath } from "../../projects/model/recents";
import { useDiffIndex } from "../hooks/useGitDiffIndex";
import { usePrStatus } from "../hooks/useGitPrStatus";
import {
  buildChangeTree,
  changeBasename,
  changeDirname,
  filesUnderFolder,
  isActiveChangeFile,
  splitByStage,
  statusColor,
  statusLetter,
  syncStatusLabel,
  type ChangeDir,
} from "../model/gitChanges";
import {
  canPullBranch,
  commitGate,
  createPrTitle,
  discardAllConfirm,
  discardFileConfirm,
  prContentFromRange,
  prNumberFromUrl,
  syncActionTitle,
  viewPrTitle,
} from "../model/gitCommitActions";

function confirmNative(message: string, okLabel?: string): Promise<boolean> {
  return ask(message, {
    title: "Orbit",
    kind: "warning",
    ...(okLabel ? { okLabel } : {}),
  });
}

let stagedOpen = true;
let changesOpen = true;
let changesView: ChangesView = loadChangesView();
/** Folders the user collapsed in tree view, keyed `<kind>:<dir>`. */
const collapsedDirs = new Set<string>();

type AmendTarget = { branch: string | null; head: string | null };

type Props = {
  cwd: string;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  selectedKind?: GitFileDiffKind;
  onOpenFile: (path: string, kind: GitFileDiffKind, pin?: boolean) => void;
  onOpenAllChanges: (kind: GitFileDiffKind) => void;
};

export function GitChangesPanel({
  cwd,
  enabled,
  textHarness,
  selectedPath,
  selectedKind,
  onOpenFile,
  onOpenAllChanges,
}: Props) {
  const { index, reload } = useDiffIndex(cwd, enabled);
  const files = index?.files ?? [];
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  // Shared across the header and the changed-files list so no two Git
  // mutations ever run against the same checkout at once.
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!branchMenuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node)) {
        setBranchMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [branchMenuOpen]);

  const canPull = canPullBranch(index);

  const pull = async () => {
    if (!canPull) return;
    setStatus(null);
    setBusy("pull");
    try {
      await gitPull(cwd);
      reload();
      notifyGitChanged();
      invalidateWatchedFiles();
      setStatus("拉取完成");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      setBranchMenuOpen(false);
    }
  };

  if (!cwd || cwd === "~") {
    return (
      <p className="px-3 py-2 text-[12px] text-content/50">没有项目文件夹</p>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke px-3">
        <span className="text-[12px] font-medium text-content">变更</span>
        {status ? (
          <span role="status" className="text-[11px] text-content/50">
            {status}
          </span>
        ) : null}
        {index?.branch ? (
          <div
            ref={branchMenuRef}
            className="relative ml-auto flex min-w-0 items-center gap-1"
          >
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-content/50">
              <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">{index.branch}</span>
              {index.ahead > 0 ? (
                <span className="shrink-0 tabular-nums text-content/40">
                  ↑{index.ahead}
                </span>
              ) : null}
              {index.behind > 0 ? (
                <span className="shrink-0 tabular-nums text-content/40">
                  ↓{index.behind}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              aria-haspopup="menu"
              aria-label="分支操作"
              aria-expanded={branchMenuOpen}
              disabled={busy !== null}
              onClick={() => setBranchMenuOpen((open) => !open)}
              className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40 aria-expanded:bg-content/10 aria-expanded:text-content"
            >
              {busy === "pull" ? (
                <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <MoreHorizontal className="size-4" strokeWidth={2} />
              )}
            </button>
            {branchMenuOpen ? (
              <div
                role="menu"
                aria-label="分支操作"
                className="absolute top-full right-0 z-30 mt-1 min-w-36 rounded-md border border-content/10 bg-background-base py-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy !== null || !canPull}
                  title={
                    canPull
                      ? undefined
                      : "This branch needs a remote and upstream before it can pull"
                  }
                  onClick={() => void pull()}
                  className="flex h-7 w-full items-center gap-2 px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
                >
                  {busy === "pull" ? (
                    <Loader
                      className="size-3.5 animate-spin"
                      strokeWidth={1.75}
                    />
                  ) : (
                    <RefreshCw className="size-3.5" strokeWidth={1.75} />
                  )}
                  {busy === "pull" ? "正在拉取…" : "拉取"}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <span className="ml-auto" />
        )}
      </header>
      <ChangedFiles
        cwd={cwd}
        textHarness={textHarness}
        index={index}
        files={files}
        selected={selectedPath}
        selectedKind={selectedKind}
        enabled={enabled}
        fill
        busy={busy}
        setBusy={setBusy}
        onOpenFile={onOpenFile}
        onOpenAllChanges={onOpenAllChanges}
        onMutated={(paths) => {
          reload();
          notifyGitChanged();
          invalidateWatchedFiles(paths);
          window.setTimeout(() => invalidateWatchedFiles(paths), 150);
        }}
      />
    </div>
  );
}

function ChangedFiles({
  cwd,
  textHarness,
  index,
  files,
  selected,
  selectedKind,
  enabled,
  fill,
  busy,
  setBusy,
  onOpenFile,
  onOpenAllChanges,
  onMutated,
}: {
  cwd: string;
  textHarness?: HarnessId;
  index: GitDiffIndex | null;
  files: GitChangedFile[];
  selected?: string;
  selectedKind?: GitFileDiffKind;
  enabled: boolean;
  fill: boolean;
  busy: string | null;
  setBusy: (value: string | null) => void;
  onOpenFile: (path: string, kind: GitFileDiffKind, pin?: boolean) => void;
  onOpenAllChanges: (kind: GitFileDiffKind) => void;
  onMutated: (paths?: string[]) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const menuRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const generateAbortRef = useRef<AbortController | null>(null);
  const [message, setMessage] = useState("");
  const [amendTarget, setAmendTarget] = useState<AmendTarget | null>(null);
  const amend = amendTarget !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagedExpanded, setStagedExpanded] = useState(stagedOpen);
  const [changesExpanded, setChangesExpanded] = useState(changesOpen);
  const [view, setView] = useState<ChangesView>(changesView);
  const { pr, reload: reloadPr } = usePrStatus(cwd, index?.branch);
  const { staged, unstaged } = useMemo(() => splitByStage(files), [files]);
  const {
    hasRemote,
    hasOpenPr,
    onDefault,
    canGenerate,
    canCommit,
    canCreatePr,
    canViewPr,
    canPublish,
    canSync,
    canCommitPush,
    canCommitPushPr,
    canEditMessage,
    canOpenMenu,
  } = commitGate({
    index,
    pr,
    stagedCount: staged.length,
    fileCount: files.length,
    amend,
    message,
    busy,
    remoteProject: isRemoteProjectPath(cwd),
  });

  useEffect(() => {
    if (!amendTarget) return;
    if (
      amendTarget.branch === index?.branch &&
      amendTarget.head === index?.head
    ) {
      return;
    }
    setAmendTarget(null);
    setMessage("");
  }, [amendTarget, index?.branch, index?.head]);

  useEffect(() => {
    if (!enabled) return;
    const el = messageRef.current;
    // 面板收起（`display:none`）时 scrollHeight 是 0，写进去会把提交框压塌。
    if (!el || el.getClientRects().length === 0) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [message, enabled]);

  useEffect(
    () => () => {
      if (generateAbortRef.current) {
        generateAbortRef.current.abort();
        generateAbortRef.current = null;
        setBusy(null);
      }
    },
    [cwd, setBusy],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [menuOpen]);

  const toggleView = () => {
    changesView = view === "tree" ? "list" : "tree";
    saveChangesView(changesView);
    setView(changesView);
  };

  const fail = (error: unknown) => {
    window.alert(error instanceof Error ? error.message : String(error));
  };

  const recordPrActivity = (number = pr?.number) => {
    if (!number) return;
    recordInboxSelfActivity({
      provider: "github",
      kind: "pr",
      number,
      projectPath: cwd,
    });
  };

  const confirmDefault = async (kind: "push" | "pr") => {
    if (!onDefault || !index?.branch) return true;
    const branch = index.branch;
    return confirmNative(
      kind === "pr"
        ? `Create a pull request from default branch "${branch}"?`
        : `Push to default branch "${branch}"?`,
    );
  };

  const run = async (
    file: GitChangedFile,
    action: "stage" | "unstage" | "discard",
  ) => {
    if (busy) return;
    if (action === "discard") {
      const confirm = discardFileConfirm(file);
      const ok = await confirmNative(confirm.message, confirm.okLabel);
      if (!ok) return;
    }
    setBusy(file.relative);
    try {
      if (action === "stage") await gitStageFile(cwd, file.relative);
      else if (action === "unstage") await gitUnstageFile(cwd, file.relative);
      else await gitDiscardFile(cwd, file.relative);
      onMutated([file.path]);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const runAll = async (action: "stage" | "unstage" | "discard") => {
    if (busy) return;
    if (action === "discard") {
      const confirm = discardAllConfirm(unstaged);
      if (!confirm) return;
      const ok = await confirmNative(confirm.message, confirm.okLabel);
      if (!ok) return;
    }
    setBusy(action);
    try {
      if (action === "stage") await gitStageAll(cwd);
      else if (action === "unstage") await gitUnstageAll(cwd);
      else await gitDiscardAll(cwd);
      onMutated(
        action === "discard" ? unstaged.map((file) => file.path) : undefined,
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const runFolder = async (relative: string, action: "stage" | "unstage") => {
    if (busy) return;
    setBusy(`${action}:${relative}`);
    try {
      if (action === "stage") await gitStageFile(cwd, relative);
      else await gitUnstageFile(cwd, relative);
      onMutated(
        filesUnderFolder(files, relative).map((file) => file.path),
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!canGenerate || generateAbortRef.current) return;
    const controller = new AbortController();
    generateAbortRef.current = controller;
    setBusy("generate");
    try {
      const generated = await generateCommitMessage(
        cwd,
        textHarness,
        controller.signal,
      );
      if (!controller.signal.aborted) setMessage(generated);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      if (generateAbortRef.current === controller) {
        generateAbortRef.current = null;
        setBusy(null);
      }
    }
  };

  const cancelGenerate = () => {
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    setBusy(null);
  };

  const toggleAmend = async () => {
    setMenuOpen(false);
    if (amend) {
      setAmendTarget(null);
      return;
    }
    try {
      const headMessage = await gitHeadMessage(cwd);
      if (!message.trim()) setMessage(headMessage);
      setAmendTarget({
        branch: index?.branch ?? null,
        head: index?.head ?? null,
      });
    } catch (error) {
      fail(error);
    }
  };

  const confirmAmend = async () => {
    if (!amend || !index?.headPushed) return true;
    return confirmNative(
      "这条提交已经推送过，修补后将无法直接推送，需要在终端强制推送。确定要修补吗？",
      "修补",
    );
  };

  const commit = async (push: boolean, createPr = false) => {
    if (!canCommit) return;
    if (
      (push || createPr) &&
      !(await confirmDefault(createPr ? "pr" : "push"))
    ) {
      return;
    }
    if (!(await confirmAmend())) return;
    setBusy(createPr ? "pr" : "commit");
    setMenuOpen(false);
    try {
      await gitCommit(cwd, message, amend);
      if (push || createPr) {
        await gitPush(cwd);
        recordPrActivity();
      }
      setMessage("");
      setAmendTarget(null);
      onMutated();
      if (createPr) {
        await openCreatedPr();
        reloadPr();
      }
    } catch (error) {
      fail(error);
      onMutated();
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!index || !(canSync || canPublish)) return;
    const pushesCommits = index.ahead > 0;
    setBusy("sync");
    try {
      await gitSync(cwd);
      if (pushesCommits) recordPrActivity();
      onMutated();
      reloadPr();
    } catch (error) {
      fail(error);
      onMutated();
    } finally {
      setBusy(null);
    }
  };

  const openCreatedPr = async () => {
    const content = isRemoteProjectPath(cwd)
      ? prContentFromRange(await gitRangeContext(cwd))
      : await generatePrContent(cwd, textHarness);
    if (!content) throw new Error("无法准备 PR 内容");
    const url = await gitPrCreate(
      cwd,
      content.title,
      content.body,
      content.base,
      content.head,
    );
    const number = prNumberFromUrl(url);
    if (number) recordPrActivity(number);
    await openUrl(url.trim());
  };

  const createPr = async () => {
    if (!canCreatePr) return;
    if (!(await confirmDefault("pr"))) return;
    setBusy("pr");
    try {
      if ((index?.ahead ?? 0) > 0) await gitPush(cwd);
      await openCreatedPr();
      onMutated();
      reloadPr();
    } catch (error) {
      fail(error);
      onMutated();
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside
      className={`flex min-h-0 min-w-0 flex-col ${fill ? "flex-1" : "shrink-0"}`}
    >
      <div className="shrink-0 border-b border-stroke p-2">
        <div className="relative">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            placeholder={
              amend
                ? `Amend message (${MOD}↩ to amend)`
                : `提交信息 (${MOD}↩ 提交)`
            }
            disabled={!canEditMessage}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                canCommit
              ) {
                event.preventDefault();
                void commit(false);
              }
            }}
            className="max-h-40 w-full resize-none overflow-y-auto rounded-md bg-content/10 py-1 pr-8 pl-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/35 disabled:opacity-40"
          />
          <button
            type="button"
            title={
              busy === "generate"
                ? "取消生成提交信息"
                : "生成提交信息"
            }
            aria-label={
              busy === "generate"
                ? "取消生成提交信息"
                : "生成提交信息"
            }
            disabled={busy !== "generate" && !canGenerate}
            onClick={() =>
              busy === "generate" ? cancelGenerate() : void generate()
            }
            className="group absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-content/10 text-content hover:bg-content/20 hover:text-content disabled:opacity-40"
          >
            {busy === "generate" ? (
              <>
                <Loader
                  className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden"
                  strokeWidth={1.75}
                />
                <X
                  className="hidden size-3.5 group-hover:block group-focus-visible:block"
                  strokeWidth={1.75}
                />
              </>
            ) : (
              <WandSparkles className="size-3" strokeWidth={1} />
            )}
          </button>
        </div>
        <div ref={menuRef} className="relative mt-1.5 flex">
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void commit(false)}
            className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md text-[12px] font-medium ${
              canCommit
                ? "bg-content text-background-base"
                : "bg-content/40 text-background-base"
            }`}
          >
            <Check className="size-3.5" strokeWidth={2} />
            {amend ? "修补上次提交" : "提交"}
          </button>

          <button
            type="button"
            title="提交选项"
            aria-label="提交选项"
            aria-expanded={menuOpen}
            disabled={!canOpenMenu}
            onClick={() => setMenuOpen((open) => !open)}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-r-md border-l border-background-base/10 ${
              canCommit
                ? "bg-content text-background-base hover:bg-content/80"
                : "bg-content/40 text-background-base hover:bg-content"
            } disabled:pointer-events-none aria-expanded:bg-content aria-expanded:text-background-base`}
          >
            <ChevronDown className="size-3.5" strokeWidth={2} />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              aria-label="提交选项"
              className="absolute top-full right-0 z-30 mt-1 min-w-48 rounded-md border border-content/10 bg-background-base py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                disabled={!canCommitPush}
                onClick={() => void commit(true)}
                className="flex h-7 w-full items-center px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
              >
                Commit & Push
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!canCommitPushPr}
                onClick={() => void commit(true, true)}
                className="flex h-7 w-full items-center px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
              >
                Commit, Push & Create PR
              </button>
              <div className="my-1 border-t border-content/10" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={amend}
                onClick={() => void toggleAmend()}
                className="flex h-7 w-full items-center justify-between gap-2 px-3 text-left text-[12px] text-content hover:bg-content/10"
              >
                Amend Last Commit
                <span className="grid size-3.5 shrink-0 place-items-center">
                  {amend ? (
                    <Check className="size-3.5" strokeWidth={2} />
                  ) : null}
                </span>
              </button>
            </div>
          ) : null}
        </div>
        {index ? (
          <GitSyncActions
            index={index}
            pr={pr}
            busy={busy}
            hasRemote={hasRemote}
            hasOpenPr={hasOpenPr}
            onDefault={onDefault}
            canSync={canSync}
            canPublish={canPublish}
            canCreatePr={canCreatePr}
            canViewPr={canViewPr}
            onSync={() => void sync()}
            onCreatePr={() => void createPr()}
            onViewPr={() => {
              if (pr?.url) void openUrl(pr.url);
            }}
          />
        ) : null}
      </div>
      <div
        ref={lockOverscroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none py-1"
      >
        {files.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-content/45">
            {index
              ? index.ahead > 0 || index.behind > 0
                ? syncStatusLabel(index)
                : "没有未提交的更改"
              : "正在加载更改…"}
          </p>
        ) : (
          <>
            {staged.length > 0 ? (
              <FileSection
                title="已暂存"
                count={staged.length}
                open={stagedExpanded}
                onToggle={() => {
                  stagedOpen = !stagedExpanded;
                  setStagedExpanded(stagedOpen);
                }}
                view={view}
                onToggleView={toggleView}
                headerActions={[
                  {
                    title: "Open All Changes",
                    icon: <FileDiff className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => onOpenAllChanges("staged"),
                  },
                  {
                    title: "Unstage All Changes",
                    icon: <Minus className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => void runAll("unstage"),
                  },
                ]}
              >
                <ChangeList
                  files={staged}
                  view={view}
                  kind="staged"
                  selected={selected}
                  selectedKind={selectedKind}
                  busy={busy}
                  onOpenFile={onOpenFile}
                  onAction={run}
                  onFolderAction={runFolder}
                />
              </FileSection>
            ) : null}
            {unstaged.length > 0 ? (
              <FileSection
                title="变更"
                count={unstaged.length}
                open={changesExpanded}
                onToggle={() => {
                  changesOpen = !changesExpanded;
                  setChangesExpanded(changesOpen);
                }}
                view={view}
                onToggleView={toggleView}
                headerActions={[
                  {
                    title: "Open All Changes",
                    icon: <FileDiff className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => onOpenAllChanges("unstaged"),
                  },
                  {
                    title: "Discard All Changes",
                    icon: <Undo className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => void runAll("discard"),
                  },
                  {
                    title: "Stage All Changes",
                    icon: <Plus className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => void runAll("stage"),
                  },
                ]}
              >
                <ChangeList
                  files={unstaged}
                  view={view}
                  kind="unstaged"
                  selected={selected}
                  selectedKind={selectedKind}
                  busy={busy}
                  onOpenFile={onOpenFile}
                  onAction={run}
                  onFolderAction={runFolder}
                />
              </FileSection>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function GitSyncActions({
  index,
  pr,
  busy,
  hasRemote,
  hasOpenPr,
  onDefault,
  canSync,
  canPublish,
  canCreatePr,
  canViewPr,
  onSync,
  onCreatePr,
  onViewPr,
}: {
  index: GitDiffIndex;
  pr: GitPr | null;
  busy: string | null;
  hasRemote: boolean;
  hasOpenPr: boolean;
  onDefault: boolean;
  canSync: boolean;
  canPublish: boolean;
  canCreatePr: boolean;
  canViewPr: boolean;
  onSync: () => void;
  onCreatePr: () => void;
  onViewPr: () => void;
}) {
  if (!hasRemote) return null;
  const ahead = index.ahead;
  const behind = index.behind;
  const syncing = busy === "sync";
  const syncTitle = syncActionTitle({ index, canPublish, syncing });
  const createTitle = createPrTitle(index);
  const viewTitle = viewPrTitle(pr);
  const btn =
    "flex h-7 w-full min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium disabled:opacity-40";
  const secondary = `${btn} bg-content/10 text-content hover:bg-content/15`;
  const showCreatePr = !hasOpenPr && !onDefault;
  const showViewPr = hasOpenPr;
  if (!canPublish && !canSync && !showCreatePr && !showViewPr) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {canPublish ? (
        <button
          type="button"
          title={syncTitle}
          disabled={!!busy}
          onClick={onSync}
          className={secondary}
        >
          {syncing ? (
            <Loader
              className="size-3.5 shrink-0 animate-spin"
              strokeWidth={1.75}
            />
          ) : (
            <CloudUpload className="size-3.5 shrink-0" strokeWidth={1.75} />
          )}
          <span className="min-w-0 truncate">发布分支</span>
        </button>
      ) : canSync ? (
        <button
          type="button"
          title={syncTitle}
          disabled={!!busy}
          onClick={onSync}
          className={secondary}
        >
          <RefreshCw
            className={`size-3.5 shrink-0 ${syncing ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate">同步更改</span>
          {behind > 0 ? (
            <span className="shrink-0 tabular-nums text-content/55">
              ↓{behind}
            </span>
          ) : null}
          {ahead > 0 ? (
            <span className="shrink-0 tabular-nums text-content/55">
              ↑{ahead}
            </span>
          ) : null}
        </button>
      ) : null}
      {showCreatePr ? (
        <button
          type="button"
          title={createTitle}
          disabled={!canCreatePr || !!busy}
          onClick={onCreatePr}
          className={secondary}
        >
          {busy === "pr" ? (
            <Loader
              className="size-3.5 shrink-0 animate-spin"
              strokeWidth={1.75}
            />
          ) : (
            <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />
          )}
          Create PR
        </button>
      ) : null}
      {showViewPr ? (
        <button
          type="button"
          title={viewTitle}
          disabled={!canViewPr || !!busy}
          onClick={onViewPr}
          className={secondary}
        >
          <ExternalLink className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">
            {pr?.number ? `View PR #${pr.number}` : "View PR"}
          </span>
        </button>
      ) : null}
    </div>
  );
}

export function FileSection({
  title,
  count,
  open,
  onToggle,
  view,
  onToggleView,
  headerActions,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  view: ChangesView;
  onToggleView: () => void;
  headerActions: { title: string; icon: ReactNode; onClick: () => void }[];
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex h-7 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {open ? (
            <ChevronDown
              className="size-3.5 shrink-0 text-content/50"
              strokeWidth={1.75}
            />
          ) : (
            <ChevronRight
              className="size-3.5 shrink-0 text-content/50"
              strokeWidth={1.75}
            />
          )}
          <span className="min-w-0 truncate text-[10px] font-semibold tracking-[0.04em] text-content/55 uppercase">
            {title}
          </span>
          <span className="ml-1 grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-accent/80 px-1 text-[8px] text-white">
            {count}
          </span>
        </button>
        <IconAction
          title={view === "tree" ? "列表视图" : "树形视图"}
          onClick={onToggleView}
        >
          {view === "tree" ? (
            <ListBullet className="size-3.5" strokeWidth={1.75} />
          ) : (
            <FolderTree className="size-3.5" strokeWidth={1.75} />
          )}
        </IconAction>
        {headerActions.map((action) => (
          <IconAction
            key={action.title}
            title={action.title}
            onClick={action.onClick}
          >
            {action.icon}
          </IconAction>
        ))}
      </div>
      {open ? <ul>{children}</ul> : null}
    </div>
  );
}

type ChangeRowProps = {
  files: GitChangedFile[];
  view: ChangesView;
  kind: GitFileDiffKind;
  selected?: string;
  selectedKind?: GitFileDiffKind;
  busy: string | null;
  onOpenFile: (path: string, kind: GitFileDiffKind, pin?: boolean) => void;
  onAction: (
    file: GitChangedFile,
    action: "stage" | "unstage" | "discard",
  ) => void;
  onFolderAction: (relative: string, action: "stage" | "unstage") => void;
};

export function ChangeList({ files, view, ...rest }: ChangeRowProps) {
  const tree = useMemo(() => buildChangeTree(files), [files]);
  if (view === "tree") {
    return <ChangeDirChildren dir={tree} depth={0} {...rest} />;
  }
  return (
    <>
      {files.map((file) => (
        <ChangeRow
          key={`${rest.kind}:${file.relative}`}
          file={file}
          active={isActiveChangeFile(
            file,
            rest.selected,
            rest.selectedKind,
            rest.kind,
          )}
          busy={rest.busy !== null}
          kind={rest.kind}
          onOpenFile={rest.onOpenFile}
          onAction={rest.onAction}
        />
      ))}
    </>
  );
}

function ChangeDirChildren({
  dir,
  depth,
  kind,
  selected,
  selectedKind,
  busy,
  onOpenFile,
  onAction,
  onFolderAction,
}: Omit<ChangeRowProps, "files" | "view"> & {
  dir: ChangeDir;
  depth: number;
}) {
  return (
    <>
      {dir.dirs.map((child) => (
        <ChangeDirRow
          key={child.path}
          dir={child}
          depth={depth}
          kind={kind}
          selected={selected}
          selectedKind={selectedKind}
          busy={busy}
          onOpenFile={onOpenFile}
          onAction={onAction}
          onFolderAction={onFolderAction}
        />
      ))}
      {dir.files.map((file) => (
        <ChangeRow
          key={`${kind}:${file.relative}`}
          file={file}
          active={isActiveChangeFile(file, selected, selectedKind, kind)}
          busy={busy !== null}
          kind={kind}
          depth={depth}
          onOpenFile={onOpenFile}
          onAction={onAction}
        />
      ))}
    </>
  );
}

function ChangeDirRow({
  dir,
  depth,
  kind,
  ...rest
}: Omit<ChangeRowProps, "files" | "view"> & {
  dir: ChangeDir;
  depth: number;
}) {
  const key = `${kind}:${dir.path}`;
  const [open, setOpen] = useState(() => !collapsedDirs.has(key));
  const toggle = () => {
    if (open) collapsedDirs.add(key);
    else collapsedDirs.delete(key);
    setOpen(!open);
  };
  return (
    <li>
      <div
        style={{ paddingLeft: 8 + depth * 12 }}
        className="group flex h-7 w-full items-center gap-1 pr-2 leading-none text-content hover:bg-content/5"
      >
        <button
          type="button"
          title={dir.path}
          aria-expanded={open}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="grid size-4 shrink-0 place-items-center text-content/50">
            {open ? (
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronRight className="size-3.5" strokeWidth={1.75} />
            )}
          </span>
          <FileTypeIcon name={dir.name} isDir isOpen={open} size={16} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {dir.name}
          </span>
        </button>
        <div className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
          <IconAction
            title={`${kind === "staged" ? "Unstage" : "Stage"} Changes in ${dir.path}`}
            disabled={rest.busy !== null}
            onClick={() =>
              rest.onFolderAction(
                dir.path,
                kind === "staged" ? "unstage" : "stage",
              )
            }
          >
            {kind === "staged" ? (
              <Minus className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Plus className="size-3.5" strokeWidth={1.75} />
            )}
          </IconAction>
        </div>
        <span
          className={`grid w-3.5 shrink-0 place-items-center ${
            dir.status ? statusColor(dir.status) : "text-content/40"
          }`}
          aria-hidden
        >
          <span className="size-1.5 rounded-full bg-current" />
        </span>
      </div>
      {open ? (
        <ul>
          <ChangeDirChildren
            dir={dir}
            depth={depth + 1}
            kind={kind}
            {...rest}
          />
        </ul>
      ) : null}
    </li>
  );
}

function ChangeRow({
  file,
  active,
  busy,
  kind,
  depth,
  onOpenFile,
  onAction,
}: {
  file: GitChangedFile;
  active: boolean;
  busy: boolean;
  kind: GitFileDiffKind;
  /** Set in tree view: nesting level, and the folder path moves to the tree. */
  depth?: number;
  onOpenFile: (path: string, kind: GitFileDiffKind, pin?: boolean) => void;
  onAction: (
    file: GitChangedFile,
    action: "stage" | "unstage" | "discard",
  ) => void;
}) {
  const name = changeBasename(file.relative);
  const tree = depth !== undefined;
  const dir = tree ? "" : changeDirname(file.relative);
  return (
    <li>
      <div
        style={tree ? { paddingLeft: 8 + depth * 12 } : undefined}
        className={`group flex h-7 w-full items-center gap-1 pr-2 leading-none ${
          tree ? "" : "pl-2"
        } ${
          active
            ? "bg-selection text-content"
            : "text-content hover:bg-content/5"
        }`}
      >
        <button
          type="button"
          title={file.relative}
          onClick={() => {
            onOpenFile(file.path, kind);
          }}
          onDoubleClick={() => {
            if (file.status !== "deleted") onOpenFile(file.path, kind, true);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {tree ? <span className="size-4 shrink-0" /> : null}
          <FileTypeIcon name={name} isDir={false} size={16} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-[13px] font-medium">{name}</span>
            {dir ? (
              <span className="ml-1.5 text-[11px] text-content/40">{dir}</span>
            ) : null}
          </span>
        </button>
        <div
          className={` shrink-0 items-center ${
            active ? "flex" : "hidden group-focus-within:flex group-hover:flex"
          }`}
        >
          {kind === "unstaged" ? (
            <IconAction
              title="放弃更改"
              disabled={busy}
              onClick={() => onAction(file, "discard")}
            >
              <Undo className="size-3.5" strokeWidth={1.75} />
            </IconAction>
          ) : null}
          {kind === "staged" ? (
            <IconAction
              title="取消暂存"
              disabled={busy}
              onClick={() => onAction(file, "unstage")}
            >
              <Minus className="size-3.5" strokeWidth={1.75} />
            </IconAction>
          ) : (
            <IconAction
              title="暂存更改"
              disabled={busy}
              onClick={() => onAction(file, "stage")}
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </IconAction>
          )}
        </div>
        <span
          className={`w-3.5 shrink-0 text-right font-mono text-[11px] font-semibold ${statusColor(file.status)}`}
        >
          {statusLetter(file.status)}
        </span>
      </div>
    </li>
  );
}

function IconAction({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 place-items-center rounded text-content/55 hover:bg-content/10 hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

