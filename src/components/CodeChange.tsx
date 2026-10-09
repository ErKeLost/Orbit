import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { PatchDiff, MultiFileDiff, File } from "@pierre/diffs/react";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { useColorScheme } from "../lib/appearance";
import type { Change } from "../lib/changes";

class DiffBoundary extends Component<{ children: ReactNode; fallback: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <pre className="diff-fallback">{this.props.fallback}</pre> : this.props.children;
  }
}

/** Diff / file rendering stays on @pierre/diffs; only the chrome follows Orbit. */
export function CodeChange({ change, compact = false, wrap = false }: { change: Change; compact?: boolean; wrap?: boolean }) {
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const [highlightResult, setHighlightResult] = useState<{ key: string; state: "ready" | "fallback" }>({ key: "", state: "fallback" });
  const scheme = useColorScheme();
  const diffTheme = scheme === "light" ? ("pierre-light" as const) : ("pierre-dark" as const);
  const overflow = wrap ? ("wrap" as const) : ("scroll" as const);
  const options = useMemo(
    () => ({ diffStyle: style, theme: diffTheme, overflow, disableFileHeader: true, tokenizeMaxLength: 40_000, tokenizeMaxLineLength: 2_000 }),
    [diffTheme, overflow, style],
  );
  const fileOptions = useMemo(
    () => ({ theme: diffTheme, overflow, disableFileHeader: true, tokenizeMaxLength: 40_000, tokenizeMaxLineLength: 2_000 }),
    [diffTheme, overflow],
  );
  const language = useMemo(() => getFiletypeFromFileName(change.name), [change.name]);
  const highlightKey = useMemo(
    () =>
      `${diffTheme}:${language}:${change.kind}:${change.name}:${
        change.kind === "patch" ? change.patch : change.kind === "snippet" ? `${change.before}\0${change.after}` : change.contents
      }`,
    [change, diffTheme, language],
  );
  const oldFile = useMemo(() => ({ name: change.name, lang: language, contents: change.kind === "snippet" ? change.before : "" }), [change, language]);
  const newFile = useMemo(
    () => ({ name: change.name, lang: language, contents: change.kind === "snippet" ? change.after : change.kind === "file" ? change.contents : "" }),
    [change, language],
  );
  const fallback = change.kind === "patch" ? change.patch : change.kind === "snippet" ? change.after : change.contents;
  const label = change.label ?? (change.kind === "snippet" ? "替换片段（不是完整文件）" : change.kind === "file" ? "写入内容" : change.name);

  useEffect(() => {
    let active = true;
    void preloadHighlighter({ themes: [diffTheme], langs: [language] })
      .then(() => { if (active) setHighlightResult({ key: highlightKey, state: "ready" }); })
      .catch(() => { if (active) setHighlightResult({ key: highlightKey, state: "fallback" }); });
    return () => {
      active = false;
    };
  }, [diffTheme, highlightKey, language]);

  const highlightState = highlightResult.key === highlightKey ? highlightResult.state : "loading";
  const loading = <pre className="diff-loading-fallback">{fallback}</pre>;
  return (
    <div className={`code-change${compact ? " is-compact" : ""}`}>
      {label !== false ? (
        <div className="diff-toolbar">
          <span className="min-w-0 truncate">{label}</span>
          {change.kind !== "file" ? (
            <button
              type="button"
              onClick={() => setStyle((value) => (value === "split" ? "unified" : "split"))}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-content/50 hover:bg-content/10 hover:text-content"
            >
              {style === "split" ? "统一视图" : "并排视图"}
            </button>
          ) : null}
        </div>
      ) : null}
      <DiffBoundary fallback={fallback}>
        {highlightState !== "ready" ? loading : change.kind === "patch" ? (
          <PatchDiff patch={change.patch} options={options} />
        ) : change.kind === "snippet" ? (
          <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />
        ) : (
          <File file={newFile} options={fileOptions} />
        )}
      </DiffBoundary>
    </div>
  );
}
