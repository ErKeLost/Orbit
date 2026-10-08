import { useEffect, useState } from "react";
import { listDir, type DirEntry } from "./git";

/**
 * Turning the file names a reply mentions into things you can click.
 *
 * The rule is the one the transcript wants, not a clever one: a name with a
 * file extension is a file name, whether it stands alone, carries a relative
 * path, or is absolute. Duplicates resolve to the first (shallowest) match.
 *
 * The guard rail is on the other side. A reply is full of inline code that is
 * not a path — `GALAXY_INK`, `METEOR_MAX`, `--ds-effort-thumb-w`, `bun test` —
 * and a chip on any of those is worse than no feature, so anything that fails
 * to resolve in the workspace stays exactly the plain text it was.
 */

/** Extensions worth calling a file name. A whitelist: `foo.bar` is not a file. */
const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "json5",
  "css", "scss", "less", "html", "htm", "md", "mdx", "txt", "csv", "tsv", "log",
  "rs", "toml", "py", "pyi", "go", "rb", "java", "kt", "kts", "swift", "m", "mm",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "lua", "dart", "ex", "exs",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "proto",
  "yml", "yaml", "xml", "plist", "lock", "env", "gitignore", "npmrc", "editorconfig",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "pdf", "woff", "woff2",
]);

/** Directories the workspace walk never descends into. */
const HEAVY_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", "coverage",
  ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "__pycache__", ".venv", "venv",
  ".pytest_cache", "Pods", "DerivedData",
]);

/** Enough of a workspace to resolve names in, and little enough to stay quick. */
const INDEX_LIMIT = 20_000;
const INDEX_DEPTH = 7;

export type PathHit = {
  /** Absolute, in the workspace's own separators — what `openFile` wants. */
  path: string;
  isDir: boolean;
};

/** `foo.ts:120:5` is a location, not part of the name. */
export function splitLocation(raw: string) {
  const match = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) return { text: raw, line: null as number | null };
  return { text: match[1], line: Number(match[2]) };
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function baseName(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

function dirName(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path.slice(0, 1) || "/" : path.slice(0, cut);
}

function join(base: string, rest: string) {
  if (!base) return rest;
  if (/[/\\]$/.test(base)) return base + rest;
  return `${base}${base.includes("\\") ? "\\" : "/"}${rest}`;
}

/** Does this inline code look like a file name or a path at all? */
export function looksLikePath(raw: string) {
  const { text } = splitLocation(raw);
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false; // urls
  if (trimmed.startsWith("-")) return false; // flags
  if (/^[~./\\]+$/.test(trimmed)) return false; // `.`, `..`, `~/`
  const name = baseName(trimmed.replace(/[/\\]+$/, ""));
  if (!name || name.startsWith("-")) return false;
  // The rule: a file name with an extension. A trailing slash is a directory.
  return FILE_EXTENSIONS.has(extensionOf(name)) || /[/\\]$/.test(trimmed);
}

const dirCache = new Map<string, DirEntry[]>();

async function listOnce(dir: string) {
  const cached = dirCache.get(dir);
  if (cached) return cached;
  let entries: DirEntry[] = [];
  try {
    entries = await listDir(dir);
  } catch {
    entries = [];
  }
  dirCache.set(dir, entries);
  if (dirCache.size > 64) {
    const oldest = dirCache.keys().next().value;
    if (oldest !== undefined) dirCache.delete(oldest);
  }
  return entries;
}

/** Does this exact path exist? One directory listing answers it. */
async function probe(absolute: string): Promise<PathHit | null> {
  const name = baseName(absolute);
  if (!name) return null;
  const entries = await listOnce(dirName(absolute));
  const found = entries.find((entry) => entry.name === name);
  return found ? { path: found.path, isDir: found.isDir } : null;
}

type WorkspaceIndex = {
  /** Base name to the shallowest path that carries it. */
  byName: Map<string, string>;
  depth: Map<string, number>;
  paths: string[];
};

let indexCache: { cwd: string; promise: Promise<WorkspaceIndex> } | null = null;

/**
 * Breadth first, so the shallow directories are always in the index: a reply
 * that names `utils.ts` means the one near the root, and a depth-first walk can
 * spend its whole budget inside the first subtree and never reach `src/` at all.
 * Being depth-ordered also makes "first match" and "shallowest match" the same
 * rule for free.
 */
async function walk(cwd: string, index: WorkspaceIndex, budget: { left: number }) {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  for (let head = 0; head < queue.length && budget.left > 0; head += 1) {
    const { dir, depth } = queue[head];
    let entries: DirEntry[];
    try {
      entries = await listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.ignored || budget.left <= 0) continue;
      budget.left -= 1;
      if (entry.isDir) {
        if (!HEAVY_DIRS.has(entry.name) && depth + 1 <= INDEX_DEPTH) {
          queue.push({ dir: entry.path, depth: depth + 1 });
        }
        continue;
      }
      index.paths.push(entry.path);
      if (!index.byName.has(entry.name)) {
        index.byName.set(entry.name, entry.path);
        index.depth.set(entry.name, depth);
      }
    }
  }
}

