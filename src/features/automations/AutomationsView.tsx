import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { useProjects } from "../../lib/projects";
import { report } from "../../lib/rpc";
import {
  AUTOMATION_WEEKDAYS,
  RUNTIME_MODE_LABEL,
  RUN_STATUS_LABEL,
  automationRunsList,
  automationRunNow,
  automationScheduleLabel,
  automationsDelete,
  automationsList,
  automationsUpsert,
  nextAutomationRunAt,
  nextRunPreview,
  relativeFromNow,
  subscribeAutomations,
  type Automation,
  type AutomationRun,
  type AutomationRuntimeMode,
  type AutomationScheduleKind,
  type AutomationUpsert,
} from "../../lib/automations";
import { AUTOMATION_TEMPLATE_CATEGORIES, AUTOMATION_TEMPLATES, type AutomationTemplate } from "./templates";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { Group, Row, SecondaryButton, Select, Slider, TextArea, TextField, Toggle } from "../../shared/ui/controls";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { ProjectInitial } from "../shell/ProjectInitial";
import { toast } from "../../shared/ui/toast";
import {
  AlertCircle,
  Check,
  Clock,
  FilePlus,
  Loader,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2 as Trash,
  Zap,
  type IconComponent,
} from "../../shared/ui/icons";

const TEMPLATE_ICONS: Record<string, IconComponent> = {
  search: Search,
  alert: AlertCircle,
  file: FilePlus,
  check: Check,
  lock: Lock,
  pr: Zap,
  inbox: Clock,
  gauge: Zap,
  terminal: Terminal,
  note: FilePlus,
};

type Draft = {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  scheduleKind: AutomationScheduleKind;
  time: string;
  minute: number;
  dayOfWeek: number;
  runtimeMode: AutomationRuntimeMode;
  enabled: boolean;
};

function draftFromAutomation(automation: Automation): Draft {
  return {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    cwd: automation.cwd,
    scheduleKind: automation.scheduleKind,
    time: automation.time,
    minute: automation.minute,
    dayOfWeek: automation.dayOfWeek,
    runtimeMode: automation.runtimeMode,
    enabled: automation.enabled,
  };
}

function draftFromTemplate(template: AutomationTemplate, cwd: string): Draft {
  return {
    id: crypto.randomUUID(),
    name: template.name,
    prompt: template.prompt,
    cwd,
    scheduleKind: template.trigger.scheduleKind ?? "weekdays",
    time: template.trigger.time ?? "09:00",
    minute: template.trigger.minute ?? 0,
    dayOfWeek: template.trigger.dayOfWeek ?? 1,
    runtimeMode: "supervised",
    enabled: true,
  };
}

function emptyDraft(cwd: string): Draft {
  return {
    id: crypto.randomUUID(),
    name: "",
    prompt: "",
    cwd,
    scheduleKind: "weekdays",
    time: "09:00",
    minute: 0,
    dayOfWeek: 1,
    runtimeMode: "supervised",
    enabled: true,
  };
}

