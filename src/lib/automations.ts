import { invoke } from "./native";
import { listen } from "@tauri-apps/api/event";

/** Automation types and commands. The JSON shape matches the Rust store. */
export type AutomationScheduleKind = "hourly" | "daily" | "weekdays" | "weekly";
export type AutomationTriggerKind = "time" | "github" | "gitlab";
export type AutomationRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type AutomationRuntimeMode = "supervised" | "auto-accept-edits" | "auto" | "full-access";
export type AutomationWorkspaceMode = "current" | "worktree" | "existing";

export type AutomationTrigger = {
  id: string;
  kind: AutomationTriggerKind;
  event: string;
  scheduleKind: AutomationScheduleKind;
  minute: number;
  time: string;
  dayOfWeek: number;
  repos: string[];
  repo: string;
  branch: string;
  actor: string;
};

export type Automation = {
  id: string;
  name: string;
  prompt: string;
  harness: string;
  model: string;
  modelSettings: Record<string, string>;
  cwd: string;
  workspaceMode: AutomationWorkspaceMode;
  worktreeCwd: string;
  sessionFolderId: string;
  reuseSession: boolean;
  runtimeMode: AutomationRuntimeMode;
  triggerKind: AutomationTriggerKind;
  triggerEvent: string;
  scheduleKind: AutomationScheduleKind;
  minute: number;
  time: string;
  dayOfWeek: number;
  triggers?: AutomationTrigger[];
  missedRunGraceMinutes: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunStatus?: AutomationRunStatus;
  lastRunError?: string;
  lastSessionId?: string;
  createdAt: number;
  updatedAt: number;
};

export type AutomationUpsert = Omit<Automation, "createdAt" | "updatedAt" | "lastRunAt" | "lastRunStatus" | "lastRunError" | "lastSessionId">;

export type AutomationRun = {
  id: string;
  automationId: string;
  trigger: string;
  scheduledFor: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: AutomationRunStatus;
  sessionId?: string;
  error?: string;
  eventKey?: string;
  eventKind?: string;
  event?: string;
  prompt?: string;
};

export type DueAutomationRun = { automation: Automation; run: AutomationRun };

export const AUTOMATIONS_CHANGED_EVENT = "orbit:automations-changed";

export const automationsList = () => invoke<Automation[]>("automations_list");
export const automationsUpsert = (input: AutomationUpsert, now = Date.now()) => invoke<Automation>("automations_upsert", { input, now });
export const automationsDelete = (automationId: string) => invoke<void>("automations_delete", { automationId });
export const automationRunsList = (automationId: string, limit?: number) => invoke<AutomationRun[]>("automation_runs_list", { automationId, limit: limit ?? null });
export const automationRunsRecover = (now = Date.now()) => invoke<number>("automation_runs_recover", { now });
export const automationRunNow = (automationId: string, now = Date.now()) => invoke<AutomationRun>("automation_run_now", { automationId, now });
export const automationsClaimDue = (automationId: string, expectedNextRunAt: number, nextRunAt: number, now = Date.now()) =>
  invoke<DueAutomationRun | null>("automations_claim_due", { automationId, expectedNextRunAt, nextRunAt, now });
export const automationRunUpdate = (runId: string, status: AutomationRunStatus, sessionId?: string | null, error?: string | null, now = Date.now()) =>
  invoke<AutomationRun>("automation_run_update", { runId, status, sessionId: sessionId ?? null, error: error ?? null, now });

export const RUN_STATUS_LABEL: Record<AutomationRunStatus, string> = {
  pending: "等待中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

export const RUNTIME_MODE_LABEL: Record<AutomationRuntimeMode, string> = {
  supervised: "监督模式",
  "auto-accept-edits": "自动接受编辑",
  auto: "自动",
  "full-access": "完全访问",
};

export function subscribeAutomations(onChange: () => void) {
  return listen(AUTOMATIONS_CHANGED_EVENT, onChange);
}

/* ---------------------------------------------------------------- schedule */

export const AUTOMATION_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function parseTime(value: string): [number, number] {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(hour) ? clamp(hour, 0, 23) : 9, Number.isFinite(minute) ? clamp(minute, 0, 59) : 0];
}

export function formatClock(value: string): string {
  const [hour, minute] = parseTime(value);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** MonoCode's `nextAutomationRunAt`, verbatim. */
export function nextAutomationRunAt(
  schedule: Pick<Automation, "scheduleKind" | "minute" | "time" | "dayOfWeek">,
  after = Date.now(),
): number {
  const start = new Date(after);
  start.setSeconds(0, 0);
  const [hour, minute] = parseTime(schedule.time);
  if (schedule.scheduleKind === "hourly") {
    const candidate = new Date(start);
    candidate.setMinutes(clamp(schedule.minute, 0, 59), 0, 0);
    if (candidate.getTime() <= after) candidate.setHours(candidate.getHours() + 1);
    return candidate.getTime();
  }
  const candidate = new Date(start);
  candidate.setHours(hour, minute, 0, 0);
  if (schedule.scheduleKind === "daily") {
    if (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  if (schedule.scheduleKind === "weekdays") {
    if (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + 1);
    while (candidate.getDay() === 0 || candidate.getDay() === 6) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  const day = clamp(schedule.dayOfWeek, 0, 6);
  let days = (day - candidate.getDay() + 7) % 7;
  if (days === 0 && candidate.getTime() <= after) days = 7;
  candidate.setDate(candidate.getDate() + days);
  return candidate.getTime();
}

export function automationScheduleLabel(automation: Pick<Automation, "scheduleKind" | "minute" | "time" | "dayOfWeek">): string {
  const time = formatClock(automation.time);
  if (automation.scheduleKind === "hourly") return `每小时 :${String(automation.minute).padStart(2, "0")}`;
  if (automation.scheduleKind === "daily") return `每天 ${time}`;
  if (automation.scheduleKind === "weekdays") return `工作日 ${time}`;
  return `${AUTOMATION_WEEKDAYS[automation.dayOfWeek] ?? "每周"} ${time}`;
}

export function nextRunPreview(at: number): string {
  const date = new Date(at);
  const day = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `下次运行：${day} ${time}`;
}

/** Relative "in 3 hours" style label for a run timestamp. */
export function relativeFromNow(at: number, now = Date.now()): string {
  const delta = at - now;
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 1) return "刚刚";
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
