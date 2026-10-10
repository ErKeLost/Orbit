import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";
import { Button, Input } from "./UI";
import { Icon } from "./Icon";
import { report } from "../lib/rpc";
import { saveImageApiKey, saveImageConfig, type ImageConfig } from "../lib/rpc";
import { toast } from "../shared/ui/toast";

/**
 * The image-generation endpoint.
 *
 * The image tool cannot read a provider out of Pi's own config: `models.json`
 * has no way to say a model generates images (its model schema has no `type`
 * discriminant), so the endpoint, its models and their presets are this file
 * instead — merged over the built-in Ark defaults by `gui-extension.ts`, and
 * validated by `src-tauri/src/image_config.rs`.
 *
 * Two things this form has to be honest about:
 *
 * * **Empty means built-in.** Every field may be left blank, and a blank field
 *   keeps the default rather than clearing anything, which is what makes an
 *   unconfigured install work.
 * * **Saving is not applying.** The extension reads this file when it registers
 *   itself, so a change needs the project reconnected — said out loud in the
 *   dialog rather than left to be discovered.
 */
export function ImageEndpointDialog({
  open,
  onOpenChange,
  config,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config?: ImageConfig;
  onSaved: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const hasApiKey = config?.hasApiKey ?? false;

  // Reopening starts from what is stored, so a cancelled edit is not remembered.
  useEffect(() => {
    if (!open) return;
    setId(config?.provider?.id ?? "");
    setName(config?.provider?.name ?? "");
    setBaseUrl(config?.provider?.baseUrl ?? "");
    setModels((config?.models ?? []).map((model) => ({ id: model.id, name: model.name ?? "" })));
    setApiKey("");
  }, [open, config]);

  const providerId = id.trim() || config?.defaultProviderId || "";
  async function save() {
    setBusy("save");
    try {
      // A blank field is sent as an explicit `null` only where clearing is the
      // intent — the models list, which otherwise has no way back to the
      // built-in set. Everything else stays absent, which keeps what is stored.
      const cleaned = models.map((model) => ({ id: model.id.trim(), name: model.name.trim() || undefined })).filter((model) => model.id);
      await saveImageConfig({
        provider: id.trim() ? { id: id.trim(), name: name.trim() || undefined, baseUrl: baseUrl.trim() || undefined } : null,
        models: cleaned.length ? cleaned : null,
      });
      if (apiKey.trim()) await saveImageApiKey(providerId, apiKey.trim());
      onSaved();
      toast.success("出图端点已保存", { description: "重连项目后生效", showTimestamp: false });
      onOpenChange(false);
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }

  async function clearKey() {
    setBusy("key");
    try {
      await saveImageApiKey(providerId, null);
      onSaved();
      toast.success("已清除该 Provider 的密钥", { showTimestamp: false });
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="provider-editor-dialog">
        <DialogHeader>
          <DialogTitle>出图端点</DialogTitle>
          <DialogDescription>
            generate_image 请求的地址、模型与凭据。留空使用内置的火山方舟；密钥存放在 Pi 的 auth.json，不写入这个配置文件。
          </DialogDescription>
        </DialogHeader>
        <div className="provider-dialog-body">
          <div className="provider-dialog-grid">
            <label>
              Provider ID
              <Input aria-label="Provider ID" value={id} onChange={(event) => setId(event.target.value)} placeholder={config?.defaultProviderId ?? "volcengine"} spellCheck={false} />
            </label>
            <label>
              显示名称
              <Input aria-label="显示名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="火山方舟" />
            </label>
            <label>
              Base URL
              <Input aria-label="Base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://ark.cn-beijing.volces.com/api/v3" spellCheck={false} />
            </label>
            <label>
              API Key
              <Input
                aria-label="API Key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={hasApiKey ? "已保存，留空不改变" : "尚未设置"}
                spellCheck={false}
              />
            </label>
          </div>
          <div className="provider-dialog-models">
            <div className="provider-dialog-models-head">
              <span>模型（留空使用内置列表）</span>
              <Button variant="outline" onClick={() => setModels((current) => [...current, { id: "", name: "" }])}>
                <Icon name="plus" />添加模型
              </Button>
            </div>
            {models.map((model, index) => (
              <div className="provider-dialog-model-row" key={index}>
                <Input
                  aria-label={`模型 ${index + 1} ID`}
                  value={model.id}
                  onChange={(event) => setModels((current) => current.map((item, at) => (at === index ? { ...item, id: event.target.value } : item)))}
                  placeholder="doubao-seedream-5-0-flash-260915"
                  spellCheck={false}
                />
                <Input
                  aria-label={`模型 ${index + 1} 名称`}
                  value={model.name}
                  onChange={(event) => setModels((current) => current.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)))}
                  placeholder="显示名称（可选）"
                />
                <Button variant="ghost" aria-label={`移除模型 ${index + 1}`} onClick={() => setModels((current) => current.filter((_, at) => at !== index))}>
                  <Icon name="trash" />
                </Button>
              </div>
            ))}
            {!models.length && <p className="provider-dialog-models-empty">当前使用内置模型列表。</p>}
          </div>
        </div>
        <DialogFooter>
          {hasApiKey && (
            <Button variant="ghost" disabled={busy !== null} onClick={() => void clearKey()}>
              清除密钥
            </Button>
          )}
          <Button variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="default" disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
