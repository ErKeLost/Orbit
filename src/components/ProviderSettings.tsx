import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  listProviderProfiles,
  listProviderModels,
  probeProviderModels,
  saveProvider,
  deleteProvider,
  queryClient,
  imageConfig,
  saveImageConfig,
  type ModelEffort,
  type ProviderModel,
  type ProviderProfile,
} from "../lib/rpc";
import { report } from "../lib/rpc";
import { Button } from "../shared/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { useWorkspace } from "../lib/store";
import { toast as gooeyToast } from "../shared/ui/toast";
import { Icon } from "./Icon";
import { ProviderMark } from "./ProviderLogo";
import { ProviderBrowser } from "../features/providers/ProviderBrowser";
import { presets, type Preset } from "../features/providers/presets";
import { ProviderEditorDialog } from "../features/providers/ProviderEditorDialog";
import { initialForm, type ProviderFormState } from "../features/providers/provider-form";
import { SubscriptionAccounts } from "../features/providers/SubscriptionAccounts";
import { MagpieGateway } from "../features/providers/MagpieGateway";
import { PiRuntimeConfiguration } from "../features/providers/PiRuntimeConfiguration";
import { ProviderModelList } from "../features/providers/ProviderModelList";
import { cachedCatalog, forgetCatalog, loadCatalog, rememberCatalog } from "../features/providers/provider-catalog";
import { saveAndActivate, syncAndActivate } from "../features/providers/provider-actions";
import "../styles/provider-page.css";

function baseUrlHost(value?: string) {
  if (!value) return null;
  try { return new URL(value).host; } catch { return value; }
}

