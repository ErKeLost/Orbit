import {
  Children,
  type ComponentPropsWithoutRef,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { FileTypeIcon } from "../features/shell/FileTypeIcon";
import type { RenderOptions } from "beautiful-mermaid";

/**
 * Highlighting and diagram rendering are far more expensive than a reveal
 * commit, so neither runs while the fence is still arriving — the block stays
 * plain text until its source has held still, then upgrades in place.
 * Matches LobeHub Streamdown playground (`site/src/components/CodeBlock.tsx`).
 */
const useSettled = (value: string, delay = 180) => {
  const [settled, setSettled] = useState("");

  useEffect(() => {
    if (delay === 0) return;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return delay === 0 ? value : settled;
};

/** 同一个代码块会被反复挂载（切会话、重渲染），高亮结果按内容缓存。 */
const HIGHLIGHT_CACHE_LIMIT = 240;
const highlightCache = new Map<string, string>();
const highlightKey = (code: string, language: string) => `${language}\u0000${code}`;

function rememberHighlight(key: string, html: string) {
  highlightCache.set(key, html);
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
}

const MERMAID_OPTIONS: RenderOptions = {
  accent: "var(--color-content)",
  bg: "transparent",
  border: "var(--color-stroke)",
  fg: "var(--color-content)",
  font: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  line: "color-mix(in srgb, var(--color-content) 45%, transparent)",
  muted: "color-mix(in srgb, var(--color-content) 45%, transparent)",
  surface: "color-mix(in srgb, var(--color-content) 6%, transparent)",
  transparent: true,
};

const Mermaid = memo<{ code: string; settleDelay: number }>(({ code, settleDelay }) => {
  const settled = useSettled(code, settleDelay);
  const [svg, setSvg] = useState("");

  // 图表库是几 MB 的依赖，只有真的出现 mermaid 代码块时才加载。
  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    void import("beautiful-mermaid")
      .then(({ renderMermaidSVG }) => {
        if (cancelled) return;
        setSvg(renderMermaidSVG(settled, MERMAID_OPTIONS));
      })
      .catch(() => {
        if (!cancelled) setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [settled]);

  if (!svg || settled !== code) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }

  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
});

const Highlighted = memo<{ code: string; language: string; settleDelay: number }>(
  ({ code, language, settleDelay }) => {
    const settled = useSettled(code, settleDelay);
    const rootRef = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(() => typeof IntersectionObserver !== "function");
    const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);
    const key = settled ? highlightKey(settled, language) : "";
    const cached = key ? highlightCache.get(key) : undefined;

    // 长会话里大部分代码块都在屏幕外：等它们接近视口再高亮，打开会话时不必
    // 为几百个不可见的块跑一遍 Shiki/WASM。提前 1200px 预热，滚到的都是成品。
    useEffect(() => {
      const node = rootRef.current;
      if (!node || visible) return;
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) setVisible(true);
      }, { rootMargin: "1200px 0px" });
      observer.observe(node);
      return () => observer.disconnect();
    }, [visible]);

    const pending = Boolean(settled) && visible && cached === undefined && highlighted?.key !== key;
    useEffect(() => {
      if (!pending || !key) return;
      let cancelled = false;
      let idle: number | undefined;

      // Shiki 跑在 WASM 里，一帧就是几十毫秒。只在主线程空闲窗口里调度，
      // 不让高亮和流式输出/滚动抢帧；超时 600ms 保证不可见的情况下也会补完。
      const schedule = (run: () => void) => {
        if (typeof window.requestIdleCallback === "function") {
          idle = window.requestIdleCallback(run, { timeout: 600 });
          return;
        }
        idle = window.setTimeout(run, 0);
      };

      schedule(() => {
        void import("shiki")
          .then(({ codeToHtml }) =>
            codeToHtml(settled, {
              lang: language,
              themes: { dark: "vitesse-dark", light: "vitesse-light" },
            }),
          )
          .then((result) => {
            if (cancelled) return;
            rememberHighlight(key, result);
            setHighlighted({ key, html: result });
          })
          .catch(() => {
            if (cancelled) return;
            setHighlighted({ key, html: "" });
          });
      });

      return () => {
        cancelled = true;
        if (idle === undefined) return;
        if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
        else window.clearTimeout(idle);
      };
    }, [key, language, pending, settled]);

    // 缓存命中的块直接渲染，不再走一次 state 回写（那是同步 setState 警告的来源）。
    const html = cached ?? (highlighted?.key === key ? highlighted.html : "");
    if (!html || settled !== code) {
      return (
        <div ref={rootRef}>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      );
    }

    return <div className="highlighted" ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />;
  },
);

