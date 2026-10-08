import type { DisplayMessage, Part, PiMessage, Tool } from "../../lib/protocol";
import { IMAGE_TOOL_NAME } from "../../lib/protocol";
import { toolKind } from "../../lib/tool-activity";
import { withoutRuntimeImageNotes } from "../../lib/image-note";

/**
 * Projects Pi's message stream onto MonoCode's turn grammar:
 *
 *   user bubble
 *   [fold line: "worked for 14s"]   ← the work, folded once answered
 *     phase · phase · phase                  ← reasoning/tools grouped by narration
 *   final answer (full-size prose)
 *   footer: copy · actions · time
 *
 * Pure functions only, so the grouping can be unit-tested without React.
 */

export type StepKind = "think" | "tool" | "note" | "image";

export type TurnStep = {
  key: string;
  kind: StepKind;
  /** Thinking or note text. */
  text?: string;
  /** Tool call part (kind === "tool" | "image"). */
  part?: Part;
  /** Owning assistant message index within the turn. */
  messageIndex: number;
  /** True while this step is the live tail of a streaming message. */
  live: boolean;
};

export type WorkCategory = "edit" | "research" | "run" | "agent" | "computer" | "other";

export type Phase = {
  key: string;
  kind: WorkCategory | "think" | "note";
  headline?: TurnStep;
  steps: TurnStep[];
};

export type ProjectedTurn = {
  /** The user message that opened the turn, if any. */
  user?: DisplayMessage;
  /** Assistant/tool messages that answered it, in order. */
  items: DisplayMessage[];
  /** Work that folds behind the fold line. */
  work: TurnStep[];
  /** Generated images, always visible outside the fold (MonoCode's image blocks). */
  images: TurnStep[];
  /** The final answer's prose (and images), shown outside the fold. */
  answer: TurnStep[];
  /** Special rows (bash executions, compaction summaries) that stand alone. */
  specials: DisplayMessage[];
  /** The final assistant message, for copy/branch/time. */
  last?: DisplayMessage;
};

export function contentParts(message: PiMessage): Part[] {
  if (Array.isArray(message.content)) return message.content;
  return message.content ? [{ type: "text", text: message.content }] : [];
}

export function userText(message: PiMessage) {
  return contentParts(message)
    .flatMap((part) => (part.type === "text" && part.text ? [withoutRuntimeImageNotes(part.text)] : []))
    .join("\n")
    .trim();
}

export function userImages(message: PiMessage) {
  return contentParts(message).flatMap((part) => {
    if (part.type !== "image") return [];
    const src = part.data ? `data:${part.mimeType};base64,${part.data}` : part.url;
    return src ? [src] : [];
  });
}

export function toolName(part: Part, tools: Record<string, Tool>) {
  return part.name ?? tools[part.id ?? ""]?.name ?? "tool";
}

export function isImageTool(part: Part, tools: Record<string, Tool>) {
  const name = part.name ?? tools[part.id ?? ""]?.name;
  if (name) return name === IMAGE_TOOL_NAME;
  return (tools[part.id ?? ""]?.images?.length ?? 0) > 0;
}

export function workCategory(name: string): WorkCategory {
  const kind = toolKind(name);
  if (/(^|[_-])(agent|task|subagent|delegate)([_-]|$)/i.test(name)) return "agent";
  if (kind === "edit") return "edit";
  if (kind === "read" || kind === "search") return "research";
  if (kind === "command") return "run";
  if (kind === "computer") return "computer";
  return "other";
}

/** Steps for one assistant message: thinking, notes (non-final prose), tools. */
function messageSteps(item: DisplayMessage, messageIndex: number, live: boolean, tools: Record<string, Tool>): TurnStep[] {
  const parts = contentParts(item.message);
  return parts.flatMap((part, partIndex): TurnStep[] => {
    const key = `${item.id}-${partIndex}`;
    const tail = live && partIndex === parts.length - 1;
    if (part.type === "thinking") {
      if (!part.thinking?.trim() && !(tail && !part.thinkingComplete)) return [];
      return [{ key, kind: "think", text: part.thinking ?? "", messageIndex, live: tail && !part.thinkingComplete }];
    }
    if (part.type === "toolCall") {
      return [{ key, kind: isImageTool(part, tools) ? "image" : "tool", part, messageIndex, live: Boolean(tools[part.id ?? ""]?.running) }];
    }
    if (part.type === "text") {
      const text = withoutRuntimeImageNotes(part.text ?? "");
      if (!text.trim()) return [];
      return [{ key, kind: "note", text, messageIndex, live: tail }];
    }
    if (part.type === "image") {
      return [{ key, kind: "image", part, messageIndex, live: false }];
    }
    return [];
  });
}

