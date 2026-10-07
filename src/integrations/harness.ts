import type { HarnessId } from "../features/sessions/model/session";

export type PrContent = { title: string; body: string };

/**
 * MonoCode generates commit messages and PR copy through its harness registry
 * (pi/claude/codex CLIs). Orbit's Pi runtime integration lands separately;
 * until then the surface degrades gracefully (the caller toasts the failure).
 */
export async function generateCommitMessage(
  _cwd: string,
  _preferred?: HarnessId,
  _signal?: AbortSignal,
): Promise<string> {
  throw new Error("AI 生成提交信息暂未接入");
}

export async function generatePrContent(
  _cwd: string,
  _preferred?: HarnessId,
): Promise<(PrContent & { base: string; head: string }) | null> {
  return null;
}
