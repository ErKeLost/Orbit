import { memo, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { modelLabel } from "../../lib/model-meta";
import { persistDefaultModel, report, request } from "../../lib/rpc";
import type { Model, RpcSessionState } from "../../lib/protocol";
import { Popover } from "../../shared/ui/Popover";
import { Check, ChevronDown, Search } from "../../shared/ui/icons";
import { ModelLogo } from "../../components/ModelMeta";
import { EffortSlider } from "../../components/chat/EffortSlider";

type ThinkingLevel = NonNullable<RpcSessionState["thinkingLevel"]>;

const compactNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const emptyModels: Model[] = [];

export function composerModelLabel(id: string, fallback?: string) {
  return modelLabel(id, fallback).replace(/^gpt-/i, "GPT-").replace(/[_]+/g, " ");
}

export function effortLabel(level?: string) {
  if (!level || level === "off") return "Off";
  return level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1);
}

function ModelRow({ model, active, onSelect }: { model: Model; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`composer-model-row ${active ? "active" : ""}`} aria-pressed={active} onClick={onSelect}>
      <ModelLogo modelId={model.id} size={15} />
      <span className="composer-model-row-copy">
        <strong>{composerModelLabel(model.id, model.name)}</strong>
        {model.contextWindow > 0 && <small>{compactNumber.format(model.contextWindow)} context window</small>}
      </span>
      {active && <Check className="composer-model-check" strokeWidth={1.75} />}
    </button>
  );
}

/**
 * The model / provider / effort menu keeps Orbit's own dropdown: the grouped
 * model list with search and the styled EffortSlider footer. Only the trigger
 * and the popover frame follow Orbit.
 */
function ModelPickerImpl() {
  const project = useWorkspace((state) => state.cwd);
  const online = useWorkspace((state) => state.connection === "online");
  const streaming = useWorkspace((state) => state.transcript.running);
  const state = useWorkspace((workspace) => workspace.state);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const models = useQuery({
    queryKey: ["pi", "models", project],
    queryFn: () => request<{ models: Model[] }>({ type: "get_available_models" }, 30000, project),
    enabled: online,
  });
  const levels = useQuery({
    queryKey: ["pi", "levels", project, state?.model?.provider, state?.model?.id],
    queryFn: () => request<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }, 30000, project),
    enabled: online,
  });
  const allModels = models.data?.models ?? emptyModels;
  const activeProvider = state?.model?.provider;
  const providerModels = useMemo(
    () => (activeProvider ? allModels.filter((model) => model.provider === activeProvider) : emptyModels),
    [activeProvider, allModels],
  );
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    // Searching spans every provider; without a query we stay in the active one.
    const pool = query ? allModels : providerModels;
    const visible = pool.filter((model) => !query || `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase().includes(query));
    const byProvider = new Map<string, Model[]>();
    for (const model of visible) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
    return [...byProvider.entries()].map(([family, items]) => ({ family, items }));
  }, [activeProvider, allModels, providerModels, search]);
  const availableLevels = levels.data?.levels ?? [];

  const dismiss = () => {
    setOpen(false);
    setSearch("");
  };

  async function choose(command: Parameters<typeof request>[0]) {
    // 思考档位先在本地落一次：松开滑块那一刻 composer 上的 pill 就变，
    // RPC 只是去确认；确认失败再回滚。get_state 会把真实状态盖回来。
    const previous = useWorkspace.getState().state;
    if (command.type === "set_thinking_level" && previous) {
      useWorkspace.getState().set({ state: { ...previous, thinkingLevel: command.level } });
    }
    try {
      await request(command, 30000, project);
      const next = await request<typeof state>({ type: "get_state" }, 30000, project);
      if (command.type === "set_model") {
        if (next?.model?.provider !== command.provider || next.model.id !== command.modelId) throw new Error("Pi 没有确认模型切换");
        await persistDefaultModel(command.provider, command.modelId);
      }
      useWorkspace.getState().set({ state: next });
    } catch (error) {
      if (command.type === "set_thinking_level" && previous) useWorkspace.getState().set({ state: previous });
      report(error);
    }
  }

  const current = state?.model;
  const label = current ? composerModelLabel(current.id, current.name) : models.isLoading ? "Loading…" : "选择模型";
  const showEffort = availableLevels.some((level) => level !== "off");

  return (
    <>
      <button
        ref={button}
        type="button"
        data-model-control
        title={current ? `${current.provider} · ${current.id}` : "选择模型"}
        aria-label="选择模型和思考强度"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!online || streaming}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? dismiss() : setOpen(true))}
        className={`flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 disabled:opacity-40 ${
          open ? "bg-selection text-content" : "bg-selection text-content hover:bg-selection-hover"
        }`}
      >
        {current ? <ModelLogo modelId={current.id} size={16} /> : null}
        <span className="whitespace-nowrap text-[11px]">{label}</span>
        {showEffort ? <span className="shrink-0 text-[11px] text-content/50">{effortLabel(state?.thinkingLevel)}</span> : null}
        <ChevronDown className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          anchor={button}
          side="top"
          align="start"
          width={280}
          maxHeight={470}
          autoFocus
          onDismiss={dismiss}
          role="dialog"
          aria-label="选择模型和思考强度"
          tabIndex={-1}
          className="composer-model-menu"
        >
          <label className="composer-model-search">
            <Search strokeWidth={1.75} />
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型" />
          </label>
          <div className="composer-model-groups">
            {groups.map((group) => (
              <section className="composer-model-group" key={group.family}>
                <h3>
                  {group.family}
                  <span className="composer-model-group-count">{group.items.length}</span>
                </h3>
                {group.items.map((model) => (
                  <ModelRow
                    key={`${model.provider}/${model.id}`}
                    model={model}
                    active={state?.model?.provider === model.provider && state.model.id === model.id}
                    onSelect={() => void choose({ type: "set_model", provider: model.provider, modelId: model.id })}
                  />
                ))}
              </section>
            ))}
            {groups.length === 0 ? (
              <p className="composer-model-empty">{search.trim() ? `没有匹配“${search.trim()}”的模型` : "这个 Provider 还没有模型目录"}</p>
            ) : null}
          </div>
          {availableLevels.length > 1 ? (
            <div className="composer-effort-footer">
              <EffortSlider
                key={`${state?.model?.provider}/${state?.model?.id}/${availableLevels.join(",")}`}
                levels={availableLevels}
                value={state?.thinkingLevel}
                disabled={streaming}
                onChange={(level) => void choose({ type: "set_thinking_level", level })}
              />
            </div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

export const ModelPicker = memo(ModelPickerImpl);
