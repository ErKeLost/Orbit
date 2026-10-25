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
  const entry: Entry = {
    index: null,
    listeners: new Set(),
    stop: () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      unsubGit();
      entries.delete(cwd);
    },
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
      if (sameDiffIndex(prev, next)) return;
      publish(next);
      if (prev) {
        invalidateWatchedFiles(changedFilePaths(prev, next));
        notifyGitChanged();
      }
    } catch {
      if (!cancelled) publish(null);
    } finally {
      inFlight = false;
      if (pending && !cancelled) {
        pending = false;
        void load();
      }
    }
  };

  const onResume = () => {
    if (!document.hidden) void load();
  };

  void load();
  const timer = window.setInterval(onResume, GIT_POLL_MS);
  window.addEventListener("focus", onResume);
  document.addEventListener("visibilitychange", onResume);
  const unsubGit = subscribeGitChanged(onResume);
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
