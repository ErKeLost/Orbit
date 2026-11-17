import { invoke } from "../lib/native";
import { generateText } from "../lib/text-gen";
import type { HarnessId } from "../features/sessions/model/session";
import { gitRangeContext, gitStagedContext } from "../platform/tauri/fs";

export type PrContent = { title: string; body: string };

/**
 * Text generation through Orbit's own Pi runtime (Orbit routes these through
 * its harness registry). Each call runs the project's Pi CLI once, headlessly:
 * no session is created and no tools are exposed.
 */

async function runText(cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("已取消");
  const generated = await generateText(prompt).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    return null;
  });
  if (generated) return cleanUp(generated);
  return runPi(cwd, prompt, signal);
}

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

// Prompt text from T3 `provider-core/src/server/textGenerationPrompts.ts`.
function commitPrompt(summary: string, patch: string): string {
  return [
    "You write concise git commit messages.",
    "Return a JSON object with keys: subject, body.",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    "- capture the primary user-visible or developer-visible change",
    "",
    "Branch: (detached)",
    "",
    "Staged files:",
    summary.slice(0, 6_000),
    "",
    "Staged patch:",
    patch.slice(0, 40_000),
  ].join("\n");
}

function prPrompt(commits: string, summary: string, patch: string, base: string, head: string): string {
  return [
    "You write source control change request content.",
    "This is a new writing task, not a continuation of the supplied conversation.",
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title should be concise and specific",
    "- body must be markdown and include headings '## Summary' and '## Testing'",
    "- under Summary, provide short bullet points",
    "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
    "",
    `Base branch: ${base}`,
    `Head branch: ${head}`,
    "",
    "Commits:",
    commits.slice(0, 8_000),
    "",
    "Diff summary:",
    summary.slice(0, 6_000),
    "",
    "Diff patch:",
    patch.slice(0, 40_000),
  ].join("\n");
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
  const raw = await runText(cwd, commitPrompt(context.summary, context.patch), signal);
  if (!raw) throw new Error("Pi 没有返回内容，请稍后重试");
  return formatCommit(raw);
}

function formatCommit(text: string): string {
  const parsed = parseJson(text) as { subject?: unknown; body?: unknown; title?: unknown };
  const subject = typeof parsed?.subject === "string" ? parsed.subject.trim() : typeof parsed?.title === "string" ? parsed.title.trim() : "";
  if (!subject) return text;
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  return body ? `${subject}\n\n${body}` : subject;
}

function parseJson(text: string): { subject?: unknown; body?: unknown; title?: unknown } | null {
  const fenced = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(fenced ? fenced[0] : text) as { subject?: unknown; body?: unknown; title?: unknown };
  } catch {
    return null;
  }
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
  const text = await runText(cwd, prPrompt(context.commitSummary, context.diffSummary, context.diffPatch, context.base, context.head));
  const parsed = parsePrContent(text);
  return { ...parsed, base: context.base, head: context.head };
}
