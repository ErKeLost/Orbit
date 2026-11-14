import type { DisplayMessage, Part, Tool } from "../../lib/protocol";
import { toolLabel, toolName, type TurnStep } from "./turnModel";

/**
 * OpenCode's `todowrite` list, as the user sees it.
 *
 * The tool keeps no server state: the current plan is the input of the latest
 * call. Pi has no paired read tool — this module is that read.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type Todo = {
  content: string;
  status: TodoStatus;
};

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

export function isTodoToolName(name: string) {
  return /^(?:todo[_-]?write|todo[_-]?read)$/i.test(name);
}

export function isTodoStep(step: TurnStep, tools: Record<string, Tool>) {
  return step.kind === "tool" && step.part != null && isTodoToolName(toolName(step.part, tools));
}

function asStatus(value: unknown): TodoStatus {
  return typeof value === "string" && STATUSES.has(value as TodoStatus) ? (value as TodoStatus) : "pending";
}

/** `null` when the value is not a list at all; `[]` is a deliberate clear. */
export function todosFromValue(value: unknown): Todo[] | null {
  if (!Array.isArray(value)) return null;
  const todos: Todo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) continue;
    todos.push({ content, status: asStatus(record.status) });
  }
  return todos;
}

export function todosFromCall(part: Part | undefined, tool: Tool | undefined): Todo[] | null {
  const details = tool?.details as { todos?: unknown } | undefined;
  const fromDetails = todosFromValue(details?.todos);
  if (fromDetails) return fromDetails;
  const args = (part?.arguments ?? tool?.args) as { todos?: unknown } | undefined;
  return todosFromValue(args?.todos);
}

export function todoFinished(todo: Todo) {
  return todo.status === "completed" || todo.status === "cancelled";
}

/** The todo in hand: the one in progress, else the next pending, else the last finished. */
export function currentTodo(todos: readonly Todo[]) {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    [...todos].reverse().find((todo) => todo.status === "completed") ??
    todos[0]
  );
}

export function todoProgress(todos: readonly Todo[]) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return { done, total: todos.length };
}

export type TaskChild = {
  key: string;
  label: string;
  durationMs?: number;
  running: boolean;
};

export type TaskPlan = {
  todos: Todo[];
  durationMs?: number;
  running: boolean;
  note?: string;
  children: TaskChild[];
};

function activityLabel(action: string, target: string) {
  if (action === "Search" && target) return `Searching for “${target}”`;
  if (action === "Read" && target) return `Reading ${target}`;
  if (action === "Fetch" && target) return `Fetching ${target}`;
  if (action === "Edit" && target) return `Editing ${target}`;
  if (action === "Write" && target) return `Writing ${target}`;
  if (action === "Run" && target) return `Running ${target}`;
  return [action, target].filter(Boolean).join(" ");
}

/**
 * The plan this turn is working from, plus the tool calls that followed the
 * latest write — those belong under the item in progress.
 */
export function planFromSteps(steps: readonly TurnStep[], tools: Record<string, Tool>): TaskPlan | null {
  let lastIndex = -1;
  for (let index = 0; index < steps.length; index += 1) {
    if (isTodoStep(steps[index], tools)) lastIndex = index;
  }
  if (lastIndex < 0) return null;
  const step = steps[lastIndex];
  const part = step.part;
  const tool = part?.id ? tools[part.id] : undefined;
  const todos = todosFromCall(part, tool);
  if (!todos) return null;
  if (!todos.length && !tool?.running && !step.live) return null;

  let note: string | undefined;
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const previous = steps[index];
    if (previous.kind === "tool") break;
    if (previous.kind !== "note" || !previous.text) continue;
    const text = previous.text.trim().replace(/\s+/g, " ");
    if (text && text.length <= 160) note = text;
    break;
  }

  const children: TaskChild[] = [];
  for (const later of steps.slice(lastIndex + 1)) {
    if (later.kind !== "tool" || !later.part) continue;
    if (isTodoToolName(toolName(later.part, tools))) continue;
    const labeled = toolLabel(later.part, tools);
    const child = later.part.id ? tools[later.part.id] : undefined;
    const label = activityLabel(labeled.action, labeled.target);
    if (!label) continue;
    children.push({
      key: later.key,
      label,
      durationMs: child?.durationMs,
      running: Boolean(child?.running),
    });
  }

  return {
    todos,
    durationMs: tool?.durationMs,
    running: Boolean(tool?.running) || step.live,
    note,
    children,
  };
}

/** Latest plan in the session, ignoring a failed write. */
export function latestTodos(messages: readonly DisplayMessage[], tools: Record<string, Tool>): Todo[] {
  let found: Todo[] = [];
  for (const item of messages) {
    const content = item.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== "toolCall") continue;
      const name = part.name ?? (part.id ? tools[part.id]?.name : "") ?? "";
      if (!isTodoToolName(name)) continue;
      const tool = part.id ? tools[part.id] : undefined;
      if (tool?.isError) continue;
      const todos = todosFromCall(part, tool);
      if (todos) found = todos;
    }
  }
  return found;
}

export function sessionTodoKey(messages: readonly DisplayMessage[], tools: Record<string, Tool>) {
  return latestTodos(messages, tools).map((todo) => `${todo.status}:${todo.content}`).join("\n");
}

export function parseTodoKey(key: string): Todo[] {
  if (!key) return [];
  return key.split("\n").flatMap((line) => {
    const split = line.indexOf(":");
    if (split < 0) return [];
    const status = asStatus(line.slice(0, split));
    const content = line.slice(split + 1);
    return content ? [{ content, status }] : [];
  });
}

export function formatTaskDuration(elapsedMs: number | null | undefined) {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs < 500) return null;
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
