/**
 * Path helpers shared by the notes feature (MonoCode's shared/lib/paths).
 * Only the pieces the notes surface needs are kept here.
 */

const IS_WIN =
  typeof navigator !== "undefined" &&
  (/^Win/.test(navigator.platform || "") || /Windows/.test(navigator.userAgent || ""));

function windowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

export function slash(path: string): string {
  return windowsPath(path) || (IS_WIN && !path.startsWith("/"))
    ? path.replace(/\\/g, "/") : path;
}

function trimSlash(path: string): string {
  return slash(path).replace(/\/+$/, "") || "/";
}

/** Stable comparison key for Windows paths without changing their display case. */
export function pathKey(path: string): string {
  const normalized = trimSlash(path);
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function prettyCwd(cwd: string): string {
  const trimmed = trimSlash(cwd);
  if (trimmed === "~") return "~";

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "Users" || parts[0] === "home")) {
    const rest = parts.slice(2).join("/");
    return rest ? `~/${rest}` : "~";
  }
  if (
    parts.length >= 3 &&
    /^[A-Za-z]:$/.test(parts[0]) &&
    parts[1] === "Users"
  ) {
    const rest = parts.slice(3).join("/");
    return rest ? `~/${rest}` : "~";
  }
  return trimmed;
}

export function parentPath(path: string): string {
  const trimmed = slash(path);
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

/** Folder name for tab labels — `~` when the cwd is home. */
export function projectName(cwd: string): string {
  if (!cwd || prettyCwd(cwd) === "~") return "~";
  const trimmed = trimSlash(cwd);
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed;
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * Identity for a project's saved appearance and data. Folder names repeat across
 * checkouts (`cortex/agentbase` and `cortex-finance/agentbase`), so the whole
 * path is the key — `projectName` is for display only.
 */
export function projectKey(cwd: string): string {
  return pathKey(cwd);
}
