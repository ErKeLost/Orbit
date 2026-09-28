import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { modelFamily, modelLabel } from "../../lib/model-meta";
import { persistDefaultModel, report, request } from "../../lib/rpc";
import type { Model, RpcSessionState } from "../../lib/protocol";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ModelLogo } from "../ModelMeta";
import { Skeleton } from "../UI";
import { Icon } from "../Icon";
import { EffortSlider } from "./EffortSlider";

const compactNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const emptyModels: Model[] = [];
type ThinkingLevel = NonNullable<RpcSessionState["thinkingLevel"]>;

function composerModelLabel(id: string, fallback?: string) {
  return modelLabel(id, fallback).replace(/^gpt-/i, "").replace(/[-_]+/g, " ").replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function effortLabel(level?: string) {
  if (!level || level === "off") return "Off";
  return level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1);
}

function ModelRow({ model, active, onSelect }: { model: Model; active: boolean; onSelect: () => void }) {
  return <button type="button" className={`composer-model-row ${active ? "active" : ""}`} aria-pressed={active} onClick={onSelect}>
    <ModelLogo modelId={model.id} size={15} />
    <span className="composer-model-row-copy">
      <strong>{composerModelLabel(model.id, model.name)}</strong>
      {model.contextWindow > 0 && <small>{compactNumber.format(model.contextWindow)} context window</small>}
    </span>
    {active && <Icon name="check" className="composer-model-check" />}
  </button>;
}

function ComposerModelSelectorImpl() {
  const project = useWorkspace(state => state.cwd);
  const online = useWorkspace(state => state.connection === "online");
  const streaming = useWorkspace(state => state.transcript.running);
  const state = useWorkspace(workspace => workspace.state);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const models = useQuery({ queryKey: ["pi", "models", project], queryFn: () => request<{ models: Model[] }>({ type: "get_available_models" }, 30000, project), enabled: online });
  const levels = useQuery({ queryKey: ["pi", "levels", project, state?.model?.provider, state?.model?.id], queryFn: () => request<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }, 30000, project), enabled: online });
  const allModels = models.data?.models ?? emptyModels;
  const activeProvider = state?.model?.provider;
  const providerModels = useMemo(() => activeProvider ? allModels.filter(model => model.provider === activeProvider) : emptyModels, [activeProvider, allModels]);
  const families = useMemo(() => [...new Set(providerModels.map(model => modelFamily(model.id)))], [providerModels]);
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = providerModels.filter(model => !query || `${model.name ?? ""} ${model.id}`.toLowerCase().includes(query));
    return families.flatMap(family => {
      const items = visible.filter(model => modelFamily(model.id) === family);
      return items.length ? [{ family, items }] : [];
    });
  }, [families, providerModels, search]);
  const availableLevels = levels.data?.levels ?? [];

  async function choose(command: Parameters<typeof request>[0]) {
    try {
      await request(command, 30000, project);
      const next = await request<typeof state>({ type: "get_state" }, 30000, project);
      if (command.type === "set_model") {
        if (next?.model?.provider !== command.provider || next.model.id !== command.modelId) throw new Error("Pi 没有确认模型切换");
        await persistDefaultModel(command.provider, command.modelId);
      }
      useWorkspace.getState().set({ state: next });
    } catch (error) { report(error); }
  }

  if (models.isLoading) return <div className="composer-selectors"><span className="studio-model-loading" aria-busy="true"><Skeleton className="studio-model-loading-icon" /><Skeleton className="studio-model-loading-label" /></span></div>;
  return <div className="composer-selectors"><Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch(""); }}>
    <PopoverTrigger render={<button type="button" className="composer-model-control" disabled={!online || streaming} aria-label="选择模型和思考强度" />}>
      {state?.model && <ModelLogo modelId={state.model.id} size={18} />}
      <span>{state?.model ? composerModelLabel(state.model.id, state.model.name) : "选择模型"}</span>
      {availableLevels.some(level => level !== "off") && <><i aria-hidden>·</i><small>{effortLabel(state?.thinkingLevel)}</small></>}
      <Icon name="caret-down" />
    </PopoverTrigger>
    <PopoverContent side="top" align="start" sideOffset={10} className="composer-model-menu">
      <label className="composer-model-search"><Icon name="magnifying-glass" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索模型" /></label>
      <div className="composer-model-groups">
        {groups.map(group => <section className="composer-model-group" key={group.family}>
          <h3>{group.family}</h3>
          {group.items.map(model => <ModelRow key={`${model.provider}/${model.id}`} model={model} active={state?.model?.provider === model.provider && state.model.id === model.id} onSelect={() => void choose({ type: "set_model", provider: model.provider, modelId: model.id })} />)}
        </section>)}
        {groups.length === 0 && <p className="composer-model-empty">没有匹配的模型</p>}
      </div>
      {availableLevels.length > 1 && <div className="composer-effort-footer"><EffortSlider key={`${state?.model?.provider}/${state?.model?.id}/${availableLevels.join(",")}`} levels={availableLevels} value={state?.thinkingLevel} disabled={streaming} onChange={level => void choose({ type: "set_thinking_level", level })} /></div>}
    </PopoverContent>
  </Popover></div>;
}

export const ComposerModelSelector = memo(ComposerModelSelectorImpl);
