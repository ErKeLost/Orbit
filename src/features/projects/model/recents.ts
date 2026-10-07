import { slash, prettyCwd } from "../../../shared/lib/paths";

export type RecentProject = {
  path: string;
  openedAt: number;
};

export function looksLikeProject(path: string): boolean {
  if (!path || path === "/" || path === "~") return false;
  const normalized = slash(path).replace(/\/+$/, "") || "/";
  if (/^[A-Za-z]:$/.test(normalized) || normalized === "/") return false;
  // Home itself arrives expanded (`/Users/me`), so the `~` check above misses
  // it. Indexing it walks `~/Library`, which trips the OS consent prompt.
  if (prettyCwd(path) === "~") return false;
  if (path.includes(".app/") || path.includes(".app\\")) return false;
  return true;
}

export function sameProjectPath(a: string, b: string): boolean {
  return slash(a).replace(/\/+$/, "") === slash(b).replace(/\/+$/, "");
}

export function isRemoteProjectPath(path: string): boolean {
  return path.startsWith("remote:") || path.includes(".remote/");
}