const SPECIAL_ROLES = new Set(["bashExecution", "compactionSummary"]);

/**
 * Splits one transcript group (a user message or an assistant run) into the
 * work that folds and the answer that stays. The answer is the trailing prose
 * of the final message once it stopped normally; everything before it is work.
 */
export function projectTurn(
  items: DisplayMessage[],
  tools: Record<string, Tool>,
  streaming: boolean,
): ProjectedTurn {
  const first = items[0];
  if (first?.message.role === "user") {
    return { user: first, items: [], work: [], images: [], answer: [], specials: [] };
  }
  const specials = items.filter((item) => SPECIAL_ROLES.has(item.message.role));
  const assistant = items.filter((item) => !SPECIAL_ROLES.has(item.message.role));
  const steps = assistant.flatMap((item, index) => messageSteps(item, index, streaming && index === assistant.length - 1, tools));
  const last = assistant.at(-1);
  const lastIndex = assistant.length - 1;
  const stoppedCleanly =
    !last?.message.errorMessage && (!last?.message.stopReason || last.message.stopReason === "stop");
  const lastHasTool = steps.some((step) => step.messageIndex === lastIndex && step.kind === "tool");

  // The answer is the run of notes at the very end of the final message, as
  // long as no tool call follows them. The prose is promoted only once the
  // turn has settled: while streaming, every narration stays inside the work
  // fold, so intermediate summaries never flash through the answer renderer.
  // Successful image generations are content, not process (MonoCode appends
  // them as first-class image blocks): lift them out of the work steps so they
  // render outside the fold. Failed calls stay behind as ordinary tool rows.
  const imageSteps = steps.filter(
    (step) => step.kind === "image" && step.part?.type === "toolCall" && !tools[step.part.id ?? ""]?.isError,
  );
  const imageKeys = new Set(imageSteps.map((step) => step.key));
  const workRest = steps.filter((step) => !imageKeys.has(step.key));
  let split = workRest.length;
  if (!streaming && stoppedCleanly && !lastHasTool) {
    while (split > 0) {
      const step = workRest[split - 1];
      if (step.messageIndex !== lastIndex) break;
      if (step.kind === "note" || (step.kind === "image" && step.part?.type === "image")) split -= 1;
      else break;
    }
  }
  return {
    items,
    work: workRest.slice(0, split),
    images: imageSteps,
    answer: workRest.slice(split),
    specials,
    last,
  };
}

/**
 * Groups work into phases the way MonoCode does: a line the agent wrote starts
 * a new phase and titles it; thinking sits inside the current phase.
 */
export function buildPhases(steps: TurnStep[], tools: Record<string, Tool>): Phase[] {
  const phases: Phase[] = [];
  let current: Phase | undefined;
  const open = (kind: Phase["kind"], headline?: TurnStep) => {
    current = { key: headline?.key ?? "", kind, headline, steps: [] };
    phases.push(current);
    return current;
  };
  for (const step of steps) {
    if (step.kind === "think") {
      if (!current) current = open("think");
      current.steps.push(step);
      if (!current.key) current.key = step.key;
      continue;
    }
    if (step.kind === "note") {
      const narrating = current?.kind === "think" || current?.kind === "note";
      if (!current || !narrating || current.headline) {
        open("note", step);
      } else {
        current.headline = step;
        current.kind = "note";
      }
      continue;
    }
    if (!current) current = open("other");
    if (!current.key) current.key = step.key;
    current.steps.push(step);
    if (step.part) {
      const category = workCategory(toolName(step.part, tools));
      if (current.kind === "think" || current.kind === "note" || current.kind === "other") current.kind = category;
    }
  }
  return phases;
}

type Tally = { edits: Set<string>; reads: Set<string>; searches: number; runs: number; agents: number; computer: number; others: number; order: WorkCategory[] };

function stepTarget(part: Part) {
  const args = part.arguments ?? {};
  for (const field of ["path", "file_path", "filePath", "file"]) {
    const value = args[field];
    if (typeof value === "string" && value) return value;
  }
  return part.id ?? "";
}

