import { useEffect, useRef, useState } from "react";

/** File-preview highlighting straight on shiki — no diff machinery. */

const cache = new Map<string, string>();
const CACHE_LIMIT = 40;
const MAX_CHARS = 400_000;

const cacheKey = (code: string, language: string) => `${language}\u0000${code}`;

function rememberCache(key: string, html: string) {
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

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
  const key = cacheKey(code, language);
  const [html, setHtml] = useState<string | null>(() => cache.get(key) ?? null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    // 超大文件直接纯文本，不让主线程为一次性预览跑几秒的 tokenize。
    if (code.length > MAX_CHARS || language === "text") {
      setHtml("");
      return;
    }
    let cancelled = false;
    const schedule = (run: () => void) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 500 });
        return;
      }
      window.setTimeout(run, 0);
    };
    schedule(() => {
      void import("shiki")
        .then(({ codeToHtml }) =>
          codeToHtml(code, {
            lang: language,
            themes: { dark: "vitesse-dark", light: "vitesse-light" },
          }),
        )
        .then((result) => {
          if (cancelled) return;
          rememberCache(key, result);
          setHtml(result);
        })
        .catch(() => {
          if (!cancelled) setHtml("");
        });
    });
    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  const plain = html === "";
  return (
    <div
      ref={rootRef}
      data-file-highlighter
      className={`file-highlighter min-w-0 ${wrap ? "[&>pre]:whitespace-pre-wrap [&>pre]:break-words" : "[&>pre]:whitespace-pre"}`}
    >
      {html === null || plain ? (
        <pre className={`font-mono text-[12.5px] leading-5 text-content/85 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>{code}</pre>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
