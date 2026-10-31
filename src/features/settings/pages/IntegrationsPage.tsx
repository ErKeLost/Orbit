import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Select, Toggle } from "../../../shared/ui/controls";
import { Icon } from "../../../components/Icon";
import { ImageEndpointDialog } from "../../../components/ImageEndpointDialog";
import { toast as gooeyToast } from "../../../shared/ui/toast";
import { imageConfig, refreshCapabilities, report, saveImageConfig, type ImageConfig, type ImageConfigKind, saveWebSearchApiKey, saveWebSearchConfig, webSearchConfig } from "../../../lib/rpc";
import { useWorkspace } from "../../../lib/store";
import { availableMediaModels, parseCapabilities } from "../../../lib/capabilities";
import "../../../styles/provider-page.css";

const BUILTIN_IMAGE_MODELS = [
  { id: "doubao-seedream-5-0-flash-260915", name: "Seedream 5.0 Flash" },
  { id: "doubao-seedream-5-0-260128", name: "Seedream 5.0 Lite" },
  { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5" },
  { id: "doubao-seedream-4-0-20260415", name: "Seedream 4.0" },
] as const;

/**
 * 第三方接入：一个端点，和它提供的能力。
 *
 * 这一页是**数据层之上的第一层 UI** —— 它只做三件事：看端点、开关能力、选默认模型。
 * 参数表（分辨率 / 画幅 / 各自的 options）不在这里编辑：它们是 `kinds.<kind>.params`
 * 里的数据，手改 `image.json` 更直接，而这个页面把它读出来的形状展示清楚就够了。
 *
 * 视觉复用 `provider-page.css`（左栏 rails / 卡片 / 行），所以这一页没有自己的 CSS。
 */
function CapabilityRow({
  kind,
  spec,
  models,
  defaultModel,
  disabled,
  onToggle,
  onPickModel,
}: {
  kind: string;
  spec: ImageConfigKind;
  models: { id: string; name?: string }[];
  defaultModel?: string;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onPickModel: (id: string) => void;
}) {
  // 参数表里 `from: "catalog"` 的那一个就是这个能力的模型选择器 —— 今天只有 `model`。
  // 没有参数表时也照样可切：写入的是顶层默认模型（运行时读的就是它）。
  const enabled = spec.enabled !== false;
  const showSelect = enabled && models.length > 0;
  return (
    <div className="provider-row">
      <span className="provider-row-label">{spec.label ?? kind}</span>
      <span className="provider-row-value" title={`generate_${kind}`}>
        {`generate_${kind}`}
      </span>
      {showSelect ? (
        <Select
          label={`${spec.label ?? kind} 默认模型`}
          className="w-52 shrink-0"
          value={defaultModel ?? ""}
          disabled={disabled}
          onChange={onPickModel}
          options={[{ value: "", label: "（未设置）" }, ...models.map(model => ({ value: model.id, label: model.name ?? model.id }))]}
        />
      ) : (
        <span className="provider-connection-note">
          {enabled ? `${models.length} 个模型` : "已关闭"}
        </span>
      )}
      <Toggle label={`启用 ${spec.label ?? kind}`} on={enabled} disabled={disabled} onChange={onToggle} />
    </div>
  );
}

export function IntegrationsPage() {
  const desktop = useWorkspace((state) => state.runtimeTarget === "desktop");
  const online = useWorkspace((state) => state.connection === "online");
  const capabilities = parseCapabilities(useWorkspace((state) => state.statuses?.capabilities));
  const config = useQuery({ queryKey: ["pi", "image-config"], queryFn: imageConfig, enabled: desktop });
  const webSearch = useQuery({ queryKey: ["pi", "web-search-config"], queryFn: webSearchConfig, enabled: desktop });
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [webSearchDraft, setWebSearchDraft] = useState({ enabled: true, baseUrl: "", providerId: "", searchUrl: "", apiKey: "" });

  useEffect(() => {
    const value = webSearch.data;
    if (!value) return;
    setWebSearchDraft({ enabled: value.enabled, baseUrl: value.baseUrl, providerId: value.providerId, searchUrl: value.searchUrl, apiKey: "" });
  }, [webSearch.data]);

  // Capabilities are published by Pi's extension, not by image_config. Refresh
  // them when this page is entered so the model selector does not depend on
  // having visited General or on a status event emitted before mount.
  useEffect(() => {
    if (desktop && online) void refreshCapabilities().catch(report);
  }, [desktop, online]);

  const discoveredModels = availableMediaModels(capabilities?.media.image ?? []);
  const configuredModels = (config.data?.models ?? []).map((model) => ({
    provider: config.data?.provider?.id ?? config.data?.defaultProviderId ?? "volcengine",
    id: model.id,
    name: model.name,
    available: config.data?.hasApiKey === true,
  }));
  // The extension intentionally falls back to Ark's built-in catalog and one
  // image capability when image.json has no explicit lists. Mirror that
  // resolved shape here; otherwise the page shows 0/0 and renders an empty
  // select even though generate_image can already use the built-ins.
  const models = discoveredModels.length
    ? discoveredModels
    : configuredModels.length
      ? configuredModels
      : BUILTIN_IMAGE_MODELS.map((model) => ({
        provider: config.data?.provider?.id ?? config.data?.defaultProviderId ?? "volcengine",
        ...model,
        available: config.data?.hasApiKey === true,
      }));
  const kinds = Object.entries(config.data?.kinds ?? { image: { label: "图片", enabled: true } });

  async function write(patch: Parameters<typeof saveImageConfig>[0], announce: string) {
    try {
      await saveImageConfig(patch);
      await config.refetch();
      // 分辨率和画幅的选项来自**这个能力当前默认模型**的尺寸表，所以改了模型要一起刷新。
      await refreshCapabilities();
      gooeyToast.success(announce, { showTimestamp: false });
    } catch (error) {
      report(error);
    }
  }

  const setKindEnabled = (kind: string, spec: ImageConfigKind, enabled: boolean) =>
    write({ kinds: { ...(config.data?.kinds ?? {}), [kind]: { ...spec, enabled } } }, enabled ? `已启用 ${spec.label ?? kind}` : `已关闭 ${spec.label ?? kind}`);

  async function saveWebSearch() {
    try {
      const saved = await saveWebSearchConfig({ enabled: webSearchDraft.enabled, baseUrl: webSearchDraft.baseUrl, providerId: webSearchDraft.providerId, searchUrl: webSearchDraft.searchUrl });
      if (webSearchDraft.apiKey.trim()) await saveWebSearchApiKey(saved.providerId, webSearchDraft.apiKey.trim());
      setWebSearchDraft(current => ({ ...current, apiKey: "" }));
      await webSearch.refetch();
      gooeyToast.success("Web Search 配置已保存", { description: "重连项目后，新的端点设置会用于会话", showTimestamp: false });
    } catch (error) { report(error); }
  }

  async function clearWebSearchKey() {
    try {
      await saveWebSearchApiKey(webSearch.data?.providerId ?? webSearchDraft.providerId, null);
      await webSearch.refetch();
      gooeyToast.success("Web Search 密钥已清除", { showTimestamp: false });
    } catch (error) { report(error); }
  }

  return (
    <section className="provider-settings integrations-settings" aria-label="第三方接入">
      <div className="provider-detail">
        <header className="provider-detail-header">
          <span className="provider-detail-mark">
            <Icon name="plug" />
          </span>
          <div className="provider-detail-title">
            <h2>
              {config.data?.provider?.name ?? config.data?.defaultProviderId ?? "火山方舟"}
              {config.data?.hasApiKey ? (
                <span className="provider-status">已连接</span>
              ) : (
                <span className="provider-status" data-tone="muted">
                  未配置
                </span>
              )}
            </h2>
            <p>
              {kinds.filter(([, spec]) => spec.enabled !== false).length}/{kinds.length} 个能力启用 ·{" "}
              <code>{config.data?.provider?.baseUrl ?? "内置默认端点"}</code>
            </p>
          </div>
          <div className="provider-detail-actions">
            <Button variant="outline" onClick={() => void refreshCapabilities()}>
              <Icon name="refresh-cw" />
              刷新模型
            </Button>
            <Button variant="outline" onClick={() => setEndpointOpen(true)}>
              <Icon name="pencil" />
              编辑端点
            </Button>
          </div>
        </header>

        <div className="provider-detail-content">
        <section className="provider-card">
          <header className="provider-card-head">
            <div>
              <h3>Web Search <span className="provider-status">Expand</span></h3>
              <p>一个工具支持 search、fetch、highlights 三种 mode。API Key 只保存在 Pi 的 auth.json。</p>
            </div>
            <Toggle label="启用 Web Search" on={webSearchDraft.enabled} disabled={!desktop} onChange={(enabled) => setWebSearchDraft(current => ({ ...current, enabled }))} />
          </header>
          <div className="provider-card-rows">
            <div className="provider-row provider-row-form">
              <label className="provider-row-label">Provider ID<Input aria-label="Web Search Provider ID" value={webSearchDraft.providerId} disabled={!desktop} onChange={(event) => setWebSearchDraft(current => ({ ...current, providerId: event.target.value }))} placeholder="expand" spellCheck={false} /></label>
              <label className="provider-row-label">Base URL<Input aria-label="Expand Base URL" value={webSearchDraft.baseUrl} disabled={!desktop} onChange={(event) => setWebSearchDraft(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.expand.ai" spellCheck={false} /></label>
            </div>
            <div className="provider-row provider-row-form">
              <label className="provider-row-label">Search URL<Input aria-label="Web Search URL" value={webSearchDraft.searchUrl} disabled={!desktop} onChange={(event) => setWebSearchDraft(current => ({ ...current, searchUrl: event.target.value }))} placeholder="https://www.bing.com/search?q=" spellCheck={false} /></label>
              <label className="provider-row-label">API Key<Input aria-label="Expand API Key" type="password" autoComplete="off" value={webSearchDraft.apiKey} disabled={!desktop} onChange={(event) => setWebSearchDraft(current => ({ ...current, apiKey: event.target.value }))} placeholder={webSearch.data?.hasApiKey ? "已保存，留空保持不变" : "粘贴 Expand API Key"} spellCheck={false} /></label>
            </div>
            <div className="provider-row">
              <span className="provider-row-label">凭据状态</span>
              <span className="provider-connection-note">{webSearch.data?.hasApiKey ? "已配置" : "未配置"}</span>
              <div className="provider-detail-actions"><Button variant="outline" disabled={!desktop} onClick={() => void saveWebSearch()}>保存配置</Button>{webSearch.data?.hasApiKey ? <Button variant="ghost" disabled={!desktop} onClick={() => void clearWebSearchKey()}>清除密钥</Button> : null}</div>
            </div>
          </div>
        </section>
          <section className="provider-card">
            <header className="provider-card-head">
              <div>
                <h3>基础配置</h3>
                <p>生成请求的地址与凭据。密钥存放在 Pi 的 auth.json，不写进这个配置文件。</p>
              </div>
            </header>
            <div className="provider-card-rows">
              <div className="provider-row">
                <span className="provider-row-label">Provider ID</span>
                <code className="provider-row-value">{config.data?.provider?.id ?? config.data?.defaultProviderId ?? "volcengine"}</code>
                <span className="provider-connection-note">
                  <Icon name="shield" />
                  {config.data?.hasApiKey ? "凭据已保存在本地" : "未保存 API Key"}
                </span>
              </div>
              <div className="provider-row">
                <span className="provider-row-label">默认模型</span>
                <Select
                  label="默认出图模型"
                  className="w-52 shrink-0"
                  value={config.data?.defaults?.model ?? ""}
                  disabled={!desktop}
                  onChange={model => void write({ model }, "默认模型已切换")}
                  options={[{ value: "", label: "（未设置）" }, ...models.map(model => ({ value: model.id, label: model.name ?? model.id }))]}
                />
                <span className="provider-connection-note">generate_image 缺省用它，调用时也可单独指定</span>
              </div>
              <div className="provider-row">
                <span className="provider-row-label">Base URL</span>
                <code className="provider-row-value" title={config.data?.provider?.baseUrl}>
                  {config.data?.provider?.baseUrl ?? "内置默认（火山方舟）"}
                </code>
                <span className="provider-connection-note">在「编辑端点」中更新</span>
              </div>
            </div>
          </section>

          <section className="provider-card">
            <header className="provider-card-head">
              <div>
                <h3>
                  生成能力 <span className="provider-card-count">{kinds.length}</span>
                </h3>
                <p>
                  关掉的能力不注册工具 —— 它的参数和准则都不会进提示，模型看不到它。工具名是 <code>generate_&lt;能力&gt;</code>。
                </p>
              </div>
            </header>
            <div className="provider-card-rows">
              {kinds.map(([kind, spec]) => (
                <CapabilityRow
                  key={kind}
                  kind={kind}
                  spec={spec}
                  models={models}
                  defaultModel={config.data?.defaults?.model}
                  disabled={!desktop}
                  onToggle={(enabled) => void setKindEnabled(kind, spec, enabled)}
                  onPickModel={(id) => void write({ model: id }, `默认模型已切换`)}
                />
              ))}
              {!kinds.length ? (
                <div className="provider-row">
                  <span className="provider-connection-note">配置文件里还没有能力表；扩展会用内置的 image 一条。</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="provider-card">
            <header className="provider-card-head">
              <div>
                <h3>
                  可用出图模型 <span className="provider-card-count">{models.length}</span>
                </h3>
                <p>来自每一个有凭据的 Provider，判据是端点自己报的模态与分类，不是名字里有没有 image。</p>
              </div>
            </header>
            <div className="provider-card-rows">
              {models.map((model) => (
                <div className="provider-row" key={model.id}>
                  <span className="provider-row-label">{model.name ?? model.id}</span>
                  <code className="provider-row-value">{model.id}</code>
                  <span className="provider-connection-note">{model.available ? "已配置凭据" : "缺少凭据"}</span>
                </div>
              ))}
              {!models.length ? (
                <div className="provider-row">
                  <span className="provider-connection-note">还没有发现出图模型。检查端点的 /models 是否报告 output_modalities。</span>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <ImageEndpointDialog
        open={endpointOpen}
        onOpenChange={setEndpointOpen}
        config={config.data as ImageConfig | undefined}
        onSaved={() => {
          void config.refetch();
          void refreshCapabilities();
        }}
      />
    </section>
  );
}

export default IntegrationsPage;
