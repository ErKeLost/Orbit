import { useMemo, useReducer, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  listProviderProfiles,
  probeProviderModels,
  saveProvider,
  deleteProvider,
  syncProviderModels,
  queryClient,
  connect,
  disconnect,
  request,
  refresh,
  persistDefaultModel,
  type ProviderModel,
  type ProviderProfile,
} from "../lib/rpc";
import { report } from "../lib/rpc";
import { Button, Input, Select as CompactSelect, Switch, Disclosure } from "./UI";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { useWorkspace } from "../lib/store";
import { ModelLogo, ModelModalities } from "./ModelMeta";
import { formatContextLength, modelDisplayName, modelModalities } from "../lib/model-meta";
import { gooeyToast } from "goey-toast";
import { Icon } from "./Icon";
import { ModelProvider, ProviderIcon } from "@lobehub/icons";
import "../styles/provider-page.css";

const apiTypes = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "azure-openai-responses",
  "mistral-conversations",
] as const;

const presets = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", api: "openai-completions" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
  { id: "anthropic", name: "Anthropic / Claude", baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages" },
] as const;

const knownProviderIcons = new Set<string>(Object.values(ModelProvider));
const providerIconAliases: Record<string, string> = {
  anthropicclaude: "anthropic",
  claude: "anthropic",
  openaiapi: "openai",
  chatgpt: "openai",
  googleai: "google",
  geminiai: "google",
  azureopenai: "azure",
  amazonbedrock: "bedrock",
  awsbedrock: "bedrock",
  togetherai: "together",
  deepseekapi: "deepseek",
  bigmodel: "zhipu",
  zhipuai: "zhipu",
  智谱: "zhipu",
  alibabadashscope: "bailian",
  dashscope: "bailian",
  阿里云: "bailian",
  siliconflow: "siliconcloud",
  硅基流动: "siliconcloud",
  vercel: "vercel",
  volcengine: "volcengine",
  火山引擎: "volcengine",
  arkcode: "volcengine",
  moonshotai: "moonshot",
  kimi: "moonshot",
};
const monochromeProviderIcons = new Set(["anthropic", "openai", "vercel", "vercelaigateway", "moonshot", "ollama"]);

function fallbackProviderMark(id: string, name?: string) {
  const label = (name || id).trim();
  const words = label.match(/[A-Za-z0-9]+|[\u3400-\u9fff]+/g) ?? [];
  const letters = words.length > 1
    ? words.slice(0, 2).map(word => word[0]).join("")
    : (words[0] ?? "P").slice(0, 2);
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return <span className="provider-fallback-mark" data-tone={Math.abs(hash) % 4}>{letters.toUpperCase()}</span>;
}

function ProviderMark({ id, name }: { id: string; name?: string }) {
  const resolve = (value: string) => {
    const key = value.toLowerCase().replace(/[\s._\-/]+/g, "");
    return providerIconAliases[key] ?? (knownProviderIcons.has(key) ? key : null);
  };
  const iconId = resolve(id) ?? resolve(name ?? "");
  return <span className="provider-brand-mark" aria-hidden="true">{iconId
    ? <ProviderIcon provider={iconId} type={monochromeProviderIcons.has(iconId) ? "mono" : "color"} size={19} />
    : fallbackProviderMark(id, name)}</span>;
}

function ProviderFieldLabel({ icon, children }: { icon: string; children: string }) {
  return <span className="provider-field-label"><Icon name={icon} />{children}</span>;
}

const display = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "接口未返回";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "接口返回空数组";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};

const formatPricing = (pricing?: Record<string, number>) => {
  if (!pricing) return undefined;
  const parts = Object.entries(pricing).filter(([, value]) => typeof value === "number");
  return parts.length ? parts.map(([key, value]) => `$${value}/M ${key}`).join(" · ") : undefined;
};

