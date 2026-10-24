import { useEffect, useRef, useState } from "react";
import { highlightToHtml, peekHtml } from "../lib/highlight";

/** File-preview highlighting. shiki lives in a Worker; this file only paints. */

const MAX_CHARS = 400_000;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "jsonc", css: "css", scss: "scss", less: "less", html: "html", htm: "html",
  vue: "vue", svelte: "svelte", md: "markdown", mdx: "mdx", txt: "text",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", m: "objc",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "shellscript",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", sql: "sql", xml: "xml",
  php: "php", lua: "lua", pl: "perl", r: "r", dart: "dart", zig: "zig",
  graphql: "graphql", gql: "graphql", prisma: "prisma", astro: "astro",
};

export function languageForFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (base === "Dockerfile") return "dockerfile";
  if (base === "Makefile") return "makefile";
  if (base.startsWith(".env")) return "dotenv";
  const extension = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_LANGUAGE[extension] ?? "text";
}

export function FileHighlighter({ code, fileName, wrap = false }: { code: string; fileName: string; wrap?: boolean }) {
  const language = languageForFileName(fileName);
  // null = 还没有结果（渲染纯文本）；"" = 这段不打算上色（纯文本/超大文件）。
  // 共享缓存命中时同步给出成品，重开一个文件不会先闪一下无色的文本。
  const [html, setHtml] = useState<string | null>(() =>
    language === "text" ? "" : peekHtml(code, language),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver !== "function");

  // 打开了整个仓库也不该为大文件里看不见的代码付 tokenize：接近视口再要。
  useEffect(() => {
    const node = rootRef.current;
    if (!node || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (language === "text" || code.length > MAX_CHARS) {
      setHtml("");
      return;
    }
    const cached = peekHtml(code, language);
    if (cached !== null) {
      setHtml(cached);
      return;
    }
    if (!visible) return;
    let cancelled = false;
    void highlightToHtml(code, language).then((next) => {
      // null 表示这条路径不可用（Worker 起不来/语言不认识），按纯文本收尾。
      if (!cancelled) setHtml(next ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, visible]);

  const plain = html === "" || html === null;
  return (
    <div
      ref={rootRef}
      data-file-highlighter
      className={`file-highlighter min-w-0 ${wrap ? "[&>pre]:whitespace-pre-wrap [&>pre]:break-words" : "[&>pre]:whitespace-pre"}`}
    >
      {plain ? (
        <pre className={`font-mono text-[12.5px] leading-5 text-content/85 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>{code}</pre>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
