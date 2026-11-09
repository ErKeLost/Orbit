import { useEffect, useRef, useState } from "react";
import {
  gitDiffIndex,
  notifyGitChanged,
  subscribeGitChanged,
  type GitDiffIndex,
} from "../../../platform/tauri/fs";
import { invalidateWatchedFiles } from "../../files/model/fileWatch";
import { changedFilePaths, sameDiffIndex } from "../model/gitChanges";

const GIT_POLL_MS = 2000;
/** 连续几轮都没变化之后，把轮询间隔拉长到 10s：空闲时不再每 2 秒起两个 git 进程。 */
const GIT_IDLE_MS = 10_000;
const GIT_IDLE_AFTER = 2;

type Entry = {
  index: GitDiffIndex | null;
  listeners: Set<() => void>;
  /** 停掉这一份轮询：最后一个订阅者走了就调。 */
  stop: () => void;
};

/**
 * 一个 checkout 只有**一份** diff 索引轮询，顶栏 chip 和右栏共用。
 *
 * `useDiffIndex` 是「谁用谁轮询」：它自己带缓存，但每个调用点都会起一条
 * 轮询。顶栏的 commit chip 和右栏的变更数说的是同一件事，两份轮询就是
 * 每 2 秒白跑一个 git 进程——monocod 的 GPUI 版本把这件事收在 `ProjectGit`
 * 一个实体里，这里用同样的办法：模块级引用计数，最后一个人走才停。
 */
const entries = new Map<string, Entry>();

function start(cwd: string): Entry {
  let cancelled = false;
  let inFlight = false;
  let pending = false;
  let idlePolls = 0;
  let timer = 0;
  const entry: Entry = {
    index: null,
    listeners: new Set(),
    stop: () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      unsubGit();
      entries.delete(cwd);
    },
  };

  const nextDelay = () => (idlePolls >= GIT_IDLE_AFTER ? GIT_IDLE_MS : GIT_POLL_MS);
  const schedule = () => {
    if (cancelled) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void tick(), nextDelay());
  };

  const publish = (next: GitDiffIndex | null) => {
    entry.index = next;
    for (const listener of entry.listeners) listener();
  };

  const load = async () => {
    if (inFlight) {
      pending = true;
      return;
    }
    if (document.hidden) return;
    inFlight = true;
    try {
      const next = await gitDiffIndex(cwd);
      if (cancelled) return;
      const prev = entry.index;
      if (sameDiffIndex(prev, next)) {
        idlePolls += 1;
        return;
      }
      idlePolls = 0;
      publish(next);
      if (prev) {
        invalidateWatchedFiles(changedFilePaths(prev, next));
        notifyGitChanged();
      }
    } catch {
      idlePolls += 1;
      if (!cancelled) publish(null);
    } finally {
      inFlight = false;
      if (pending && !cancelled) {
        pending = false;
        void load();
      }
    }
  };

  /** 用户回到窗口 / git 被外部改动：立刻查一次，并回到快节奏。 */
  const onWake = () => {
    if (document.hidden) return;
    idlePolls = 0;
    void load();
    schedule();
  };

  const tick = async () => {
    if (cancelled) return;
    if (!document.hidden) await load();
    schedule();
  };

  void load();
  schedule();
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);
  const unsubGit = subscribeGitChanged(onWake);
  return entry;
}

/** 当前 checkout 的 diff 索引；没有第二个调用点时也不多起一条轮询。 */
export function useGitHead(cwd: string | undefined, enabled = true): GitDiffIndex | null {
  const [index, setIndex] = useState<GitDiffIndex | null>(
    () => (cwd ? (entries.get(cwd)?.index ?? null) : null),
  );
  const entryRef = useRef<Entry | null>(null);

  useEffect(() => {
    if (!enabled || !cwd || cwd === "~") {
      setIndex(null);
      return;
    }
    let entry = entries.get(cwd);
    if (!entry) {
      entry = start(cwd);
      entries.set(cwd, entry);
    }
    entryRef.current = entry;
    const listener = () => setIndex(entry!.index);
    entry.listeners.add(listener);
    // 重新订阅时先把已有的那份交出去：切回来不用等下一轮。
    setIndex(entry.index);
    return () => {
      entry!.listeners.delete(listener);
      if (entry!.listeners.size === 0) entry!.stop();
      entryRef.current = null;
    };
  }, [cwd, enabled]);

  return index;
}
