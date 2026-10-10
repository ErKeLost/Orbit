import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Switch } from "../UI";
import { Icon } from "../Icon";
import { ImageEndpointDialog } from "../ImageEndpointDialog";
import { toast as gooeyToast } from "../../shared/ui/toast";
import { imageConfig, refreshCapabilities, report, saveImageConfig, type ImageConfig, type ImageConfigKind } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { availableMediaModels, parseCapabilities } from "../../lib/capabilities";
import "../..//styles/provider-page.css";

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
  // 参数项里 `from: "catalog"` 的那一个就是这个能力的模型选择器 —— 今天只有 `model`。
  const catalogParam = Object.entries(spec.params ?? {}).find(([, param]) => param.from === "catalog")?.[0];
  const enabled = spec.enabled !== false;
  return (
    <div className="provider-row">
      <span className="provider-row-label">{spec.label ?? kind}</span>
      <span className="provider-row-value" title={`generate_${kind}`}>
        {`generate_${kind}`}
      </span>
      {catalogParam && enabled ? (
        <select
          aria-label={`${spec.label ?? kind} 默认模型`}
          className="provider-kind-select"
          value={defaultModel ?? ""}
          disabled={disabled}
          onChange={(event) => onPickModel(event.target.value)}
        >
          <option value="">（未设置）</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name ?? model.id}
            </option>
          ))}
        </select>
      ) : (
        <span className="provider-connection-note">
          {enabled ? `${models.length} 个模型` : "已关闭"}
        </span>
      )}
      <Switch aria-label={`启用 ${spec.label ?? kind}`} checked={enabled} disabled={disabled} onChange={onToggle} />
    </div>
  );
}

export function IntegrationsPanel() {
  const desktop = useWorkspace((state) => state.runtimeTarget === "desktop");
  const capabilities = parseCapabilities(useWorkspace((state) => state.statuses?.capabilities));
  const config = useQuery({ queryKey: ["pi", "image-config"], queryFn: imageConfig, enabled: desktop });
  const [endpointOpen, setEndpointOpen] = useState(false);

  const models = availableMediaModels(capabilities?.media.image ?? []);
  const kinds = Object.entries(config.data?.kinds ?? {});

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

  return (
    <section className="provider-settings" aria-label="第三方接入">
      <div className="provider-detail">
        <header className="provider-detail-header">
          <span className="provider-detail-mark">
            <Icon name="plugs-connected" />
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
              <Icon name="arrows-clockwise" />
              刷新模型
            </Button>
            <Button variant="outline" onClick={() => setEndpointOpen(true)}>
              <Icon name="pencil-simple" />
              编辑端点
            </Button>
          </div>
        </header>

        <div className="provider-detail-content">
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
                  <Icon name="shield-check" />
                  {config.data?.hasApiKey ? "凭据已保存在本地" : "未保存 API Key"}
                </span>
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

export default IntegrationsPanel;
