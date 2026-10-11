import { useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { gitCheckpointCapture, gitCheckpointRestore } from "../../../lib/git";
import { notifyGitChanged } from "../../../platform/tauri/fs";
import { invalidateWatchedFiles } from "../../files/model/fileWatch";

/**
 * 回合检查点（monocode 0.11）：每轮用户消息发送前捕获工作区 tree，回合结束
 * 再捕获一次，两棵 tree 的 diff 就是「这一轮实际改了什么」，可查看、可撤销、
 * 可保留。数据放 localStorage（每个会话留最近 5 条），tree 对象本身在 git 里。
 */

export type TurnCheckpoint = {
  id: string;
  cwd: string;
  sessionFile: string;
  /** 回合开始前的工作区 tree。 */
  before: string;
  /** 回合结束后的 tree；unsettled 时为空。 */
  after?: string;
  /** 回合是否已结束。 */
  settled?: boolean;
  at: number;
  kept?: boolean;
  dismissed?: boolean;
};

const KEY = "orbit.checkpoints.v1";
const MAX_PER_SESSION = 5;
const CHANGED_EVENT = "orbit-checkpoints-changed";

type Store = { [sessionFile: string]: TurnCheckpoint[] };

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

let cache: Store | null = null;
function store(): Store {
  cache ??= read();
  return cache;
}

function subscribe(listener: () => void) {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

function getSnapshot(): Store {
  return store();
}

/** 当前会话的检查点列表（旧的在前）。 */
export function useCheckpoints(sessionFile: string | null | undefined): TurnCheckpoint[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)[sessionFile ?? ""] ?? [];
}

/** 顶部横幅用的那条：最近一个已结束、有实际改动、还没被保留/丢弃的检查点。 */
export function useLatestPendingCheckpoint(sessionFile: string | null | undefined): TurnCheckpoint | null {
  const list = useCheckpoints(sessionFile);
  return list.filter((item) => item.settled && !item.kept && !item.dismissed && item.after && item.after !== item.before).at(-1) ?? null;
}

function upsert(sessionFile: string, checkpoint: TurnCheckpoint) {
  const current = store();
  const list = (current[sessionFile] ?? []).filter((item) => item.id !== checkpoint.id);
  list.push(checkpoint);
  current[sessionFile] = list.slice(-MAX_PER_SESSION);
  write(current);
}

/** 回合开始：捕获 before。失败静默（非 git 仓库等），只少一个检查点。 */
export async function beginTurn(cwd: string, sessionFile: string): Promise<void> {
  if (!cwd || cwd === "~" || !sessionFile) return;
  // 上一次忘了结算的（崩溃等）直接按未改动结算掉。
  const current = store();
  for (const item of current[sessionFile] ?? []) {
    if (!item.settled) upsert(sessionFile, { ...item, settled: true, dismissed: true });
  }
  try {
    const before = await gitCheckpointCapture(cwd);
    upsert(sessionFile, {
      id: crypto.randomUUID(),
      cwd,
      sessionFile,
      before,
      at: Date.now(),
    });
  } catch { /* 非 git 仓库或捕获失败：这轮没有检查点。 */ }
}

/** 回合结束：捕获 after。前后相同（没改文件）自动标记丢弃。 */
export async function settleTurn(cwd: string, sessionFile: string): Promise<void> {
  if (!cwd || cwd === "~" || !sessionFile) return;
  const current = store();
  const pending = (current[sessionFile] ?? []).filter((item) => !item.settled).at(-1);
  if (!pending) return;
  try {
    const after = await gitCheckpointCapture(cwd);
    upsert(sessionFile, { ...pending, after, settled: true, dismissed: after === pending.before || undefined });
  } catch {
    upsert(sessionFile, { ...pending, settled: true, dismissed: true });
  }
}

export function keepCheckpoint(checkpoint: TurnCheckpoint) {
  upsert(checkpoint.sessionFile, { ...checkpoint, kept: true, dismissed: undefined });
}

export function dismissCheckpoint(checkpoint: TurnCheckpoint) {
  upsert(checkpoint.sessionFile, { ...checkpoint, dismissed: true });
}

/** 撤销：工作区恢复到回合前。有未提交改动时先弹确认。 */
export async function undoCheckpoint(checkpoint: TurnCheckpoint): Promise<boolean> {
  const ok = await ask(
    "撤销会把工作区恢复到这一轮对话之前，覆盖这轮的全部改动（包括未提交文件）。确定要撤销吗？",
    { title: "撤销本轮改动", kind: "warning", okLabel: "撤销" },
  );
  if (!ok) return false;
  await gitCheckpointRestore(checkpoint.cwd, checkpoint.before);
  upsert(checkpoint.sessionFile, { ...checkpoint, dismissed: true });
  notifyGitChanged();
  invalidateWatchedFiles();
  return true;
}

// rpc 侧只发事件（避免依赖成环），这里统一接住。
window.addEventListener("orbit-turn-started", (event) => {
  const { cwd, sessionFile } = (event as CustomEvent<{ cwd: string; sessionFile: string }>).detail;
  void beginTurn(cwd, sessionFile);
});
window.addEventListener("orbit-turn-settled", (event) => {
  const { cwd, sessionFile } = (event as CustomEvent<{ cwd: string; sessionFile: string }>).detail;
  void settleTurn(cwd, sessionFile);
});
