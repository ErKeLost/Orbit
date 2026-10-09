/** Harness ids the source-control surface can reference (Orbit's union). */
export type HarnessId =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "pi"
  | "omp"
  | "fx"
  | (string & {});
