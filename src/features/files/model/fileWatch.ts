/**
 * Orbit has no editor file watcher yet; the source-control surface calls this
 * after git mutations so a future watcher can reconcile. No-op for now.
 */
export function invalidateWatchedFiles(paths?: string[]) {
  void paths;
}
