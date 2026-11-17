/**
 * Classification from T3 `packages/shared/src/filePreview.ts`
 * (`officePreviewKind` / `binaryPreviewKind`). Rendering still depends on
 * what this app can show; the kind itself is theirs.
 */
export type PreviewKind = "document" | "sheet" | "slides" | "epub" | "sqlite" | "notebook" | "archive" | "font" | "rtf";

const OFFICE: Record<string, PreviewKind> = {
  docx: "document",
  odt: "document",
  rtf: "rtf",
  xlsx: "sheet",
  xlsm: "sheet",
  ods: "sheet",
  csv: "sheet",
  pptx: "slides",
  odp: "slides",
  epub: "epub",
  ipynb: "notebook",
};

const ARCHIVE = new Set(["zip", "jar", "tar", "gz", "tgz"]);
const SQLITE = new Set(["sqlite", "sqlite3", "db"]);
const FONT = new Set(["ttf", "otf", "woff", "woff2"]);

export function previewKind(path: string): PreviewKind | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return OFFICE[extension] ?? (SQLITE.has(extension) ? "sqlite" : ARCHIVE.has(extension) ? "archive" : FONT.has(extension) ? "font" : null);
}