function tally(steps: TurnStep[], tools: Record<string, Tool>): Tally {
  const result: Tally = { edits: new Set(), reads: new Set(), searches: 0, runs: 0, agents: 0, computer: 0, others: 0, order: [] };
  for (const step of steps) {
    if (step.kind !== "tool" && step.kind !== "image") continue;
    if (!step.part || step.part.type !== "toolCall") continue;
    const name = toolName(step.part, tools);
    const category = workCategory(name);
    if (!result.order.includes(category)) result.order.push(category);
    if (category === "edit") result.edits.add(stepTarget(step.part));
    else if (category === "research") {
      if (toolKind(name) === "read") result.reads.add(stepTarget(step.part));
      else result.searches += 1;
    } else if (category === "run") result.runs += 1;
    else if (category === "agent") result.agents += 1;
    else if (category === "computer") result.computer += 1;
    else result.others += 1;
  }
  return result;
}

const fileCount = (files: Set<string>) => `${files.size} 个文件`;

function categorySummary(kind: WorkCategory, t: Tally, live: boolean) {
  switch (kind) {
    case "edit":
      return `${live ? "正在编辑" : "编辑了"} ${fileCount(t.edits)}`;
    case "research":
      if (t.reads.size > 0 && t.searches === 0) return `${live ? "正在读取" : "读取了"} ${fileCount(t.reads)}`;
      if (t.reads.size === 0) return live ? "正在搜索项目" : "搜索了项目";
      return live ? "正在浏览项目" : "浏览了项目";
    case "run":
      return t.runs === 1 ? (live ? "正在运行命令" : "运行了命令") : `${live ? "正在运行" : "运行了"} ${t.runs} 条命令`;
    case "agent":
      return t.agents === 1 ? (live ? "正在运行子 agent" : "运行了子 agent") : `${live ? "正在运行" : "运行了"} ${t.agents} 个子 agent`;
    case "computer":
      return live ? "正在操作电脑" : `操作了电脑 ${t.computer} 次`;
    default:
      return t.others === 1 ? (live ? "正在调用工具" : "调用了工具") : `${live ? "正在调用" : "调用了"} ${t.others} 个工具`;
  }
}

/** MonoCode's `workSummaryLine`, in Chinese. */
export function workSummaryLine(steps: TurnStep[], tools: Record<string, Tool>, live = false) {
  const t = tally(steps, tools);
  if (t.order.length === 0) return live ? "正在思考" : "已思考";
  const running = live ? t.order.at(-1) : undefined;
  return t.order.map((kind) => categorySummary(kind, t, kind === running)).join(" · ");
}

/** First readable paragraph of prose, stripped of markdown (MonoCode `proseSummary`). */
export function proseSummary(text: string) {
  const body = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  const paragraph = body.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return paragraph
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function phaseTitle(phase: Phase, tools: Record<string, Tool>, live: boolean) {
  if (phase.headline?.text) {
    const summary = proseSummary(phase.headline.text);
    if (summary) return summary;
  }
  return workSummaryLine(phase.steps, tools, live);
}

export function formatElapsed(elapsedMs: number | null | undefined) {
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return null;
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** MonoCode `formatWorkingDuration`, without the model prefix: "worked for 14s". */
export function formatWorkingDuration(elapsedMs: number | null | undefined, modelName?: string, done = false) {
  const who = modelName?.trim();
  const elapsed = formatElapsed(elapsedMs);
  const verb = done ? (who ? "worked" : "Worked") : who ? "working" : "Working";
  if (elapsed == null) return done ? (who ? `${who} ${verb}` : verb) : who ? `${who} ${verb}…` : `${verb}…`;
  return who ? `${who} ${verb} for ${elapsed}` : `${verb} for ${elapsed}`;
}

/** Tool row label: MonoCode's "<Verb> <target>" grammar. */
export function toolLabel(part: Part, tools: Record<string, Tool>) {
  const name = toolName(part, tools);
  const args = part.arguments ?? {};
  const first = (fields: string[]) => {
    for (const field of fields) {
      const value = args[field];
      if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
    }
    return "";
  };
  const kind = toolKind(name);
  if (kind === "read") return { action: "Read", target: first(["path", "file_path", "filePath", "file", "url"]), file: true };
  if (kind === "edit") return { action: /write|create/i.test(name) ? "Write" : "Edit", target: first(["path", "file_path", "filePath", "file"]), file: true };
  if (kind === "search") return { action: /list|ls/i.test(name) ? "List" : "Find", target: first(["pattern", "query", "glob", "path"]), file: false };
  if (kind === "command") return { action: "Run", target: first(["command", "cmd", "script"]), file: false };
  if (kind === "computer") return { action: "Computer", target: first(["goal", "app", "url", "target"]), file: false };
  return { action: name, target: first(["path", "query", "command", "input", "url", "name"]), file: false };
}
