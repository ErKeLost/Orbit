import { formatBytes, mediaKind } from "./media";
import type { DirEntry } from "./git";

/**
 * The directory listing's view model, with no React and no I/O in it.
 *
 * Grouping is a decision worth testing on its own: which bucket an entry falls
 * into, and the order inside it, is the whole of what the folder view shows.
 */

/**
 * Mirrors `git::MAX_DIR_ENTRIES`. `list_dir` answers with a bare array, so the
 * only way to tell a full folder from a capped one is the count itself;
 * `tests/directory.test.ts` fails if this drifts from the Rust constant.
 */
export const DIR_ENTRY_LIMIT = 5000;

export type DirectoryGroups = {
  folders: DirEntry[];
  /** Everything `mediaKind` calls an image: the only bucket that gets tiles. */
  images: DirEntry[];
  /** Every other file, in one list — the icon comes from `FileTypeIcon`. */
  files: DirEntry[];
};

/**
 * Numeric-aware, case-insensitive, locale-aware.
 *
 * `img10.png` must not sort before `img2.png`, and `README` must not sort
 * above `app.ts` just because of its case.
 */
function byName(a: DirEntry, b: DirEntry) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function isImageEntry(entry: DirEntry) {
  return !entry.isDir && mediaKind(entry.path) === "image";
}

/**
 * Folders, then image tiles, then everything else.
 *
 * Gitignored entries are deliberately *not* separated or dimmed here. The tree
 * is where "this will not be committed" is worth saying; inside a folder a
 * person opened on purpose, dimming every row of a directory that is itself
 * ignored (`work/` in this very repository) is noise, not information.
 */
export function groupDirectory(entries: DirEntry[]): DirectoryGroups {
  const folders: DirEntry[] = [];
  const images: DirEntry[] = [];
  const files: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.isDir) folders.push(entry);
    else if (isImageEntry(entry)) images.push(entry);
    else files.push(entry);
  }
  folders.sort(byName);
  images.sort(byName);
  files.sort(byName);
  return { folders, images, files };
}

/** "3 个文件夹 · 12 张图片 · 40 个文件" — only the non-empty counts. */
export function directorySummary({ folders, images, files }: DirectoryGroups): string {
  const parts: string[] = [];
  if (folders.length) parts.push(`${folders.length} 个文件夹`);
  if (images.length) parts.push(`${images.length} 张图片`);
  if (files.length) parts.push(`${files.length} 个文件`);
  return parts.length ? parts.join(" · ") : "空文件夹";
}

/**
 * Byte sizes as the rest of the app prints them.
 *
 * Folders have no content size, and a phone talking to an older desktop gets
 * entries that predate these fields — `!size` covers both rather than printing
 * `NaN B`.
 */
export function entrySizeLabel(entry: DirEntry): string {
  if (entry.isDir || !entry.size) return "";
  return formatBytes(entry.size);
}

/**
 * Today shows a clock, this year shows a date, older shows the year too.
 *
 * Hand-rolled rather than `toLocaleString`, so the same numbers come out on
 * every machine the same build is run on — and so it can be tested.
 */
export function formatEntryDate(mtimeMs: number, now = Date.now()): string {
  if (!mtimeMs) return "";
  const at = new Date(mtimeMs);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return clock;
  const day = `${at.getMonth() + 1}月${at.getDate()}日`;
  return at.getFullYear() === today.getFullYear() ? day : `${at.getFullYear()}年${day}`;
}

/**
 * The path as clickable crumbs, rooted at the workspace when it is inside one.
 *
 * A crumb per segment is right for the first few levels and unusable at the
 * tenth, so everything past the root collapses into one `…` that goes up a
 * level. Crumbs are absolute: a chat link is often relative to the workspace,
 * and a crumb that resolves against nothing opens nothing.
 */
export function pathCrumbs(path: string, cwd = "", tail = 3): { label: string; path: string }[] {
  const separator = path.includes("\\") && !path.startsWith("/") ? "\\" : "/";
  const absolute = isAbsolute(path) || !cwd ? path : `${cwd.replace(/[/\\]+$/, "")}${separator}${path}`;
  const crumbs: { label: string; path: string }[] = [];
  if (cwd && (absolute === cwd || absolute.startsWith(`${cwd}${separator}`))) {
    const rest = absolute === cwd ? [] : absolute.slice(cwd.length + 1).split(/[/\\]/).filter(Boolean);
    crumbs.push({ label: cwd.split(/[/\\]/).filter(Boolean).at(-1) ?? cwd, path: cwd });
    rest.forEach((segment, index) => crumbs.push({ label: segment, path: `${cwd}${separator}${rest.slice(0, index + 1).join(separator)}` }));
  } else {
    const segments = absolute.split(/[/\\]/).filter(Boolean);
    const root = absolute.startsWith("/") ? "/" : "";
    segments.forEach((segment, index) => crumbs.push({ label: segment, path: root + segments.slice(0, index + 1).join(separator) }));
  }
  if (crumbs.length <= tail + 1) return crumbs;
  const kept = crumbs.slice(-tail);
  return [{ label: "…", path: crumbs[crumbs.length - tail - 1].path }, ...kept];
}

function isAbsolute(path: string) {
  return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[/\\]/.test(path);
}