function ModelDetails({ model, onUse, disabled }: { model: ProviderModel; onUse: () => void; disabled: boolean }) {
  const inputs = modelModalities(model, "input");
  const outputs = modelModalities(model, "output");
  return (
    <div className="provider-model-details">
      <dl className="provider-meta-grid">
        <div><dt>ID</dt><dd>{display(model.id)}</dd></div>
        <div><dt>名称</dt><dd>{display(modelDisplayName(model))}</dd></div>
        <div><dt>上下文长度</dt><dd>{display(model.context_window)}</dd></div>
        <div><dt>最大输出</dt><dd>{display(model.max_output_tokens)}</dd></div>
        <div><dt>输入类型</dt><dd>{display(inputs)}</dd></div>
        <div><dt>输出类型</dt><dd>{display(outputs)}</dd></div>
        <div><dt>端点类型</dt><dd>{display(model.raw?.supported_endpoint_types)}</dd></div>
        <div><dt>Thinking / reasoning</dt><dd>{display(model.reasoning)}</dd></div>
        <div><dt>支持参数</dt><dd>{display(model.raw?.supported_parameters)}</dd></div>
        <div><dt>价格（美元 / 百万 tokens）</dt><dd>{formatPricing(model.pricing)}</dd></div>
      </dl>
      <Button variant="outline" className="provider-use-model" disabled={disabled} onClick={onUse}><Icon name="check" />使用此模型</Button>
      <Disclosure title={<span className="provider-disclosure-title"><Icon name="code" />接口原始元数据</span>}>
        <pre className="provider-raw-metadata">{JSON.stringify(model.raw, null, 2)}</pre>
      </Disclosure>
    </div>
  );
}

export function ProviderSettings() {
  const profiles = useQuery({ queryKey: ["provider-profiles"], queryFn: listProviderProfiles, staleTime: 10_000 });
  const initialProfile = profiles.data?.find((profile) => profile.isDefault) ?? profiles.data?.[0];
  return <ProviderSettingsEditor key={initialProfile?.id ?? "new-provider"} profiles={profiles} initialProfile={initialProfile} />;
}

type ProviderFormState = {
  provider: string;
  name: string;
  baseUrl: string;
  modelsUrl: string;
  api: (typeof apiTypes)[number];
  apiKey: string;
  defaultModelId: string;
  authHeader: boolean;
  models: ProviderModel[];
  search: string;
  busy: "save" | "probe" | "use" | null;
};

function initialForm(profile?: ProviderProfile): ProviderFormState {
  return {
    provider: profile?.id ?? "",
    name: profile?.name ?? "",
    baseUrl: profile?.baseUrl ?? "",
    modelsUrl: profile?.modelsUrl ?? "",
    api: (profile?.api as (typeof apiTypes)[number]) || "openai-completions",
    apiKey: "",
    defaultModelId: profile?.defaultModel ?? "",
    authHeader: profile?.authHeader !== false,
    models: profile?.models ?? [],
    search: "",
    busy: null,
  };
}