const toText = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  if (isValidElement<{ children?: unknown }>(node)) return toText(node.props.children);
  return "";
};

export function MarkdownLink({
  href,
  children,
  className = "",
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  if (href?.startsWith("mention:")) {
    return <span className={`md-chip is-mention ${className}`.trim()}>{children}</span>;
  }
  const external = Boolean(href && /^https?:\/\//.test(href));
  const attrs = external ? { target: "_blank" as const, rel: "noreferrer" } : {};
  return <a {...rest} {...attrs} href={href} dir="auto" className={`text-sky-400/90 hover:text-sky-300 hover:underline ${className}`.trim()}>{children}</a>;
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  css: "CSS",
  go: "Go",
  html: "HTML",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  mermaid: "Mermaid",
  plaintext: "纯文本",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  sh: "Bash",
  shell: "Bash",
  sql: "SQL",
  text: "纯文本",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  txt: "纯文本",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
};

const LANGUAGE_EXT: Record<string, string> = {
  bash: "sh",
  javascript: "js",
  json: "json",
  jsx: "jsx",
  markdown: "md",
  mermaid: "mmd",
  plaintext: "txt",
  python: "py",
  rust: "rs",
  shell: "sh",
  text: "txt",
  typescript: "ts",
  yaml: "yml",
};

function languageLabel(language?: string) {
  if (!language) return "纯文本";
  return LANGUAGE_LABELS[language.toLowerCase()] ?? language.toUpperCase();
}

function languageExt(language?: string) {
  if (!language) return "txt";
  const key = language.toLowerCase();
  return LANGUAGE_EXT[key] ?? (key.length <= 8 ? key : "txt");
}

function CodeCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      title={copied ? "已复制" : "复制代码"}
      aria-label={copied ? "已复制" : "复制代码"}
      className={`markdown-code-copy ${copied ? "is-copied" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true);
          if (timer.current != null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => undefined);
      }}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <g className="markdown-code-copy-pages">
          <path d="M12 4H6a2 2 0 0 0-2 2v6" />
          <rect x="7" y="7" width="9" height="9" rx="1.5" />
        </g>
        <path className="markdown-code-copy-check" d="M4.5 10.5 8.2 14 15.5 6.5" />
      </svg>
    </button>
  );
}

/** Orbit's code-fence chrome (`.markdown-code-shell`) around Orbit's shiki block. */
function CodeFrame({ language, code, children }: { language?: string; code: string; children: ReactNode }) {
  return (
    <div className="markdown-code-shell" dir="ltr">
      <div className="code-block">
        <div className="code-block-header">
          <span className="grid size-4 shrink-0 place-items-center">
            <FileTypeIcon name={`code.${languageExt(language)}`} isDir={false} size={14} />
          </span>
          <span>{languageLabel(language)}</span>
          <CodeCopyButton code={code} />
        </div>
        {children}
      </div>
    </div>
  );
}

export function Pre({
  children,
  settleDelay = 180,
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"pre"> & { settleDelay?: number; node?: unknown }) {
  const child = Children.toArray(children).find((node) =>
    isValidElement<{ className?: string }>(node),
  ) as ReactElement<{ className?: string }> | undefined;

  const language = /language-([^\s]+)/.exec(child?.props.className ?? "")?.[1];
  const code = toText(child ?? children).replace(/\n$/, "");
  const body =
    language === "mermaid" ? (
      <Mermaid code={code} settleDelay={settleDelay} />
    ) : language ? (
      <Highlighted code={code} language={language} settleDelay={settleDelay} />
    ) : (
      <pre {...rest}>{children}</pre>
    );

  return (
    <CodeFrame language={language} code={code}>
      {body}
    </CodeFrame>
  );
}
