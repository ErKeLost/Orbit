import { invoke } from "../lib/native";
import type { HarnessId } from "../features/sessions/model/session";
import { gitRangeContext, gitStagedContext } from "../platform/tauri/fs";

export type PrContent = { title: string; body: string };

/**
 * Text generation through Orbit's own Pi runtime (Orbit routes these through
 * its harness registry). Each call runs the project's Pi CLI once, headlessly:
 * no session is created and no tools are exposed.
 */

async function runPi(cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("已取消");
  const text = await invoke<string>("pi_oneshot", { cwd, prompt });
  if (signal?.aborted) throw new Error("已取消");
  return cleanUp(text);
}

/** Strips markdown fences and keeps the response readable as commit copy. */
function cleanUp(text: string): string {
  const withoutFence = text
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```\s*$/i, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
  return withoutFence.length > 600 ? `${withoutFence.slice(0, 597)}…` : withoutFence;
}

const COMMIT_PROMPT = [
  "You write git commit messages. Reply with ONLY the commit message — no quotes, no code fences, no explanation.",
  "Use the repository's language for the subject if the diff suggests one; otherwise match the diff's content language.",
  "Keep the subject under 72 characters, imperative mood, no trailing period. Add a short body only when the why is not obvious.",
  "",
  "Staged summary:",
  "",
  "{{SUMMARY}}",
  "",
  "Staged patch:",
  "",
  "{{PATCH}}",
].join("\n");

const PR_PROMPT = [
  "You write pull request descriptions. Reply with ONLY a JSON object of shape {\"title\": string, \"body\": string} — no code fences, no commentary.",
  "The title is one concise line. The body explains what changed and why in short markdown bullets, in the same language as the changes.",
  "",
  "Commits in range:",
  "",
  "{{COMMITS}}",
  "",
  "Diff summary:",
  "",
  "{{SUMMARY}}",
  "",
  "Diff patch (truncated):",
  "",
  "{{PATCH}}",
].join("\n");

const MAX_PROMPT_PATCH = 12_000;

function truncate(text: string, max = MAX_PROMPT_PATCH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

/** Generate a commit message from the staged diff via the project's Pi. */
export async function generateCommitMessage(
  cwd: string,
  _preferred?: HarnessId,
  signal?: AbortSignal,
): Promise<string> {
  const context = await gitStagedContext(cwd);
  if (!context.patch.trim() && !context.summary.trim()) {
    throw new Error("没有暂存的更改，先暂存再生成提交信息");
  }
  const prompt = COMMIT_PROMPT.replace("{{SUMMARY}}", truncate(context.summary, 2_000))
    .replace("{{PATCH}}", truncate(context.patch));
  const message = await runPi(cwd, prompt, signal);
  if (!message) throw new Error("Pi 没有返回内容，请稍后重试");
  return message;
}

function parsePrContent(text: string): PrContent {
  const fenced = text.match(/\{[\s\S]*\}/);
  const candidate = fenced ? fenced[0] : text;
  try {
    const parsed = JSON.parse(candidate) as { title?: unknown; body?: unknown };
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      return { title: parsed.title.trim(), body: typeof parsed.body === "string" ? parsed.body.trim() : "" };
    }
  } catch {
    // fall through to plain-text parsing
  }
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Pi 没有返回内容，请稍后重试");
  return { title: lines[0].trim(), body: lines.slice(1).join("\n").trim() };
}

/** Generate PR title/body from the branch's diff; null when there is nothing to diff. */
export async function generatePrContent(
  cwd: string,
  _preferred?: HarnessId,
): Promise<(PrContent & { base: string; head: string }) | null> {
  const context = await gitRangeContext(cwd);
  if (!context.diffPatch.trim() && !context.commitSummary.trim()) return null;
  const prompt = PR_PROMPT.replace("{{COMMITS}}", truncate(context.commitSummary, 4_000))
    .replace("{{SUMMARY}}", truncate(context.diffSummary, 2_000))
    .replace("{{PATCH}}", truncate(context.diffPatch));
  const text = await runPi(cwd, prompt);
  const parsed = parsePrContent(text);
  return { ...parsed, base: context.base, head: context.head };
}
