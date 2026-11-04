import { Button, Input, Select, Toggle } from "../../shared/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProviderMark } from "../../components/ProviderLogo";
import { formatContextLength, modelDisplayName } from "../../lib/model-meta";
import type { ProviderModel, ProviderProfile } from "../../lib/rpc";
import { presets, type Preset } from "./presets";
import { apiTypes, type ProviderFormState } from "./provider-form";

const contextOptions = [32000, 64000, 128000, 200000, 256000, 400000, 512000, 1000000, 2000000].map(value => ({ value: String(value), label: `${formatContextLength(value)} · ${value.toLocaleString("en-US")} tokens` }));

function ProviderFieldLabel({ icon, children }: { icon: string; children: string }) {
  return <span className="provider-field-label"><Icon name={icon} />{children}</span>;
}

/** 新增 / 编辑 Provider 的对话框。纯表单：校验过的字段交给 `save` / `probe`。 */
export function ProviderEditorDialog({ open, onClose, editingProfileId, form, update, selected, conflict, busy, onSave, onProbe, onPreset }: {
  open: boolean;
  onClose: () => void;
  editingProfileId: string | null;
  form: ProviderFormState;
  update: (patch: Partial<ProviderFormState>) => void;
  selected?: ProviderProfile;
  conflict: boolean;
  busy: ProviderFormState["busy"];
  onSave: () => void;
  onProbe: () => void;
  onPreset: (preset: Preset) => void;
}) {
  const { provider, name, baseUrl, modelsUrl, api, apiKey, defaultModelId, authHeader, contextWindow, models } = form;
  const invalid = !!busy || !provider.trim() || !baseUrl.trim() || conflict;
  return (
    <Dialog open={open} onOpenChange={(next: boolean) => { if (!next) onClose(); }}>
      <DialogContent className="provider-editor-dialog">
        <DialogHeader><DialogTitle>{editingProfileId ? "编辑 Provider" : "新增 Provider"}</DialogTitle><DialogDescription>配置端点、模型与凭据。保存后会同步到 Pi。</DialogDescription></DialogHeader>
        <div className="provider-dialog-body">
          {!editingProfileId && <div className="provider-presets"><span>快速填入</span>{presets.map(preset => <Button key={preset.id} variant="outline" onClick={() => onPreset(preset)}><ProviderMark id={preset.id} />{preset.name}</Button>)}</div>}
          <div className="provider-dialog-grid">
            <label><ProviderFieldLabel icon="id-card">Provider ID</ProviderFieldLabel><Input value={provider} onChange={event => update({ provider: event.target.value })} placeholder="例如 my-gateway" aria-invalid={conflict} />{conflict && <small className="provider-field-error">该 ID 已存在，请选择已添加的 Provider。</small>}</label>
            <label><ProviderFieldLabel icon="file">显示名称</ProviderFieldLabel><Input value={name} onChange={event => update({ name: event.target.value })} placeholder="例如 Team Gateway" /></label>
            <label><ProviderFieldLabel icon="link">Base URL</ProviderFieldLabel><Input value={baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://example.com/v1" /></label>
            <label><ProviderFieldLabel icon="search">模型列表接口</ProviderFieldLabel><Input value={modelsUrl} onChange={event => update({ modelsUrl: event.target.value })} placeholder="留空则使用 Base URL/models" /></label>
            <label><ProviderFieldLabel icon="globe">API 类型</ProviderFieldLabel><Select label="API 类型" value={api} options={apiTypes.map(item => ({ value: item, label: item }))} onChange={value => update({ api: value as ProviderFormState["api"] })} /></label>
            <label><ProviderFieldLabel icon="cursor-magic-selection">默认模型</ProviderFieldLabel><Select label="默认模型目录" value={defaultModelId} options={[{ value: "", label: "保存后使用首个模型" }, ...models.map((model: ProviderModel) => ({ value: model.id, label: modelDisplayName(model) }))]} onChange={value => update({ defaultModelId: value })} /></label>
            <label><ProviderFieldLabel icon="id-card">模型 ID</ProviderFieldLabel><Input value={defaultModelId} onChange={event => update({ defaultModelId: event.target.value })} placeholder="也可手动输入模型 ID" spellCheck={false} /></label>
            <label><ProviderFieldLabel icon="file">回退上下文长度</ProviderFieldLabel><Select label="回退上下文长度" value={contextWindow} options={[{ value: "", label: "未设置（默认 128,000 tokens）" }, ...contextOptions, ...(contextWindow && !contextOptions.some(option => option.value === contextWindow) ? [{ value: contextWindow, label: `${Number(contextWindow).toLocaleString()} tokens` }] : [])]} onChange={value => update({ contextWindow: value })} /><small>接口未返回时使用；未设置时按 128,000 tokens。</small></label>
            <label><ProviderFieldLabel icon="key">API Key</ProviderFieldLabel><Input type="password" value={apiKey} onChange={event => update({ apiKey: event.target.value })} disabled={selected?.isOAuth} placeholder={selected?.isOAuth ? "已登录订阅，退出账户后才能改用 API Key" : selected?.hasApiKey ? "已保存，留空保持不变" : "输入服务商 API Key"} autoComplete="off" /></label>
          </div>
          <div className="provider-dialog-auth"><div><strong>发送认证请求头</strong><p>关闭后，模型服务请求不会附带 API Key。</p></div><Toggle label="发送 API 认证请求头" on={authHeader} onChange={value => update({ authHeader: value })} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button variant="outline" disabled={invalid} onClick={onProbe}>{busy === "probe" ? "正在查询…" : "测试连接"}</Button><Button variant="default" disabled={invalid} onClick={onSave}>{busy === "save" ? "正在保存并同步…" : "保存并同步"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
