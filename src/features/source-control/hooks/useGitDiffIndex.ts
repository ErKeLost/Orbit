import { useCallback, useEffect, useRef, useState } from "react";
import {
  gitDiffIndex,
  notifyGitChanged,
  subscribeGitChanged,
  type GitDiffIndex,
} from "../../../platform/tauri/fs";
import { invalidateWatchedFiles } from "../../files/model/fileWatch";
import { applyProjectDiffStats } from "./useProjectDiffStats";
import { changedFilePaths, sameDiffIndex } from "../model/gitChanges";

const GIT_POLL_MS = 2000;

/** Last index per checkout, so reopening the panel paints before git answers. */
const indexByCwd = new Map<string, GitDiffIndex>();

function cachedIndex(cwd: string | undefined): GitDiffIndex | null {
  if (!cwd || cwd === "~") return null;
  return indexByCwd.get(cwd) ?? null;
}

/**
 * Polls the diff index for one checkout and keeps the cached snapshot in sync.
 * Returns `reload` for callers that just mutated the index.
 */
export function useDiffIndex(
  cwd: string,
  enabled: boolean,
): {
  index: GitDiffIndex | null;
  reload: () => void;
} {
  const [index, setIndex] = useState<GitDiffIndex | null>(() =>
    cachedIndex(cwd),
  );
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    if (!enabled || !cwd || cwd === "~") {
      return;
    }
    const cached = cachedIndex(cwd);
    if (cached && !sameDiffIndex(indexRef.current, cached)) {
      indexRef.current = cached;
      setIndex(cached);
    }
    let cancelled = false;
    let inFlight = false;
    let pending = false;

    const load = async () => {
      if (inFlight) {
        pending = true;
        return;
      }
      if (document.hidden && nonce === 0) return;
      inFlight = true;
      try {
        const next = await gitDiffIndex(cwd);
        if (cancelled) return;
        const prev = indexRef.current;
        if (sameDiffIndex(prev, next)) return;
        indexByCwd.set(cwd, next);
        indexRef.current = next;
        setIndex(next);
        applyProjectDiffStats(cwd, {
          files: next.files.length,
          additions: next.additions,
          deletions: next.deletions,
        });
        if (prev) {
          const paths = changedFilePaths(prev, next);
          invalidateWatchedFiles(paths);
          notifyGitChanged();
        }
      } catch {
        if (!cancelled) {
          indexByCwd.delete(cwd);
          setIndex(null);
        }
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          void load();
        }
      }
    };

    void load();
    const onResume = () => {
      if (!document.hidden) void load();
    };
    const timer = window.setInterval(onResume, GIT_POLL_MS);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    const unsubGit = subscribeGitChanged(onResume);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      unsubGit();
    };
  }, [cwd, enabled, nonce]);

  return { index, reload };
}
