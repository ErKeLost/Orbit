import { lazy, Suspense } from "react";
import type { Change } from "../lib/changes";
import { FileHighlighter } from "./FileHighlighter";

const CodeChangeImpl = lazy(() => import("./CodeChange").then((module) => ({ default: module.CodeChange })));

function fallbackText(change: Change) {
  return change.kind === "patch" ? change.patch : change.kind === "snippet" ? change.after : change.contents;
}

/** 只在打开增删 diff 时加载 @pierre/diffs；read / 命令等普通内容直接用 Shiki。 */
export function CodeChange(props: { change: Change; compact?: boolean; wrap?: boolean }) {
  if (props.change.kind === "file") {
    return (
      <div className={`code-change${props.compact ? " is-compact" : ""}`}>
        {props.change.label !== false ? <div className="diff-toolbar">{props.change.label ?? props.change.name}</div> : null}
        <div className="max-h-[520px] overflow-auto p-3">
          <FileHighlighter code={props.change.contents} fileName={props.change.name} wrap={props.wrap} />
        </div>
      </div>
    );
  }
  return (
    <Suspense fallback={<div className={`code-change${props.compact ? " is-compact" : ""}`}><pre className="diff-loading-fallback">{fallbackText(props.change)}</pre></div>}>
      <CodeChangeImpl {...props} />
    </Suspense>
  );
}
