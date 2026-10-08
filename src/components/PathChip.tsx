import type { ComponentPropsWithoutRef } from "react";
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

  return (
    <code className={className} {...rest}>
      {/*
       * One button over the whole path, not just the file name: the leading
       * directories are part of what you are being offered, and a click on
       * `src/lib/` that does nothing reads as broken.
       */}
      <button
        type="button"
        title={hit.path}
        aria-label={`打开 ${hit.path}`}
        onClick={() => openFile(hit.path, { pin: true })}
        className="inline cursor-pointer rounded-[4px] bg-accent/15 px-1 font-[inherit] text-accent transition-colors hover:bg-accent/25 focus-visible:bg-accent/25 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
      >
        {withoutLine}
        {line != null ? <span className="text-accent/55">:{line}</span> : null}
      </button>
    </code>
  );
}
