import { memo, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { modelLabel } from "../../lib/model-meta";
import { expectModel, getModelEffort, persistDefaultModel, probeModelEffort, refresh, report, request, settleModel } from "../../lib/rpc";
import type { Model, RpcSessionState } from "../../lib/protocol";
import { Popover } from "../../shared/ui/Popover";
import { Check, ChevronDown, Search } from "../../shared/ui/icons";
import { ModelLogo } from "../../components/ModelMeta";
import { EffortSlider } from "../../components/chat/EffortSlider";
import { effortLabel } from "../../components/chat/effort-slider-model";
import { useSessionTarget } from "../shell/use-session-target";

type ThinkingLevel = NonNullable<RpcSessionState["thinkingLevel"]>;
type EffortLevels = { levels: ThinkingLevel[] };
const offOnly: ThinkingLevel[] = ["off"];
const effortCommand = "gui-effort-apply";
const modelIdentity = (model?: Model) => [model?.provider, model?.id, model?.api, model?.baseUrl];
const sameModel = (left?: Model, right?: Model) => !!left && !!right &&
  left.provider === right.provider && left.id === right.id && left.api === right.api && left.baseUrl === right.baseUrl;

const compactNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const emptyModels: Model[] = [];

export function composerModelLabel(id: string, fallback?: string) {
  return modelLabel(id, fallback).replace(/^gpt-/i, "GPT-").replace(/[_]+/g, " ");
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
  // 模型切换必须发到**这个面板自己的连接**：同一个项目可以有好几条会话连接，
  // 只用 cwd 会被 `route(cwd)` 解析成 projectActive[cwd]（可能是后台那条），
  // 结果前台面板的模型没变——就是那个「点了没反应」。
  const target = useSessionTarget();
  const online = useWorkspace((state) => state.connection === "online");
  const streaming = useWorkspace(({ transcript }) => transcript.running || transcript.submitted || transcript.compacting);
  const state = useWorkspace((workspace) => workspace.state);
  const desktop = useWorkspace((workspace) => workspace.runtimeTarget === "desktop");
  const current = state?.model;
  const queryClient = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const models = useQuery({
    queryKey: ["pi", "models", project, target],
    queryFn: () => request<{ models: Model[] }>({ type: "get_available_models" }, 30000, target),
    enabled: online,
  });
  const effortKey = ["model-effort", ...modelIdentity(current)];
  const effort = useQuery({
    queryKey: effortKey,
    queryFn: async () => {
      if (!current) return { eligible: false };
      const cached = await getModelEffort(current);
      return cached.eligible && cached.levels === undefined ? probeModelEffort(current) : cached;
    },
    enabled: open && online && desktop && current?.api === "openai-responses",
    staleTime: Infinity,
    retry: false,
  });
  const cachedLevels = effort.data?.levels;
  const expectedLevels = cachedLevels?.length === 0 ? offOnly : cachedLevels;
  const sessionId = state?.sessionId;
  const levels = useQuery({
    queryKey: ["pi", "levels", project, target, sessionId, ...modelIdentity(current), expectedLevels],
    enabled: online && !!current && !streaming,
    queryFn: async () => {
      const available = await request<EffortLevels>({ type: "get_available_thinking_levels" }, 30000, target);
      if (!expectedLevels || available.levels.join() === expectedLevels.join()) return available;

      const { commands } = await request<{ commands: { name: string; source: string }[] }>({ type: "get_commands" }, 30000, target);
      if (!commands.some(({ name, source }) => name === effortCommand && source === "extension")) {
        throw new Error("当前 Pi 会话无法同步 Effort 档位");
      }
      const live = await request<RpcSessionState>({ type: "get_state" }, 30000, target);
      if (!sameModel(live.model, current) || live.sessionId !== sessionId || live.isStreaming || live.isCompacting || live.pendingMessageCount) {
        throw new Error("当前会话忙碌或模型已切换，暂时无法同步 Effort 档位");
      }
      const { provider, id, api, baseUrl } = current!;
      await request({ type: "prompt", message: `/${effortCommand} ${JSON.stringify({ provider, id, api, baseUrl, sessionId })}` }, 30000, target);
      const confirmed = await request<EffortLevels>({ type: "get_available_thinking_levels" }, 30000, target);
      const next = await refresh(target);
      if (!sameModel(next.model, current) || next.sessionId !== sessionId || confirmed.levels.join() !== expectedLevels.join()) {
        throw new Error("Pi 未确认 Effort 档位，请重试");
      }
      return confirmed;
    },
  });
  const detection = useMutation({
    mutationFn: (model: Model) => probeModelEffort(model),
    onSuccess: (result, model) => queryClient.setQueryData(["model-effort", ...modelIdentity(model)], result),
  });
  const changingLevel = useMutation({
    mutationFn: async (level: ThinkingLevel) => {
      await request({ type: "set_thinking_level", level }, 30000, target);
      const next = await refresh(target);
      if (next.thinkingLevel !== level) {
        throw new Error(`Pi 未接受 ${effortLabel(level)}，当前档位为 ${effortLabel(next.thinkingLevel)}`);
      }
    },
    onError: (error) => report(new Error(`设置 Effort 失败：${error.message}`)),
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
    // When there is no active provider at all — a worker that reported no model
    // (Pi's `get_state.model` is optional) or a model this catalog never listed —
    // filtering by it would show an empty menu and read as 「模型加载不出来」.
    // The catalog is still the right answer there: list everything.
    const pool = query || providerModels.length === 0 ? allModels : providerModels;
    const visible = pool.filter((model) => !query || `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase().includes(query));
    const byProvider = new Map<string, Model[]>();
    for (const model of visible) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
    return [...byProvider.entries()].map(([family, items]) => ({ family, items }));
  }, [allModels, providerModels, search]);
  const dismiss = () => {
    setOpen(false);
    setSearch("");
  };

  async function chooseModel(model: Model) {
    const previous = useWorkspace.getState().state;
    expectModel(target, { provider: model.provider, id: model.id });
    try {
      await request({ type: "set_model", provider: model.provider, modelId: model.id }, 30000, target);
      const next = await request<RpcSessionState>({ type: "get_state" }, 30000, target);
      settleModel(target, next);
      if (next.model?.provider !== model.provider || next.model.id !== model.id) {
        report(new Error("Pi 没有确认模型切换"));
        return;
      }
    } catch (error) {
      settleModel(target, previous ?? undefined);
      report(error);
      return;
    }
    try {
      await persistDefaultModel(model.provider, model.id);
    } catch (error) {
      report(error);
    }
  }

  const label = current ? composerModelLabel(current.id, current.name) : models.isLoading ? "Loading…" : "选择模型";
  const availableLevels = levels.data?.levels;
  const namedLevels = cachedLevels ?? availableLevels ?? [];
  const showEffort = namedLevels.some((level) => level !== "off") || cachedLevels?.length === 1;
  const probing = effort.isFetching || (sameModel(detection.variables, current) && detection.isPending);
  const effortError = levels.error ?? effort.error ?? (sameModel(detection.variables, current) ? detection.error : null);
  const effortDisabled = !online || streaming || !availableLevels || probing || changingLevel.isPending;
  const showSlider = showEffort && !cachedLevels && namedLevels.length > 1;
  const showEffortStatus = !showSlider || effort.data?.eligible || effortError;
  const effortStatus = probing ? "正在查询 Effort 档位…"
    : cachedLevels && levels.isFetching && !availableLevels ? "正在同步档位…"
    : cachedLevels?.length === 0 ? "此接口不支持 Effort 参数"
    : showEffort ? "Effort"
    : "未发现 Effort 档位";

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
        onClick={() => {
          if (open) {
            dismiss();
            return;
          }
          // A catalog fetched while the worker was still starting (or across a
          // reconnect) stays failed until something asks again; the menu is the
          // one place the user can ask.
          if (models.isError || allModels.length === 0) void models.refetch();
          setOpen(true);
        }}
        className={`flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 disabled:opacity-40 ${
          open ? "bg-selection text-ink-1" : "bg-selection text-ink-1 hover:bg-selection-hover"
        }`}
      >
        {current ? <ModelLogo modelId={current.id} size={16} /> : null}
        <span className="whitespace-nowrap text-2xs">{label}</span>
        {showEffort ? <span className="shrink-0 text-2xs text-ink-3">{effortLabel(state?.thinkingLevel)}</span> : null}
        <ChevronDown className={`size-3 shrink-0 text-ink-3 ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
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
                    onSelect={() => {
                      // Close the picker while the session confirms the model switch.
                      dismiss();
                      void chooseModel(model);
                    }}
                  />
                ))}
              </section>
            ))}
            {groups.length === 0 ? (
              <p className={`composer-model-empty ${models.isError ? "composer-model-error" : ""}`}>
                {search.trim()
                  ? `没有匹配“${search.trim()}”的模型`
                  : models.isError
                    ? `模型目录没有取到：${models.error instanceof Error ? models.error.message : String(models.error)}`
                    : models.isFetching
                      ? "正在从 Pi 读取模型目录…"
                      : "Pi 还没有报告任何可用模型"}
                {!search.trim() && (models.isError || allModels.length === 0) ? (
                  <button type="button" className="composer-model-retry" onClick={() => void models.refetch()}>重试</button>
                ) : null}
              </p>
            ) : null}
          </div>
          {current && (showEffort || probing || effort.data?.eligible || effortError) ? (
            <div className="composer-effort-footer">
              {showSlider ? (
                <EffortSlider
                  key={`${current.provider}/${current.id}/${namedLevels.join(",")}/${changingLevel.isError}`}
                  levels={namedLevels}
                  value={state?.thinkingLevel}
                  disabled={effortDisabled}
                  onChange={changingLevel.mutate}
                />
              ) : null}
              {showEffortStatus ? (
                <div className="flex items-center justify-between gap-2 text-2xs text-ink-3">
                  <span aria-live="polite">{effortStatus}</span>
                  {levels.isError || effort.isError ? (
                    <button type="button" className="composer-model-retry" disabled={streaming} onClick={() => void (levels.isError ? levels.refetch() : effort.refetch())}>重试</button>
                  ) : effort.data?.eligible ? (
                    <button type="button" className="composer-model-retry" disabled={streaming || probing} onClick={() => detection.mutate(current)}>
                      重新查询
                    </button>
                  ) : null}
                </div>
              ) : null}
              {showEffort ? (
                <div className="composer-effort-options" role="group" aria-label="Effort 档位">
                  {namedLevels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={state?.thinkingLevel === level}
                      disabled={effortDisabled}
                      onClick={() => { if (state?.thinkingLevel !== level) changingLevel.mutate(level); }}
                    >{effortLabel(level)}</button>
                  ))}
                </div>
              ) : null}
              {effortError ? <p role="alert" className="composer-model-error mt-1 text-2xs">{effortError instanceof Error ? effortError.message : String(effortError)}</p> : null}
            </div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

export const ModelPicker = memo(ModelPickerImpl);
