import { useQuery } from "@tanstack/react-query";
import { invoke } from "./native";

/**
 * What a path actually is, on disk.
 *
 * The file pane used to answer this from the file name alone (`mediaKind`),
 * which is why a directory ended up in the text branch: a folder is not an
 * image, not markdown and not a diff, so it fell through to
 * `read_text_file` and came back as `EISDIR (os error 21)`. An extension is a
 * property of a name, not of the filesystem; only a `stat` knows the
 * difference, and this is that `stat`.
 *
 * It is deliberately the *existing* `file_meta` command — the one the editor
 * already polls for disk changes, and the one a paired phone is already
 * allowed to call — so this answer costs no new command, no new entry in the
 * remote allowlist, and no second round trip when both callers want it.
 */
export type PathMeta = {
  mtimeMs: number;
  /** Bytes; 0 for a directory, whose own `len()` is not a content size. */
  size: number;
  isDir: boolean;
};

/** `null` means there is nothing at this path — deletion is an answer too. */
export const pathMeta = (path: string) => invoke<PathMeta | null>("file_meta", { path });

/**
 * The authoritative kind of a path.
 *
 * `null` while unknown, `"missing"` once the disk says so. Callers that can
 * also derive the answer cheaply (the file tree knows an entry is a folder
 * without asking) may pass it in as an optimistic `assumed`, which is only
 * ever overridden by the disk — never the other way round.
 */
export function usePathMeta(path: string | null, enabled = true) {
  return useQuery({
    queryKey: ["path-meta", path ?? ""],
    queryFn: () => pathMeta(path ?? ""),
    enabled: enabled && path != null && path !== "",
    staleTime: 2_000,
  });
}
