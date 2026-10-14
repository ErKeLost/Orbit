import { useCallback, useEffect, useRef, useState } from "react";
import type { GitFileDiff } from "../../../platform/tauri/fs";
import { buildUnifiedFileAsync } from "../model/asyncUnifiedDiff";
import type { UnifiedFileDiff } from "../model/unifiedDiff";

export type LoadedDiff = {
  binary: boolean;
  tooLarge: boolean;
  unified: UnifiedFileDiff | null;
  error?: string;
};

/** Read and compute only expanded files near the viewport, with two bounded readers. */
export function useLazyFileDiffs(
  revision: unknown,
  loadFile: (id: string) => Promise<GitFileDiff | undefined>,
) {
  const [diffs, setDiffs] = useState<Map<string, LoadedDiff>>(new Map());
  const wanted = useRef(new Set<string>());
  const schedule = useRef<(() => void) | null>(null);
  const onFileVisibility = useCallback((id: string, visible: boolean) => {
    if (visible) wanted.current.add(id);
    else wanted.current.delete(id);
    schedule.current?.();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const loaded = new Map<string, LoadedDiff>();
    const loading = new Set<string>();
    let readers = 0;
    setDiffs(new Map());

    const pump = () => {
      if (abort.signal.aborted) return;
      for (const id of wanted.current) {
        if (readers >= 2) break;
        if (loaded.has(id) || loading.has(id)) continue;
        loading.add(id);
        readers += 1;
        void (async () => {
          try {
            const file = await loadFile(id);
            if (abort.signal.aborted || !file) return;
            const unified = file.binary || file.tooLarge
              ? null
              : await buildUnifiedFileAsync(file.original, file.current, abort.signal);
            if (!abort.signal.aborted) loaded.set(id, { binary: file.binary, tooLarge: file.tooLarge, unified });
          } catch (error) {
            if (!abort.signal.aborted) loaded.set(id, {
              binary: false, tooLarge: false, unified: null,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            readers -= 1;
            // Keep missing ids marked until the next file-list revision.
            if (!abort.signal.aborted) {
              setDiffs(new Map(loaded));
              pump();
            }
          }
        })();
      }
    };
    schedule.current = pump;
    pump();
    return () => {
      schedule.current = null;
      abort.abort();
    };
  }, [revision, loadFile]);

  return { diffs, onFileVisibility };
}
