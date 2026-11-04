import type { ComponentPropsWithoutRef } from "react";
import { FileTypeIcon } from "../features/shell/FileTypeIcon";
import { useShell } from "../features/shell/shellStore";
import { useWorkspace } from "../lib/store";
import { splitLocation, useWorkspacePath } from "../lib/markdown-paths";

/**
 * Inline code that names a file, made clickable, with the theme's accent behind
 * the whole path so it reads as a door rather than as code.
 *
 * Two rules hold the rest of the rendering still. The element is always the
 * same `<code>` with the same props, so every existing inline-code style keeps
 * applying; and the text is never rewritten — a bare name that resolves to
 * `src/lib/utils.ts` still shows `utils.ts`, and the full path goes in the
 * tooltip. The background sits on a `display: inline` button with padding only
 * on the sides, because this line box is 24px tall and a badge is what used to
 * make a one-line reply a pixel taller.
 */
export function PathChip({ node: _node, className, children, ...rest }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const cwd = useWorkspace((state) => state.cwd);
  const home = useWorkspace((state) => state.homeDir);
  const openFile = useShell((state) => state.openFile);
  const text = typeof children === "string" ? children : null;
  const hit = useWorkspacePath(text, cwd, home);

  if (!hit || text == null) return <code className={className} {...rest}>{children}</code>;

  const { text: withoutLine, line } = splitLocation(text);
  const basename = hit.path.split(/[\\/]/).filter(Boolean).at(-1) ?? hit.path;

  return (
    <code className={className} {...rest}>
      {/*
       * One button over the whole path, not just the file name: the leading
       * directories are part of what you are being offered, and a click on
       * `src/lib/` that does nothing reads as broken.
       *
       * The icon is the same file-type glyph the tree and tabs use, so a path
       * says what it is before it is read: a `.json` is not a `.png`.
       */}
      <button
        type="button"
        title={line != null ? `${hit.path}:${line}` : hit.path}
        aria-label={`打开 ${hit.path}`}
        onClick={() => openFile(hit.path, { pin: true, ...(hit.isDir ? { isDir: true } : {}) })}
        className="md-file-chip"
      >
        <FileTypeIcon name={basename} isDir={hit.isDir} size={13} />
        <span className="md-file-chip-label">{withoutLine}</span>
        {line != null ? <span className="md-file-chip-line">:{line}</span> : null}
      </button>
    </code>
  );
}