/** MonoCode's Automations screen: list, template gallery, and the editor. */
export function AutomationsView() {
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const { projects } = useProjects();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<(typeof AUTOMATION_TEMPLATE_CATEGORIES)[number]["id"]>("popular");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [history, setHistory] = useState<AutomationRun[]>([]);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();

  const project = workspaceMode === "project" && cwd && cwd !== homeDir ? cwd : "";
  const automations = useQuery({ queryKey: ["automations"], queryFn: automationsList, refetchInterval: 30_000 });
  const items = automations.data ?? [];

  // The Rust store is the single source of truth; it broadcasts every change.
  useEffect(() => {
    const pending = subscribeAutomations(() => void queryClient.invalidateQueries({ queryKey: ["automations"] }));
    return () => {
      void pending.then((off) => off());
    };
  }, [queryClient]);

  const selected = draft ? items.find((item) => item.id === draft.id) : undefined;
  useEffect(() => {
    if (!selected) {
      setHistory([]);
      return;
    }
    let active = true;
    void automationRunsList(selected.id, 20).then(
      (runs) => { if (active) setHistory(runs); },
      () => undefined,
    );
    return () => { active = false; };
  }, [selected?.id, selected?.lastRunAt, selected?.lastRunStatus]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? items.filter((item) => `${item.name} ${item.prompt}`.toLowerCase().includes(needle)) : items;
  }, [filter, items]);

  const templates = useMemo(() => {
    if (category === "popular") return AUTOMATION_TEMPLATES.filter((template) => template.popular);
    return AUTOMATION_TEMPLATES.filter((template) => template.category === category);
  }, [category]);

  const save = async (next: Draft) => {
    if (!next.name.trim() || !next.prompt.trim() || !next.cwd) {
      toast.warning("请填写名称、指令并选择项目");
      return;
    }
    setSaving(true);
    try {
      const input: AutomationUpsert = {
        id: next.id,
        name: next.name.trim(),
        prompt: next.prompt,
        harness: "pi",
        model: "",
        modelSettings: {},
        cwd: next.cwd,
        workspaceMode: "current",
        worktreeCwd: "",
        sessionFolderId: "",
        reuseSession: false,
        runtimeMode: next.runtimeMode,
        triggerKind: "time",
        triggerEvent: "",
        scheduleKind: next.scheduleKind,
        minute: next.minute,
        time: next.time,
        dayOfWeek: next.dayOfWeek,
        missedRunGraceMinutes: 120,
        enabled: next.enabled,
        nextRunAt: nextAutomationRunAt(next),
      };
      const saved = await automationsUpsert(input);
      setDraft(draftFromAutomation({
        ...saved,
        prompt: next.prompt,
        cwd: next.cwd,
        scheduleKind: next.scheduleKind,
        time: next.time,
        minute: next.minute,
        dayOfWeek: next.dayOfWeek,
        runtimeMode: next.runtimeMode,
        enabled: next.enabled,
      }));
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast.success("自动化已保存", { description: automationScheduleLabel(input) });
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (automation: Automation) => {
    try {
      const run = await automationRunNow(automation.id);
      window.dispatchEvent(new CustomEvent("orbit:automation-run", { detail: { automation, run } }));
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast.success("已触发运行", { description: automation.name });
    } catch (error) {
      report(error);
    }
  };

  const remove = async (automation: Automation) => {
    try {
      await automationsDelete(automation.id);
      setDeleting(null);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast.success("自动化已删除");
    } catch (error) {
      report(error);
    }
  };

  return (
    <div role="region" aria-label="Automations" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region>
        <Zap className="size-4 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="text-[13px] font-medium">自动化</span>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* List column */}
        <div className="flex h-full min-h-0 w-[280px] shrink-0 flex-col border-r border-stroke">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
            <div className="relative flex h-7 min-w-0 flex-1 items-center">
              <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter automations"
                aria-label="筛选自动化"
                className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pl-7 pr-2 text-[12px] outline-none placeholder:text-content/35"
              />
            </div>
            <button
              type="button"
              title="新建自动化"
              aria-label="新建自动化"
              onClick={() => setDraft(emptyDraft(project))}
              className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
          <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto overscroll-none p-1.5">
            {visible.length === 0 ? (
              <p className="px-2 py-2 text-[12px] text-content/45">{filter ? "没有匹配的自动化" : "No automations yet"}</p>
            ) : null}
            <div className="flex flex-col gap-0.5">
              {visible.map((item) => {
                const active = draft?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setDraft(draftFromAutomation(item))}
                    className={`flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-left ${
                      active ? "bg-selection text-content" : "text-content/80 hover:bg-content/5 hover:text-content"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="line-clamp-1 min-w-0 flex-1 text-[13px] font-semibold leading-snug">{item.name}</span>
                      {item.enabled ? null : <span className="shrink-0 text-[11px] text-content/40">已暂停</span>}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-content/45">
                      <Clock className="size-3 shrink-0" strokeWidth={1.75} />
                      <span className="min-w-0 truncate">{automationScheduleLabel(item)}</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{relativeFromNow(item.nextRunAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Detail / gallery */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
          <div className="mx-auto w-full max-w-3xl px-6 py-8">
            {!draft ? (
              <>
                <h1 className="text-[20px] font-semibold leading-tight">New automation</h1>
                <p className="mt-1.5 text-[13px] text-content/45">Pick an example or start from scratch.</p>
                <div role="tablist" aria-label="模板分类" className="mt-4 flex flex-wrap items-center gap-1">
                  {AUTOMATION_TEMPLATE_CATEGORIES.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={category === entry.id}
                      onClick={() => setCategory(entry.id)}
                      className={`h-7 rounded-md px-3 text-[12.5px] ${
                        category === entry.id ? "bg-selection text-content" : "text-content/50 hover:text-content"
                      }`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
                <div className="mt-4 grid gap-3 @min-[42rem]:grid-cols-2">
                  {/* MonoCode's cards: icon left, copy right, trigger pinned bottom. */}
                  <button
                    type="button"
                    onClick={() => setDraft(emptyDraft(project))}
                    className="flex h-[164px] flex-col rounded-xl border border-dashed border-content/20 p-4 text-left hover:bg-content/5"
                  >
                    <span className="flex items-start gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-content/6">
                        <Plus className="size-4" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-semibold">Start from scratch</span>
                        <span className="mt-1 block text-[12px] leading-relaxed text-content/45">
                          Write your own instructions and choose a trigger.
                        </span>
                      </span>
                    </span>
                  </button>
                  {templates.map((template) => {
                    const Icon = TEMPLATE_ICONS[template.icon] ?? Zap;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => setDraft(draftFromTemplate(template, project))}
                        className="flex h-[164px] flex-col rounded-xl border border-content/10 p-4 text-left hover:bg-content/5"
                      >
                        <span className="flex items-start gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-content/6">
                            <Icon className="size-4 text-content/60" strokeWidth={1.75} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold">{template.name}</span>
                            <span className="mt-1 line-clamp-3 block text-[12px] leading-relaxed text-content/45">
                              {template.description}
                            </span>
                          </span>
                        </span>
                        <span className="mt-auto flex items-center gap-1.5 text-[11px] text-content/40">
                          <Clock className="size-3 shrink-0" strokeWidth={1.75} />
                          {template.triggerLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <h1 className="min-w-0 flex-1 truncate text-[20px] font-semibold leading-tight">
                    {selected ? selected.name : "New automation"}
                  </h1>
                  {selected ? (
                    <>
                      <SecondaryButton onClick={() => void runNow(selected)}>
                        <Play className="size-3.5" strokeWidth={1.75} />
                        立即运行
                      </SecondaryButton>
                      <SecondaryButton danger onClick={() => setDeleting(selected)}>
                        <Trash className="size-3.5" strokeWidth={1.75} />
                        删除
                      </SecondaryButton>
                    </>
                  ) : null}
                </div>

                <Group title="指令" description="每次触发时作为新会话的第一条消息发送给 Pi。">
                  <div className="px-4 py-3.5">
                    <TextField wide value={draft.name} placeholder="名称" aria-label="名称" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                    <div className="mt-2">
                      <TextArea
                        rows={10}
                        value={draft.prompt}
                        placeholder="例如：检查最近的提交，找出高危正确性问题，并在安全的情况下提交修复。"
                        aria-label="指令"
                        onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                      />
                    </div>
                  </div>
                </Group>

                <Group title="项目" description="自动化在这个项目的当前检出里运行。">
                  <Row label="项目">
                    <Select
                      label="项目"
                      value={draft.cwd}
                      className="max-w-72"
                      options={(projects.length ? projects.map((item) => item.path) : project ? [project] : []).map((path) => ({
                        value: path,
                        label: path.split("/").filter(Boolean).at(-1) ?? path,
                        icon: <ProjectInitial name={path} className="size-3.5 shrink-0" />,
                      }))}
                      onChange={(value) => setDraft({ ...draft, cwd: value })}
                    />
                  </Row>
                </Group>

                <Group title="触发器" description="目前支持按时间运行；GitHub / GitLab 事件触发在收件箱接入后启用。">
                  <Row label="频率">
                    <Select
                      label="频率"
                      value={draft.scheduleKind}
                      options={[
                        { value: "hourly", label: "每小时" },
                        { value: "daily", label: "每天" },
                        { value: "weekdays", label: "工作日" },
                        { value: "weekly", label: "每周" },
                      ]}
                      onChange={(value) => setDraft({ ...draft, scheduleKind: value as AutomationScheduleKind })}
                    />
                  </Row>
                  {draft.scheduleKind === "hourly" ? (
                    <Row label="分钟" description="每小时的第几分钟运行。">
                      <Slider label="分钟" value={draft.minute} display={`:${String(draft.minute).padStart(2, "0")}`} min={0} max={59} onChange={(value) => setDraft({ ...draft, minute: value })} />
                    </Row>
                  ) : (
                    <Row label="时间">
                      <TextField className="!w-32" value={draft.time} aria-label="时间" placeholder="09:00" onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
                    </Row>
                  )}
                  {draft.scheduleKind === "weekly" ? (
                    <Row label="星期">
                      <Select
                        label="星期"
                        value={String(draft.dayOfWeek)}
                        options={AUTOMATION_WEEKDAYS.map((label, index) => ({ value: String(index), label }))}
                        onChange={(value) => setDraft({ ...draft, dayOfWeek: Number(value) })}
                      />
                    </Row>
                  ) : null}
                  <Row label="下次运行">
                    <span className="text-[12px] text-content/55">{nextRunPreview(nextAutomationRunAt(draft))}</span>
                  </Row>
                </Group>

                <Group title="运行方式" description="权限模式沿用会话的设置；运行中不可切换。">
                  <Row label="权限模式">
                    <Select
                      label="权限模式"
                      value={draft.runtimeMode}
                      options={(Object.keys(RUNTIME_MODE_LABEL) as AutomationRuntimeMode[]).map((mode) => ({ value: mode, label: RUNTIME_MODE_LABEL[mode] }))}
                      onChange={(value) => setDraft({ ...draft, runtimeMode: value as AutomationRuntimeMode })}
                    />
                  </Row>
                  <Row label="启用" description="暂停后不会再按计划运行，记录保留。">
                    <Toggle label="启用" on={draft.enabled} onChange={(on) => setDraft({ ...draft, enabled: on })} />
                  </Row>
                </Group>

                {selected && history.length > 0 ? (
                  <Group title={`运行历史 · ${history.length}`} description="最近 20 次运行。">
                    {history.map((run) => (
                      <Row
                        key={run.id}
                        label={
                          <span className="flex items-center gap-2">
                            <span>{RUN_STATUS_LABEL[run.status]}</span>
                            <span className="text-[11px] font-normal text-content/40">
                              {new Date(run.scheduledFor).toLocaleString("zh-CN")}
                            </span>
                          </span>
                        }
                        description={run.error ?? run.trigger === "manual" ? "手动触发" : "按计划触发"}
                      >
                        {run.status === "running" ? <Loader className="size-3.5 animate-spin text-content/40" /> : null}
                      </Row>
                    ))}
                  </Group>
                ) : null}

                <div className="flex justify-end gap-2 pt-6">
                  <SecondaryButton onClick={() => setDraft(null)}>取消</SecondaryButton>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save(draft)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40"
                  >
                    {saving ? <Loader className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2} />}
                    保存
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {deleting ? (
        <ConfirmDialog
          title="删除自动化"
          confirmLabel="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        >
          <p className="font-medium text-content">{deleting.name}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-content/55">运行历史会一并删除，已启动的会话不受影响。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export { RefreshCw };
