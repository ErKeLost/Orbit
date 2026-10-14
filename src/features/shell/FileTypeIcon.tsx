import { memo, useSyncExternalStore } from "react";
import { Icon as Iconify, addCollection } from "@iconify/react/offline";

type Props = {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
  /** Kept for callers: Catppuccin has no separate root-folder glyphs. */
  isRoot?: boolean;
  size?: number;
};

type Associations = {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
  folderNames: Record<string, string>;
};

/**
 * File/folder icons are Catppuccin Icons (`catppuccin/vscode-icons`).
 *
 * The glyph set (~300 KB) and the filename→icon table (~59 KB) load after first
 * paint, the same rule the previous Material pack followed: neither belongs in
 * the boot chunk, and a same-sized blank holds the layout until they land.
 * `@iconify/react/offline` is used so a name that ever misses can never turn
 * into a network request.
 */
let associations: Associations | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load() {
  if (associations || loading) return;
  loading = Promise.all([
    import("@iconify-json/catppuccin/icons.json"),
    import("../files/model/catppuccinIconAssociations.json"),
  ]).then(([icons, table]) => {
    addCollection((icons.default ?? icons) as never);
    associations = ((table as { default?: Associations }).default ?? table) as Associations;
    for (const listener of listeners) listener();
  });
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  load();
  return () => {
    listeners.delete(onStoreChange);
  };
}

const snapshot = () => associations;

/** Filename maps to the matching Catppuccin icon. */
export const FileTypeIcon = memo(function FileTypeIcon({ name, isDir, isOpen = false, size = 16 }: Props) {
  const table = useSyncExternalStore(subscribe, snapshot, snapshot);
  const iconName = table ? (isDir ? resolveFolderIcon(table, name, isOpen) : resolveFileIcon(table, name)) : "";

  if (!table || !iconName) {
    return (
      <span aria-hidden className="inline-block shrink-0" style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      aria-hidden
      className="material-icon inline-block shrink-0 align-middle"
      style={{ width: size, height: size }}
    >
      <Iconify icon={`catppuccin:${iconName}`} width="100%" height="100%" />
    </span>
  );
});

/** Table keys are lowercase except a few (`CNAME`, `Tauri.toml`, `META-INF`). */
function lookup(map: Record<string, string>, key: string): string | undefined {
  return map[key] ?? map[key.toLowerCase()] ?? map[key.replace(/_/g, "-")];
}

function resolveFileIcon(table: Associations, fileName: string): string {
  const fromName = lookup(table.fileNames, fileName);
  if (fromName) return fromName;

  // The table keys extensions, so peel compound suffixes (`d.ts`, then `ts`).
  for (const ext of compoundExtensions(fileName.toLowerCase())) {
    const found = table.fileExtensions[ext];
    if (found) return found;
  }
  return "file";
}

function resolveFolderIcon(table: Associations, name: string, isOpen: boolean): string {
  const base = lookup(table.folderNames, name);
  if (base) return isOpen ? `${base}-open` : base;
  return isOpen ? "folder-open" : "folder";
}

function compoundExtensions(fileName: string): string[] {
  const parts = fileName.split(".");
  const start = parts[0] === "" ? 1 : 0;
  const exts: string[] = [];
  for (let i = start + 1; i < parts.length; i++) {
    exts.push(parts.slice(i).join("."));
  }
  return exts;
}