function ProviderSettingsEditor({ profiles, initialProfile }: { profiles: UseQueryResult<ProviderProfile[]>; initialProfile?: ProviderProfile }) {
  const cwd = useWorkspace((state) => state.cwd);
  const online = useWorkspace((state) => state.connection === "online");
  const running = useWorkspace((state) => state.transcript.running);
  const activeProvider = useWorkspace((state) => state.state?.model?.provider);
  const [form, update] = useReducer((state: ProviderFormState, patch: Partial<ProviderFormState>) => ({ ...state, ...patch }), initialProfile, initialForm);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(initialProfile?.id ?? null);
  const lastSelectedProfileId = useRef<string | null>(initialProfile?.id ?? null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [switchingProviderId, setSwitchingProviderId] = useState<string | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<ProviderProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { provider, name, baseUrl, modelsUrl, api, apiKey, defaultModelId, authHeader, models, search, busy } = form;

  const selected = profiles.data?.find((item) => item.id === editingProfileId);
  const mergeConfiguredModels = (catalog: ProviderModel[]) => {
    const configured = new Map((selected?.models ?? []).map(model => [model.id, model]));
    return catalog.map(model => ({ ...configured.get(model.id), ...model }));
  };
  const providerConflict = profiles.data?.find(item => item.id === provider.trim() && item.id !== editingProfileId);
  const savedProviders = profiles.data ?? [];
  const query = providerSearch.trim().toLowerCase();
  const visibleProviders = savedProviders.filter(item => `${item.name ?? ""} ${item.id}`.toLowerCase().includes(query));
  const defaultPresets = presets.filter(preset => !savedProviders.some(item => item.id === preset.id));
  const availablePresets = defaultPresets.filter(preset => `${preset.name} ${preset.id}`.toLowerCase().includes(query));

  async function selectProvider(id: string) {
    const profile = profiles.data?.find((item) => item.id === id);
    if (!profile || switchingProviderId || running) return;
    lastSelectedProfileId.current = id;
    setEditingProfileId(id);
    update({ ...initialForm(profile), provider: id });
    setSwitchingProviderId(id);
    try {
      const catalog = await probeProviderModels(id, profile.baseUrl ?? "", profile.api ?? "openai-completions", undefined, profile.authHeader !== false, profile.modelsUrl || undefined);
      update({ models: Array.isArray(catalog.data) ? catalog.data : [] });
    } catch (error) {
      gooeyToast.warning("模型目录刷新失败，显示已保存的模型", { description: error instanceof Error ? error.message : String(error), showTimestamp: false });
    } finally { setSwitchingProviderId(null); }
  }

  async function applySelectedProvider() {
    if (!selected || switchingProviderId || running) return;
    const id = selected.id;
    setSwitchingProviderId(id);
    try {
      const synced = await syncProviderModels(id);
      if (online) await disconnect();
      await connect(cwd);
      const available = await request<{ models: { provider: string; id: string }[] }>({ type: "get_available_models" }, 30_000, cwd);
      const choices = available.models.filter(model => model.provider === id);
      const target = choices.find(model => model.id === selected.defaultModel) ?? choices.find(model => model.id === synced.firstModelId) ?? choices[0];
      if (!target) throw new Error(`${selected.name || id} 没有可用模型，请检查配置`);
      await request({ type: "set_model", provider: id, modelId: target.id }, 30_000, cwd);
      const current = await refresh(cwd);
      if (current.model?.provider !== id || current.model.id !== target.id) throw new Error("Pi 没有确认 Provider 切换");
      await persistDefaultModel(id, target.id);
      update({ defaultModelId: target.id });
      await queryClient.invalidateQueries({ queryKey: ["pi", "models", cwd] });
      await profiles.refetch();
      gooeyToast.success("已应用 Provider 配置", { description: `${selected.name || id} · ${target.id}`, showTimestamp: false });
    } catch (error) { report(error); } finally { setSwitchingProviderId(null); }
  }

  function closeEditor() {
    setEditorOpen(false);
    if (!editingProfileId && lastSelectedProfileId.current) {
      const profile = profiles.data?.find(item => item.id === lastSelectedProfileId.current);
      if (profile) { setEditingProfileId(profile.id); update(initialForm(profile)); }
    }
  }

  function newProvider() {
    setEditingProfileId(null);
    update(initialForm());
    setEditorOpen(true);
  }

  function applyPreset(preset: (typeof presets)[number]) {
    setEditingProfileId(null);
    update({ ...initialForm(), provider: preset.id, name: preset.name, baseUrl: preset.baseUrl, modelsUrl: `${preset.baseUrl}/models`, api: preset.api });
    gooeyToast.info(`已填入 ${preset.name} 官方端点`, { showTimestamp: false });
  }

  function openPreset(preset: (typeof presets)[number]) {
    applyPreset(preset);
    setEditorOpen(true);
  }

  function confirmDelete(profile: ProviderProfile) {
    if (activeProvider === profile.id || profile.isDefault) {
      gooeyToast.warning("请先应用另一个 Provider，再删除当前配置", { showTimestamp: false });
      return;
    }
    setDeletingProfile(profile);
  }

  async function removeProvider() {
    if (!deletingProfile || deleting) return;
    const id = deletingProfile.id;
    setDeleting(true);
    try {
      await deleteProvider(id);
      const refreshed = await profiles.refetch();
      if (editingProfileId === id) {
        const next = refreshed.data?.find(item => item.isDefault) ?? refreshed.data?.[0];
        setEditingProfileId(next?.id ?? null);
        lastSelectedProfileId.current = next?.id ?? null;
        update(initialForm(next));
      }
      setDeletingProfile(null);
      gooeyToast.success("Provider 配置已删除", { description: id, showTimestamp: false });
    } catch (error) { report(error); } finally { setDeleting(false); }
  }

  async function save() {
    update({ busy: "save" });
    try {
      const result = await saveProvider({ provider: provider.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), modelsUrl: modelsUrl.trim() || undefined, api, apiKey: apiKey.trim() || undefined, authHeader });
      lastSelectedProfileId.current = result.id;
      setEditingProfileId(result.id);
      update({ provider: result.id, apiKey: "" });
      let synced: Awaited<ReturnType<typeof syncProviderModels>> = { provider: result.id, count: 0, previous: 0 };
      try {
        synced = await syncProviderModels(result.id);
      } catch (syncError) {
        if (!defaultModelId.trim()) throw new Error(`Provider 已保存，但同步到 Pi 失败：${syncError instanceof Error ? syncError.message : String(syncError)}`);
        gooeyToast.warning("Provider 已保存，使用手动模型 ID", { description: syncError instanceof Error ? syncError.message : String(syncError), showTimestamp: false });
      }
      let switchedModel: { provider: string; id: string } | null = null;
      try {
        const preferredModelId = defaultModelId.trim() || synced.firstModelId;
        if (preferredModelId) await persistDefaultModel(result.id, preferredModelId);
        if (online) await disconnect();
        await connect(cwd);
        const available = await request<{ models: { provider: string; id: string }[] }>({ type: "get_available_models" }, 30_000, cwd);
        const firstModel = available.models.find((model) => model.provider === result.id && model.id === preferredModelId)
          ?? available.models.find((model) => model.provider === result.id);
        if (firstModel) {
          await request({ type: "set_model", provider: firstModel.provider, modelId: firstModel.id }, 30_000, cwd);
          const current = await refresh(cwd);
          if (current.model?.provider !== firstModel.provider || current.model?.id !== firstModel.id) {
            throw new Error(`Pi 仍在使用 ${current.model?.provider ?? "未知 Provider"}/${current.model?.id ?? "未知模型"}`);
          }
          await persistDefaultModel(firstModel.provider, firstModel.id);
          switchedModel = firstModel;
        } else {
          throw new Error(`Pi 没有加载 ${result.id} 的可用模型`);
        }
      } catch (activationError) {
        await disconnect().catch(() => undefined);
        throw new Error(`Provider 已保存，但 Pi 未能启用：${activationError instanceof Error ? activationError.message : String(activationError)}`);
      }
      gooeyToast.success("Provider 已保存", { description: switchedModel ? `${synced.count} 个模型 · 默认 ${switchedModel.id}` : defaultModelId.trim() ? `默认 ${defaultModelId.trim()}` : `${synced.count} 个模型已写入 Pi`, showTimestamp: false });
      await queryClient.invalidateQueries({ queryKey: ["pi", "models", cwd] });
      const refreshed = await profiles.refetch();
      const savedProfile = refreshed.data?.find(item => item.id === result.id);
      if (savedProfile) update(initialForm(savedProfile));
      setEditorOpen(false);
    } catch (error) { report(error); } finally { update({ busy: null }); }
  }

  async function probe() {
    update({ busy: "probe" });
    try {
      const catalog = await probeProviderModels(provider.trim(), baseUrl.trim(), api, apiKey.trim() || undefined, authHeader, modelsUrl.trim() || undefined);
      const next = Array.isArray(catalog.data) ? catalog.data : [];
      update({ models: mergeConfiguredModels(next) }); gooeyToast.success(`已加载 ${next.length} 个模型`, { description: "模型目录已更新", showTimestamp: false });
    } catch (error) { report(error); } finally { update({ busy: null }); }
  }

  async function applyModel(model: ProviderModel) {
    update({ busy: "use" });
    try {
      await saveProvider({ provider: provider.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), modelsUrl: modelsUrl.trim() || undefined, api, apiKey: apiKey.trim() || undefined, authHeader });
      await syncProviderModels(provider.trim());
      if (online) await disconnect();
      await connect(cwd);
      await request({ type: "set_model", provider: provider.trim(), modelId: model.id }, 30_000, cwd);
      const current = await refresh(cwd);
      if (current.model?.provider !== provider.trim() || current.model?.id !== model.id) throw new Error("Pi 没有确认模型切换");
      await persistDefaultModel(provider.trim(), model.id);
      update({ apiKey: "", defaultModelId: model.id }); gooeyToast.success("模型已切换", { description: `${provider.trim()} / ${model.id}`, showTimestamp: false });
      await profiles.refetch();
    } catch (error) { report(error); } finally { update({ busy: null }); }
  }

  const visibleModels = useMemo(() => models.filter((model) => `${model.id} ${modelDisplayName(model)}`.toLowerCase().includes(search.toLowerCase())), [models, search]);
  const selectDefaultModel = (id: string) => update({ defaultModelId: id });
  return (
    <section className="provider-settings">
      <aside className="provider-browser" aria-label="已添加的 Provider">
        <header><h1>模型供应商</h1><span>{savedProviders.length + defaultPresets.length}</span></header>
        <label className="provider-browser-search"><Icon name="magnifying-glass" /><Input aria-label="搜索供应商" value={providerSearch} onChange={event => setProviderSearch(event.target.value)} placeholder="搜索供应商" /></label>
        <div className="provider-browser-list">
          <div className="provider-browser-group"><span>已添加</span><span>{savedProviders.length}</span></div>
          <nav aria-label="已添加的 Provider">
            {visibleProviders.map(item => <button key={item.id} type="button" className="provider-browser-item" aria-current={editingProfileId === item.id ? "true" : undefined} disabled={Boolean(switchingProviderId) || running} onClick={() => void selectProvider(item.id)}><ProviderMark id={item.id} name={item.name} /><span>{item.name || item.id}</span></button>)}
            {!savedProviders.length && <p className="provider-browser-empty">还没有添加 Provider。</p>}
          </nav>
          {defaultPresets.length > 0 && <><div className="provider-browser-group provider-browser-presets-heading"><span>默认可添加</span><span>{defaultPresets.length}</span></div><nav aria-label="默认 Provider">{availablePresets.map(preset => <button key={preset.id} type="button" className="provider-browser-item provider-browser-preset" onClick={() => openPreset(preset)}><ProviderMark id={preset.id} /><span>{preset.name}</span><Icon name="plus" /></button>)}</nav></>}
          {savedProviders.length > 0 && !visibleProviders.length && !availablePresets.length && <p className="provider-browser-empty">没有匹配的 Provider。</p>}
        </div>
        <Button variant="ghost" className="provider-browser-add" onClick={newProvider}><Icon name="plus" />新增 Provider</Button>
      </aside>

      <div className="provider-detail">
        {selected ? <>
          <header className="provider-detail-header"><span className="provider-detail-mark"><ProviderMark id={selected.id} name={selected.name} /></span><div><h2>{selected.name || selected.id}</h2><p>{activeProvider === selected.id ? "当前使用" : "已添加"} · {models.length} 个模型{switchingProviderId === selected.id ? " · 处理中…" : ""}</p></div><div className="provider-detail-actions"><Button variant="outline" disabled={Boolean(switchingProviderId)} onClick={() => setEditorOpen(true)}><Icon name="pencil-simple" />编辑配置</Button><Button variant="default" disabled={Boolean(switchingProviderId) || running} onClick={() => void applySelectedProvider()}><Icon name="check" />{switchingProviderId === selected.id ? "应用中…" : "应用配置"}</Button><Button variant="ghost" className="provider-delete-button" disabled={Boolean(switchingProviderId)} onClick={() => confirmDelete(selected)}><Icon name="trash" />删除</Button></div></header>
          <div className="provider-detail-content">
            <div className="provider-connection"><span>基础 URL</span><code>{selected.baseUrl || "未配置"}</code><span className="provider-connection-note"><Icon name="shield-check" />{selected.hasApiKey ? "凭据已保存在本机" : "未保存 API Key"}</span></div>
            <div className="provider-models-heading"><strong>模型 <span>· {models.length}</span></strong><Button variant="outline" disabled={!!busy} onClick={() => void probe()}><Icon name="arrows-clockwise" />{busy === "probe" ? "刷新中…" : "刷新模型"}</Button></div>
            <label className="provider-model-search"><Icon name="magnifying-glass" /><Input aria-label="搜索模型名称或 ID" value={search} onChange={event => update({ search: event.target.value })} placeholder="搜索模型名称或 ID" /></label>
            <div className="provider-model-list provider-settings-list">
              {visibleModels.map(model => { const inputs = modelModalities(model, "input"); const outputs = modelModalities(model, "output"); return <Disclosure key={model.id} title={<span className="provider-model-title"><span className="provider-model-name"><ModelLogo modelId={model.id} size={19} /><strong>{modelDisplayName(model)}</strong></span><span className="provider-model-context">{typeof model.context_window === "number" ? formatContextLength(model.context_window) : "—"}{typeof model.context_window === "number" && <small> tokens</small>}</span><ModelModalities values={inputs} /><ModelModalities values={outputs} /></span>}><ModelDetails model={model} disabled={!!busy || running || !cwd} onUse={() => void applyModel(model)} /></Disclosure>; })}
              {!models.length && <div className="provider-models-empty"><Icon name="cpu" /><strong>还没有模型目录</strong><p>刷新模型后会在这里显示可用模型。</p></div>}
              {models.length > 0 && !visibleModels.length && <div className="provider-models-empty"><p>没有匹配的模型。</p></div>}
            </div>
          </div>
        </> : <div className="provider-detail-empty"><Icon name="database" /><h2>添加 Provider</h2><p>新增后，供应商和模型会显示在这里。</p><Button variant="default" onClick={newProvider}><Icon name="plus" />新增 Provider</Button></div>}
      </div>

      <Dialog open={editorOpen} onOpenChange={open => { if (open) setEditorOpen(true); else closeEditor(); }}>
        <DialogContent className="provider-editor-dialog">
          <DialogHeader><DialogTitle>{editingProfileId ? "编辑 Provider" : "新增 Provider"}</DialogTitle><DialogDescription>配置端点、模型与凭据。保存后会同步到 Pi。</DialogDescription></DialogHeader>
          <div className="provider-dialog-body">
            {!editingProfileId && <div className="provider-presets"><span>快速填入</span>{presets.map(preset => <Button key={preset.id} variant="outline" onClick={() => applyPreset(preset)}><ProviderMark id={preset.id} />{preset.name}</Button>)}</div>}
            <div className="provider-dialog-grid">
              <label><ProviderFieldLabel icon="identification-card">Provider ID</ProviderFieldLabel><Input value={provider} onChange={event => update({ provider: event.target.value })} placeholder="例如 my-gateway" aria-invalid={Boolean(providerConflict)} />{providerConflict && <small className="provider-field-error">该 ID 已存在，请选择已添加的 Provider。</small>}</label>
              <label><ProviderFieldLabel icon="article">显示名称</ProviderFieldLabel><Input value={name} onChange={event => update({ name: event.target.value })} placeholder="例如 Team Gateway" /></label>
              <label><ProviderFieldLabel icon="link">Base URL</ProviderFieldLabel><Input value={baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://example.com/v1" /></label>
              <label><ProviderFieldLabel icon="list-magnifying-glass">模型列表接口</ProviderFieldLabel><Input value={modelsUrl} onChange={event => update({ modelsUrl: event.target.value })} placeholder="留空则使用 Base URL/models" /></label>
              <label><ProviderFieldLabel icon="globe">API 类型</ProviderFieldLabel><CompactSelect aria-label="API 类型" value={api} onChange={event => update({ api: event.target.value as (typeof apiTypes)[number] })}>{apiTypes.map(item => <option key={item} value={item}>{item}</option>)}</CompactSelect></label>
              <label><ProviderFieldLabel icon="cpu">默认模型</ProviderFieldLabel><CompactSelect aria-label="默认模型目录" value={defaultModelId} onChange={event => selectDefaultModel(event.target.value)}><option value="">保存后使用首个模型</option>{models.map(model => <option key={model.id} value={model.id}>{modelDisplayName(model)}</option>)}</CompactSelect></label>
              <label><ProviderFieldLabel icon="identification-card">模型 ID</ProviderFieldLabel><Input value={defaultModelId} onChange={event => update({ defaultModelId: event.target.value })} placeholder="也可手动输入模型 ID" spellCheck={false} /></label>
              <label><ProviderFieldLabel icon="key">API Key</ProviderFieldLabel><Input type="password" value={apiKey} onChange={event => update({ apiKey: event.target.value })} placeholder={selected?.hasApiKey ? "已保存，留空保持不变" : "输入服务商 API Key"} autoComplete="off" /></label>
            </div>
            <div className="provider-dialog-auth"><div><strong>发送认证请求头</strong><p>关闭后，模型服务请求不会附带 API Key。</p></div><Switch aria-label="发送 API 认证请求头" checked={authHeader} onChange={value => update({ authHeader: value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={closeEditor}>取消</Button><Button variant="outline" disabled={!!busy || !provider.trim() || !baseUrl.trim() || Boolean(providerConflict)} onClick={() => void probe()}>{busy === "probe" ? "正在查询…" : "测试连接"}</Button><Button variant="default" disabled={!!busy || !provider.trim() || !baseUrl.trim() || Boolean(providerConflict)} onClick={() => void save()}>{busy === "save" ? "正在保存并同步…" : "保存并同步"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingProfile)} onOpenChange={open => { if (!open && !deleting) setDeletingProfile(null); }}>
        <DialogContent className="provider-delete-dialog" showCloseButton={false}>
          <DialogHeader><DialogTitle>删除 Provider 配置</DialogTitle><DialogDescription>将从本机移除 Provider、模型目录和保存的 API Key。此操作不会删除服务商账号。</DialogDescription></DialogHeader>
          <strong className="provider-delete-name">{deletingProfile?.name || deletingProfile?.id}</strong>
          <DialogFooter><Button variant="outline" disabled={deleting} onClick={() => setDeletingProfile(null)}>取消</Button><Button variant="destructive" disabled={deleting} onClick={() => void removeProvider()}><Icon name="trash" />{deleting ? "删除中…" : "删除配置"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
