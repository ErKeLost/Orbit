import { useMemo, type ReactNode } from "react";
import { FileTypeIcon } from "../../features/shell/FileTypeIcon";
import { useShell } from "../../features/shell/shellStore";
import { useWorkspace } from "../../lib/store";

/**
 * `[label](src/foo.ts)` 和 `[label](src/foo.ts#L12)` 这类**指向文件的链接**。
 *
 * t3code 的规则：markdown 链接只要落在文件上，就不画成普通蓝字，而是画成
 * 带文件类型图标的 chip——图标是"这个文件是什么"，文字是作者写的标签。
 * 点击打开编辑器；`#L12` / `:12` 的行号保留下来，标题栏里显示完整路径。
 *
 * 判据刻意保守，只收"有扩展名或结尾是 `/`"的目标，避免把 `docs/getting-started`
 * 这种真链接误吞成文件。
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `foo.ts#L1-L10` / `foo.ts:12` → 路径与行号范围。 */
export function parseFileHref(href: string | undefined) {
  if (!href) return null;
  const trimmed = href.trim();
  const hash = /#L(\d+)(?:-L?(\d+))?$/i.exec(trimmed);
  if (hash) {
    return {
      path: trimmed.slice(0, hash.index),
      line: Number(hash[1]),
      lineEnd: hash[2] === undefined ? undefined : Number(hash[2]),
    };
  }
  const suffix = /:(\d+)(?::\d+)?$/.exec(trimmed);
  if (suffix) {
    return {
      path: trimmed.slice(0, suffix.index),
      line: Number(suffix[1]),
      lineEnd: undefined,
    };
  }
  return { path: trimmed, line: undefined, lineEnd: undefined };
}

export function filePathFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  if (/^(?:https?|mailto|data|blob|mention):/i.test(trimmed)) return null;
  // `C:\repo\a.ts` 的 `C:` 也是一个"scheme"，但它是盘符，不是协议。
  const drive = /^[a-zA-Z]:[\\/]/.test(trimmed);
  if (!drive && SCHEME.test(trimmed) && !/^file:/i.test(trimmed)) return null;

  const withoutScheme = trimmed.replace(/^file:\/\//i, "");
  const path = parseFileHref(withoutScheme)?.path ?? withoutScheme;
  const decoded = (() => {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  })();
  const clean = decoded.split("?")[0] ?? decoded;
  if (!clean) return null;
  // 有扩展名的文件名，或显式以 `/` 结尾的目录。
  return /\.[A-Za-z0-9_-]+$/.test(clean) || /\/$/.test(clean) ? clean : null;
}

export function lineFromHref(href: string | undefined) {
  const parsed = parseFileHref(href);
  if (!parsed || parsed.line === undefined) return undefined;
  return parsed.lineEnd !== undefined ? `${parsed.line}-${parsed.lineEnd}` : String(parsed.line);
}

/** 相对路径落到绝对路径上，点击才开得动。 */
function absolute(path: string, cwd: string) {
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return path;
  if (path.startsWith("~/")) return path;
  const separator = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${path.replace(/^\.\//, "")}`;
}

export function MarkdownFileLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const cwd = useWorkspace((state) => state.cwd);
  const home = useWorkspace((state) => state.homeDir);
  const openFile = useShell((state) => state.openFile);
  const path = filePathFromHref(href);
  const line = lineFromHref(href);

  const target = useMemo(() => {
    if (!path) return null;
    if (path.startsWith("~/")) return home ? `${home}${path.slice(1)}` : path;
    if (!cwd) return path;
    return absolute(path, cwd);
  }, [path, cwd, home]);

  if (!path || !target) return null;

  const label = typeof children === "string" ? children : path;
  const basename = target.split(/[\\/]/).filter(Boolean).at(-1) ?? target;
  const isDir = /[\\/]$/.test(target);
  const lineText = line !== undefined ? `L${line}` : null;

  return (
    <a
      className="md-file-chip"
      href={href}
      dir="ltr"
      title={line !== undefined ? `${target}:${String(line).split("-")[0]}` : target}
      onClick={(event) => {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) {
          void navigator.clipboard?.writeText(target).catch(() => undefined);
          return;
        }
        openFile(target, { pin: true, ...(isDir ? { isDir: true } : {}) });
      }}
    >
      <FileTypeIcon name={basename} isDir={isDir} size={13} />
      <span className="md-file-chip-label">{label}</span>
      {lineText ? <span className="md-file-chip-line">{lineText}</span> : null}
    </a>
  );
}