/** Walk the workspace once per session, lazily, and keep it. */
export function workspaceIndex(cwd: string) {
  if (indexCache?.cwd === cwd) return indexCache.promise;
  const index: WorkspaceIndex = { byName: new Map(), depth: new Map(), paths: [] };
  const promise = walk(cwd, index, { left: INDEX_LIMIT }).then(() => index);
  indexCache = { cwd, promise };
  return promise;
}

const resolveCache = new Map<string, PathHit | null>();

async function resolveUncached(trimmed: string, cwd: string, home: string): Promise<PathHit | null> {
  const clean = trimmed.replace(/[/\\]+$/, "");
  if (!clean) return null;
  const absolute = clean.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(clean);
  if (absolute) return probe(clean);

  const relative = clean.replace(/^~[/\\]?/, "");
  const rooted = /^~/.test(clean) && home ? join(home, relative) : null;
  if (rooted) {
    const hit = await probe(rooted);
    if (hit) return hit;
  }

  const hasDir = /[/\\]/.test(clean);
  if (hasDir) {
    const direct = await probe(join(cwd, clean));
    if (direct) return direct;
    if (/[/\\]$/.test(trimmed)) return null;
  } else {
    // A bare name: the index is the only thing that can place it.
    const index = await workspaceIndex(cwd);
    const found = index.byName.get(clean);
    if (found) return { path: found, isDir: false };
    return null;
  }

  // A partial path — `components/Button.tsx` for `src/components/Button.tsx`.
  // Duplicates take the first match, same rule as a bare name.
  const index = await workspaceIndex(cwd);
  const suffix = `/${clean}`;
  const matched = index.paths.find((path) => path.endsWith(suffix));
  return matched ? { path: matched, isDir: false } : null;
}

/** Where this piece of inline code actually points, if anywhere. */
export function resolveWorkspacePath(
  raw: string,
  cwd: string,
  home: string,
): Promise<PathHit | null> {
  if (!looksLikePath(raw) || !cwd) return Promise.resolve(null);
  const { text } = splitLocation(raw);
  const key = `${cwd}\u0000${home}\u0000${text.trim()}`;
  const cached = resolveCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  return resolveUncached(text.trim(), cwd, home).then((hit) => {
    if (resolveCache.size > 400) resolveCache.clear();
    resolveCache.set(key, hit);
    return hit;
  });
}

/**
 * The same thing as state. Resolves off the render path, so a transcript full
 * of paths costs nothing until each one answers.
 */
export function useWorkspacePath(raw: string | null, cwd: string, home: string): PathHit | null {
  const candidate = raw != null && looksLikePath(raw);
  const key = candidate && raw != null ? `${cwd}\u0000${home}\u0000${raw}` : null;
  const [answer, setAnswer] = useState<{ key: string; hit: PathHit | null } | null>(null);
  useEffect(() => {
    if (key == null || raw == null) return;
    let cancelled = false;
    void resolveWorkspacePath(raw, cwd, home).then((hit) => {
      if (!cancelled) setAnswer({ key, hit });
    });
    return () => {
      cancelled = true;
    };
  }, [key, cwd, home, raw]);
  // An answer for a token that has since changed is ignored, and "this is not a
  // path" needs no state write at all — it is simply null.
  return answer && answer.key === key ? answer.hit : null;
}
