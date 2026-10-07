import { lazy, Suspense } from "react";
import type { Change } from "../lib/changes";

const CodeChangeImpl = lazy(() => import("./CodeChange").then((module) => ({ default: module.CodeChange })));

function fallbackText(change: Change) {
  return change.kind === "patch" ? change.patch : change.kind === "snippet" ? change.after : change.contents;
}

/** @pierre/diffs is ~560 KB; it loads the first time a diff or file is opened. */
export function CodeChange(props: { change: Change; compact?: boolean; wrap?: boolean }) {
  return (
    <Suspense fallback={<div className={`code-change${props.compact ? " is-compact" : ""}`}><pre className="diff-loading-fallback">{fallbackText(props.change)}</pre></div>}>
      <CodeChangeImpl {...props} />
    </Suspense>
  );
}
