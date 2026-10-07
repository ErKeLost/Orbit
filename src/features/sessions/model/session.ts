/** Harness ids the source-control surface can reference (MonoCode's union). */
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
