import { useId, useMemo, useState, type ReactNode } from "react";
import { FileIcon, Icon } from "../Icon";
import { Button } from "@/components/ui/button";
import { CodeChange } from "../CodeChange";
import { getToolCodePresentation } from "../../lib/changes";
import { summarizeToolCalls, toolKind, type ToolKind } from "../../lib/tool-activity";
import { StableShimmer } from "./stable-shimmer";
import "./tool-call.css";

type JsonRecord = Record<string, unknown>;
const MAX_PLAIN_DETAIL_CHARS = 20_000;

const toolKinds: Record<ToolKind, { label: string; icon: string }> = {
  read: { label: "读取", icon: "book-open" },
  search: { label: "搜索", icon: "magnifying-glass" },
  command: { label: "运行", icon: "terminal-window" },
  edit: { label: "编辑", icon: "pencil-simple" },
  computer: { label: "电脑操作", icon: "cpu" },
  other: { label: "调用", icon: "wrench" },
};

function parseArguments(request: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(request);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function firstText(input: JsonRecord | null, fields: string[]) {
  for (const field of fields) {
    const value = input?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function displayTarget(kind: ToolKind, request: string) {
  const args = parseArguments(request);
  const fields = kind === "computer"
    ? ["goal", "app", "url", "target"]
    : kind === "command"
    ? ["command", "cmd", "script", "input"]
    : kind === "search"
      ? ["query", "pattern", "path", "glob", "input"]
      : ["path", "filePath", "file", "filename", "target", "url", "input"];
  const target = firstText(args, fields) || (args ? "" : request.trim());
  return target.replace(/\s+/g, " ").slice(0, 180);
}

function patchCounts(value: string) {
  const lines = value.split("\n");
  const additions = lines.filter(line => /^\+(?!\+\+)/.test(line)).length;
  const deletions = lines.filter(line => /^-(?!---)/.test(line)).length;
  return additions || deletions ? { additions, deletions } : null;
}

function editCounts(request: string, result: string, details?: unknown) {
  const args = parseArguments(request);
  const patch = firstText(args, ["patch", "diff", "unifiedDiff"]);
  const detailPatch = details && typeof details === "object" && !Array.isArray(details) ? firstText(details as JsonRecord, ["patch"]) : "";
  return patchCounts(detailPatch) ?? patchCounts(patch) ?? patchCounts(request) ?? patchCounts(result);
}

function renderedRequest(request: string) {
  const args = parseArguments(request);
  const value = args ? JSON.stringify(args, null, 2) : request;
  return value.length <= MAX_PLAIN_DETAIL_CHARS ? value : `${value.slice(0, MAX_PLAIN_DETAIL_CHARS)}\n\n[请求过长，已省略]`;
}

export function ToolActivityGroup({ toolNames, running, hasError = false, defaultOpen = false, children }: { toolNames: string[]; running: boolean; hasError?: boolean; defaultOpen?: boolean; children: ReactNode }) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const listId = useId();
  const summary = summarizeToolCalls(toolNames) || "工具调用";
  const open = openOverride ?? (hasError || defaultOpen);
  return <section className="tool-activity-group" data-open={open} data-error={hasError || undefined}>
    <Button type="button" variant="ghost" className="tool-activity-group-header" aria-expanded={open} aria-controls={listId} onClick={() => setOpenOverride(!open)}>
      <Icon name={hasError ? "warning-circle" : "code"} aria-hidden="true" />{running ? <StableShimmer text={summary} className="tool-activity-group-summary" /> : <span className="tool-activity-group-summary">{summary}</span>}<Icon name="caret-right" className="tool-activity-group-chevron" aria-hidden="true" />
    </Button>
    <div id={listId} className="tool-activity-list" aria-hidden={!open} inert={!open}><div className="tool-activity-list-inner">{children}</div></div>
  </section>;
}

export function ToolCall({ toolName, request, result, details, usage, running, open: controlledOpen, onOpenChange, className = '' }: { toolName: string; request: string; result: string; details?: unknown; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } }; running: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const detailsId = useId();
  const kind = toolKind(toolName);
  const presentation = toolKinds[kind];
  const target = displayTarget(kind, request);
  const changes = kind === "edit" ? editCounts(request, result, details) : null;
  const code = useMemo(() => getToolCodePresentation(toolName, parseArguments(request), result, details), [details, request, result, toolName]);
  const codeResult = running ? undefined : code.result;
  const showPlainRequest = !code.request && !((kind === "read" || kind === "edit") && codeResult);
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };

  return <div className={`ai-tool-call tool-activity-item ${className}`} data-running={running} data-open={open}>
    <Button type="button" variant="ghost" className="tool-activity-row" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
      <Icon name={presentation.icon} className="tool-activity-icon" aria-hidden="true" /><span className="tool-activity-action">{presentation.label}</span>{target && (kind === "read" || kind === "edit") && <FileIcon path={target} className="tool-activity-file-icon" />}{target && <code className="tool-activity-target" title={target}>{target}</code>}{changes && <span className="tool-activity-changes"><b>+{changes.additions}</b><i>-{changes.deletions}</i></span>}{running && <span className="tool-activity-running" aria-live="polite">运行中</span>}<Icon name="caret-right" className="tool-activity-chevron" aria-hidden="true" />
    </Button>
    <div id={detailsId} className="tool-activity-details" aria-hidden={!open} inert={!open}><div className="tool-activity-details-inner">
      {open && code.request && <CodeChange change={code.request} compact />}
      {open && showPlainRequest && <section className="tool-detail-plain"><small>请求</small><pre>{renderedRequest(request)}</pre></section>}
      {open && codeResult && <CodeChange change={codeResult} compact />}
      {open && codeResult && kind === "edit" && result && <p className="tool-code-status">{result}</p>}
      {open && !codeResult && (result || !running) && <section className="tool-detail-plain"><small>结果</small><pre>{result || "未返回输出"}</pre></section>}
      {usage && <div className="tool-usage"><small>工具关联用量</small><span>{usage.totalTokens.toLocaleString()} tokens</span>{usage.cost?.total != null && <span>${usage.cost.total.toFixed(4)}</span>}</div>}
    </div></div>
  </div>;
}
