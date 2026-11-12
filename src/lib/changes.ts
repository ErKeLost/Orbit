import { toolKind } from "./tool-activity";

export const MAX_CODE_PREVIEW_CHARS = 40_000;
const MAX_CODE_PREVIEW_LINES = 1_500;

type ChangeBase = { name: string; label?: string | false };
export type Change =
  | ChangeBase & { kind: "patch"; patch: string }
  | ChangeBase & { kind: "snippet"; before: string; after: string }
  | ChangeBase & { kind: "file"; contents: string };

export type ToolCodePresentation = { request?: Change; result?: Change };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(input: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function withinPreviewLimit(value: string) {
  if (!value || value.length > MAX_CODE_PREVIEW_CHARS) return false;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10 && ++lines > MAX_CODE_PREVIEW_LINES) return false;
  }
  return true;
}

function patchFromOutput(value: string) {
  const gitStart = value.search(/^diff --git /m);
  const headerStart = value.search(/^--- .+\n\+\+\+ .+/m);
  const start = gitStart >= 0 ? gitStart : headerStart;
  if (start < 0) return "";
  const patch = value.slice(start).trim();
  return withinPreviewLimit(patch) && /^((diff --git )|(--- .+\n\+\+\+ .+))/m.test(patch) ? patch : "";
}

function singleEdit(input: Record<string, unknown>) {
  if (typeof input.oldText === "string" && typeof input.newText === "string") return { before: input.oldText, after: input.newText };
  if (!Array.isArray(input.edits) || input.edits.length !== 1) return null;
  const edit = object(input.edits[0]);
  return typeof edit.oldText === "string" && typeof edit.newText === "string" ? { before: edit.oldText, after: edit.newText } : null;
}

function resultDetails(result: unknown) {
  const record = object(result);
  return "details" in record ? object(record.details) : record;
}

export function getChange(toolName: string, args: unknown, result: unknown): Change | null {
  const input = object(args);
  const details = resultDetails(result);
  const name = text(input, ["path", "filePath", "file", "filename"]) || "修改文件";
  const patch = text(details, ["patch"]);
  if (withinPreviewLimit(patch)) return { kind: "patch", patch, name };

  const requestedPatch = patchFromOutput(text(input, ["patch", "unifiedDiff"]));
  if (requestedPatch) return { kind: "patch", patch: requestedPatch, name };

  const normalized = toolName.toLowerCase();
  if (/(^|[_-])edit([_-]|$)|^edit$/.test(normalized)) {
    const edit = singleEdit(input);
    if (edit && withinPreviewLimit(edit.before) && withinPreviewLimit(edit.after)) return { kind: "snippet", ...edit, name };
  }
  if (/(^|[_-])write([_-]|$)|^write$/.test(normalized)) {
    const contents = text(input, ["content", "contents"]);
    if (withinPreviewLimit(contents)) return { kind: "snippet", before: "", after: contents, name, label: "写入内容（全部新增）" };
  }
  return null;
}

function mix(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33 + value.charCodeAt(index)) | 0;
  return hash;
}

function changeStamp(toolName: string, args: unknown, result: unknown) {
  const input = object(args);
  const details = resultDetails(result);
  return [
    toolName,
    mix(text(details, ["patch"])),
    mix(text(input, ["patch", "unifiedDiff"])),
    mix(text(input, ["content", "contents"])),
    mix(typeof input.oldText === "string" ? input.oldText : ""),
    mix(typeof input.newText === "string" ? input.newText : ""),
  ].join(":");
}

type CachedChange = { stamp: string; change: Change | null };
const changeCache = new Map<string, CachedChange>();

type ChangeMessage = { message?: { content?: unknown } };
type ChangeTool = { details?: unknown };

/** Reuse a parsed change until that tool call's patch or write actually changes. */
export function collectChanges(messages: ChangeMessage[], tools: Record<string, ChangeTool | undefined>) {
  const seen = new Set<string>();
  const changes: { id: string; change: Change }[] = [];
  for (const item of messages) {
    const content = item.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || (part as { type?: string }).type !== "toolCall") continue;
      const call = part as { id?: string; name?: string; arguments?: unknown };
      const id = call.id ?? "";
      if (!id) continue;
      const tool = tools[id];
      const stamp = changeStamp(call.name ?? "", call.arguments, tool?.details);
      let cached = changeCache.get(id);
      if (!cached || cached.stamp !== stamp) {
        cached = { stamp, change: getChange(call.name ?? "", call.arguments, tool?.details) };
        changeCache.set(id, cached);
      }
      seen.add(id);
      if (cached.change) changes.push({ id, change: cached.change });
    }
  }
  if (changeCache.size > seen.size) {
    for (const id of changeCache.keys()) if (!seen.has(id)) changeCache.delete(id);
  }
  return changes;
}

function isImagePath(path: string) {
  return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(path);
}

export function getToolCodePresentation(toolName: string, args: unknown, result: string, details?: unknown): ToolCodePresentation {
  const input = object(args);
  const kind = toolKind(toolName);

  if (kind === "edit") {
    const change = getChange(toolName, input, details);
    return change ? { result: change } : {};
  }

  if (kind === "read") {
    const name = text(input, ["path", "filePath", "file", "filename"]);
    if (!name || isImagePath(name) || !withinPreviewLimit(result)) return {};
    return { result: { kind: "file", contents: result, name, label: false } };
  }

  if (kind === "command") {
    const command = text(input, ["command", "cmd", "script", "input"]);
    const request = withinPreviewLimit(command) ? { kind: "file" as const, contents: command, name: "command.sh", label: "命令" } : undefined;
    if (!withinPreviewLimit(result)) return { request };
    const patch = patchFromOutput(result);
    const output = patch
      ? { kind: "patch" as const, patch, name: "command-output.diff", label: "结果" }
      : { kind: "file" as const, contents: result, name: "terminal-output.log", label: "结果" };
    return { request, result: output };
  }

  return {};
}