export function ProviderSettings() {
  const profiles = useQuery({ queryKey: ["provider-profiles"], queryFn: listProviderProfiles, staleTime: 10_000 });
  const running = useWorkspace(state => state.transcript.running);
  const initialProfile = profiles.data?.find((profile) => profile.isDefault) ?? profiles.data?.[0];
  const changed = () => {
    void profiles.refetch();
    void queryClient.invalidateQueries({ queryKey: ["pi", "models"] });
  };
  return <div className="provider-settings-page">
    <PiRuntimeConfiguration onSaved={() => { changed(); void queryClient.invalidateQueries({ queryKey: ["provider-auth"] }); }} />
    <SubscriptionAccounts onChanged={changed} disabled={running} />
    <MagpieGateway key={profiles.data?.find(profile => profile.id === "magpie")?.baseUrl ?? "new-magpie"} profile={profiles.data?.find(profile => profile.id === "magpie")} onChanged={changed} disabled={running} />
    {profiles.error && <p role="alert" className="provider-field-error">{String(profiles.error)}</p>}
    <ProviderSettingsEditor key={initialProfile?.id ?? "new-provider"} profiles={profiles} initialProfile={initialProfile} />
  </div>;
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
  // 搜索词不进表单 reducer：它只影响列表，不该带着整张表单和目录一起重渲。
  const [search, setSearch] = useState("");
  const { provider, name, baseUrl, modelsUrl, api, apiKey, defaultModelId, authHeader, contextWindow, modelEfforts, models, busy } = form;
  const providerDefaults = { contextWindow: contextWindow ? Number(contextWindow) : undefined, modelEfforts };
  const effortFor = (id: string) => modelEfforts[id];
  // 稳定引用：行是 memo 的，effort 回调用同一个函数，打字时 300 行才不会全量重渲。
  const setEffortFor = useCallback((id: string, next?: ModelEffort) => {
    const rest = { ...modelEfforts };
    if (next && (next.levels.length > 0 || next.default)) rest[id] = next;
    else delete rest[id];
    update({ modelEfforts: rest });
  }, [modelEfforts]);

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
    setSearch("");
    // 先用已保存的目录把详情渲染出来，再去后台核对：以前这一步会把整个侧边栏
    // `disabled` 住，等一个 Node 凭据进程 + 一次网络请求，体感就是“点一下整页死住”。
    const cached = cachedCatalog(id);
    update({ ...initialForm(profile), provider: id, models: cached ?? profile.models ?? [] });
    if (cached) return;
    setSwitchingProviderId(id);
    try {
      update({ models: await loadCatalog(id) });
    } catch (error) {
      gooeyToast.warning("模型目录刷新失败，显示已保存的模型", { description: error instanceof Error ? error.message : String(error), showTimestamp: false });
    } finally { setSwitchingProviderId(null); }
  }

  async function applySelectedProvider() {
    if (!selected || switchingProviderId || running) return;
    const id = selected.id;
    setSwitchingProviderId(id);
    // 切换前真正在用的那份：失败时要回滚到它（不是被意图盖过的那份）。
    const previous = useWorkspace.getState().state;
    try {
      const activated = await syncAndActivate(
        { provider: id, label: selected.name || id, defaultModel: selected.defaultModel, modelEfforts: selected.modelEfforts },
        { cwd, online },
        previous,
      );
      update({ defaultModelId: activated.modelId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pi", "models", cwd] }),
        profiles.refetch(),
      ]);
      gooeyToast.success("已应用 Provider 配置", { description: `${selected.name || id} · ${activated.modelId}`, showTimestamp: false });
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

  function applyPreset(preset: Preset) {
    setEditingProfileId(null);
    update({ ...initialForm(), provider: preset.id, name: preset.name, baseUrl: preset.baseUrl, modelsUrl: `${preset.baseUrl}/models`, api: preset.api });
    gooeyToast.info(`已填入 ${preset.name} 官方端点`, { showTimestamp: false });
  }

  function openPreset(preset: Preset) {
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
      const saved = await saveAndActivate({
        payload: { provider: provider.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), modelsUrl: modelsUrl.trim() || undefined, api, apiKey: apiKey.trim() || undefined, authHeader, ...providerDefaults },
        manualModelId: defaultModelId,
        context: { cwd, online },
        onSyncFailure: message => gooeyToast.warning("Provider 已保存，使用手动模型 ID", { description: message, showTimestamp: false }),
      });
      lastSelectedProfileId.current = saved.id;
      setEditingProfileId(saved.id);
      update({ provider: saved.id, apiKey: "" });
      gooeyToast.success("Provider 已保存", { description: saved.modelId ? `${saved.count} 个模型 · 默认 ${saved.modelId}` : defaultModelId.trim() ? `默认 ${defaultModelId.trim()}` : `${saved.count} 个模型已写入 Pi`, showTimestamp: false });
      forgetCatalog(saved.id);
      await queryClient.invalidateQueries({ queryKey: ["pi", "models", cwd] });
      const refreshed = await profiles.refetch();
      const savedProfile = refreshed.data?.find(item => item.id === saved.id);
      if (savedProfile) update(initialForm(savedProfile));
      setEditorOpen(false);
    } catch (error) { report(error); } finally { update({ busy: null }); }
  }

  async function probe() {
    update({ busy: "probe" });
    try {
      const catalog = selected?.native
        ? await listProviderModels(selected.id)
        : await probeProviderModels(provider.trim(), baseUrl.trim(), api, apiKey.trim() || undefined, authHeader, modelsUrl.trim() || undefined, providerDefaults.contextWindow);
      const next = Array.isArray(catalog.data) ? catalog.data : [];
      rememberCatalog(provider.trim(), next);
      update({ models: mergeConfiguredModels(next) }); gooeyToast.success(`已加载 ${next.length} 个模型`, { description: "模型目录已更新", showTimestamp: false });
    } catch (error) { report(error); } finally { update({ busy: null }); }
  }

  async function applyModel(model: ProviderModel) {
    update({ busy: "use" });
    const previous = useWorkspace.getState().state;
    try {
      if (!selected?.native) await saveProvider({ provider: provider.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim(), modelsUrl: modelsUrl.trim() || undefined, api, apiKey: apiKey.trim() || undefined, authHeader, ...providerDefaults });
      await syncAndActivate(
        { provider: provider.trim(), defaultModel: model.id, firstModelId: model.id, modelEfforts },
        { cwd, online },
        previous,
      );
      update({ apiKey: "", defaultModelId: model.id }); gooeyToast.success("模型已切换", { description: `${provider.trim()} / ${model.id}`, showTimestamp: false });
      await profiles.refetch();
    } catch (error) { report(error); } finally { update({ busy: null }); }
  }

  const imageSettings = useQuery({ queryKey: ["pi", "image-config"], queryFn: imageConfig });
  // An image-only provider has no chat model to switch to; its rows pick the
  // model the generate_image tool uses instead.
  const imageProvider = models.length > 0 && models.every(model => model.type === "image");
  const currentImageModel = imageSettings.data?.defaults?.model || models.find(model => model.type === "image")?.id || "";
  async function setDefaultImageModel(model: ProviderModel) {
    try {
      await saveImageConfig({ model: model.id });
      await imageSettings.refetch();
      gooeyToast.success("已设为图片默认模型", { description: model.id, showTimestamp: false });
    } catch (error) { report(error); }
  }
  // 行是 `memo` 的：把总是新引用的回调变成稳定引用，否则每次重渲都等于全量重渲。
  const applyModelRef = useRef(applyModel);
  const setDefaultImageModelRef = useRef(setDefaultImageModel);
  useEffect(() => {
    applyModelRef.current = applyModel;
    setDefaultImageModelRef.current = setDefaultImageModel;
  });
  const useChatModel = useCallback((model: ProviderModel) => { void applyModelRef.current(model); }, []);
  const useImageModel = useCallback((model: ProviderModel) => { void setDefaultImageModelRef.current(model); }, []);
  return (
    <section className="provider-settings provider-settings-editor">
      <ProviderBrowser
        search={providerSearch}
        onSearchChange={setProviderSearch}
        savedProviders={savedProviders}
        visibleProviders={visibleProviders}
        availablePresets={availablePresets}
        templateCount={defaultPresets.length}
        editingId={editingProfileId}
        switchingId={switchingProviderId}
        onSelect={id => void selectProvider(id)}
        onOpenPreset={openPreset}
        onNew={newProvider}
      />

      <div className="provider-detail">
        {selected ? <>
          <header className="provider-detail-header"><span className="provider-detail-mark"><ProviderMark id={selected.id} name={selected.name} /></span><div className="provider-detail-title"><h2>{selected.name || selected.id}{activeProvider === selected.id ? <span className="provider-status">当前使用</span> : <span className="provider-status" data-tone="muted">已添加</span>}</h2><p>{models.length} 个{imageProvider ? "图片模型" : "模型"}{baseUrlHost(selected.baseUrl) ? <> · <code title={selected.baseUrl}>{baseUrlHost(selected.baseUrl)}</code></> : null}{switchingProviderId === selected.id ? " · 处理中…" : ""}</p></div><div className="provider-detail-actions">{!selected.native && <Button variant="outline" disabled={Boolean(switchingProviderId)} onClick={() => setEditorOpen(true)}><Icon name="pencil" />编辑配置</Button>}{!imageProvider && <Button variant="default" disabled={Boolean(switchingProviderId) || running} onClick={() => void applySelectedProvider()}><Icon name="check" />{switchingProviderId === selected.id ? "应用中…" : "应用配置"}</Button>}{!selected.native && <Button variant="ghost" className="provider-delete-button" size="icon" title="删除配置" disabled={Boolean(switchingProviderId)} onClick={() => confirmDelete(selected)}><Icon name="trash" /></Button>}</div></header>
          <div className="provider-detail-content">
            <section className="provider-card">
              <header className="provider-card-head">
                <div>
                  <h3>基础配置</h3>
                  <p>{selected.native ? "账户与模型由 Pi 原生管理。" : "配置 API 访问凭据与连接选项。"}</p>
                </div>
              </header>
              <div className="provider-card-rows">
                <div className="provider-row">
                  <span className="provider-row-label">基础 URL</span>
                  <code className="provider-row-value" title={selected.baseUrl}>{selected.baseUrl || (selected.native ? "Pi 原生端点" : "未配置")}</code>
                  <span className="provider-connection-note"><Icon name="shield" />{selected.isOAuth ? "订阅已登录 · 自动续期" : selected.hasApiKey ? "凭据已保存在本地" : "未保存 API Key"}</span>
                </div>
                <div className="provider-row">
                  <span className="provider-row-label">{selected.isOAuth ? "账户认证" : "API Key"}</span>
                  <code className="provider-row-value">{selected.isOAuth ? "OAuth" : selected.hasApiKey ? "••••••••••••••••" : "未设置"}</code>
                  <span className="provider-connection-note">{selected.native ? "在上方订阅与账户中管理" : "在「编辑配置」中更新"}</span>
                </div>
              </div>
            </section>
            <section className="provider-card provider-card-models">
              <header className="provider-card-head">
                <div>
                  <h3>{imageProvider ? "图片模型" : "模型目录"}<span className="provider-card-count">{models.length}</span></h3>
                  <p>{imageProvider ? "供 generate_image 使用的模型。" : "已从该提供商获取的可用模型。"}</p>
                </div>
                {!imageProvider ? <Button variant="outline" disabled={!!busy} onClick={() => void probe()}><Icon name="refresh-cw" />{busy === "probe" ? "刷新中…" : "刷新模型"}</Button> : null}
              </header>
            {imageProvider && <p className="provider-models-note">这些模型供 generate_image 使用。图片工具的端点、模型与密钥在「设置 → Pi 能力 → 图片模型 → 端点」里配置，不读取这里的 Base URL。</p>}
            <ProviderModelList
              models={models}
              search={search}
              onSearchChange={setSearch}
              native={Boolean(selected.native)}
              disabled={imageProvider ? !!busy : (!!busy || running || !cwd)}
              imageProvider={imageProvider}
              currentImageModel={currentImageModel}
              defaultModelId={selected.defaultModel}
              effortFor={effortFor}
              onUse={useChatModel}
              onEffortChange={setEffortFor}
              onUseImage={useImageModel}
            />
            </section>
          </div>
        </> : <div className="provider-detail-empty"><Icon name="bot" /><h2>添加 Provider</h2><p>新增后，供应商和模型会显示在这里。</p><Button variant="default" onClick={newProvider}><Icon name="plus" />新增 Provider</Button></div>}
      </div>

      <ProviderEditorDialog
        open={editorOpen}
        onClose={closeEditor}
        editingProfileId={editingProfileId}
        form={form}
        update={update}
        selected={selected}
        conflict={Boolean(providerConflict)}
        busy={busy}
        onSave={() => void save()}
        onProbe={() => void probe()}
        onPreset={applyPreset}
      />

      <Dialog open={Boolean(deletingProfile)} onOpenChange={(open: boolean) => { if (!open && !deleting) setDeletingProfile(null); }}>
        <DialogContent className="provider-delete-dialog" showCloseButton={false}>
          <DialogHeader><DialogTitle>删除 Provider 配置</DialogTitle><DialogDescription>将从本机移除 Provider、模型目录和保存的 API Key。此操作不会删除服务商账号。</DialogDescription></DialogHeader>
          <strong className="provider-delete-name">{deletingProfile?.name || deletingProfile?.id}</strong>
          <DialogFooter><Button variant="outline" disabled={deleting} onClick={() => setDeletingProfile(null)}>取消</Button><Button variant="destructive" disabled={deleting} onClick={() => void removeProvider()}><Icon name="trash" />{deleting ? "删除中…" : "删除配置"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
