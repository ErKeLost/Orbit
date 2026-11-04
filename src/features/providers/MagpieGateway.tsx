import { useState } from "react";
import { Button, Input } from "../../shared/ui/controls";
import { connectMagpie, magpieStatus, report, type MagpieStatus, type ProviderProfile } from "../../lib/rpc";
import { toast } from "../../shared/ui/toast";

export function MagpieGateway({ profile, onChanged, disabled }: { profile?: ProviderProfile; onChanged: () => void; disabled: boolean }) {
  const [root, setRoot] = useState(profile?.baseUrl?.replace(/\/v1\/?$/, "") ?? "http://127.0.0.1:3425");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<MagpieStatus | null>(null);
  const [error, setError] = useState("");
  async function run(connect: boolean) {
    setBusy(true); setError("");
    try {
      if (connect) {
        const result = await connectMagpie(root, apiKey);
        setApiKey(""); onChanged();
        toast.success(`Magpie 已连接 · ${result.synced.count} 个模型`, { showTimestamp: false });
      }
      setStatus(await magpieStatus(root, connect ? undefined : apiKey));
    } catch (failure) { setStatus(null); setError(String(failure)); report(failure); }
    finally { setBusy(false); }
  }
  return <section className="provider-card provider-magpie">
    <header className="provider-card-head"><div><h3>Magpie 网关</h3><p>连接已运行的 Magpie，使用 Antigravity、Gemini CLI、多账户与路由组。</p></div><a href="https://github.com/yetone/magpie" target="_blank" rel="noreferrer">安装与账户管理 ↗</a></header>
    <div className="provider-gateway-form">
      <label>网关地址<Input aria-label="Magpie 网关地址" value={root} onChange={event => { setRoot(event.target.value); setStatus(null); }} placeholder="http://127.0.0.1:3425" spellCheck={false} /></label>
      <label>网关 API Key<Input aria-label="Magpie API Key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={profile?.hasApiKey ? "已保存，留空保持不变" : "本机默认无需填写"} /></label>
      <div className="provider-detail-actions"><Button variant="outline" disabled={busy || !root.trim()} onClick={() => void run(false)}>检查连接与额度</Button><Button variant="default" disabled={disabled || busy || !root.trim()} onClick={() => void run(true)}>{busy ? "处理中…" : profile ? "同步网关模型" : "连接 Magpie"}</Button></div>
    </div>
    {status && <div className="provider-gateway-status" aria-live="polite"><p>已连接 · {status.modelCount} 个模型</p>
      {status.quotas.data?.map((account, index) => <div className="provider-quota" key={`${account.provider}-${account.name}-${index}`}>
        <strong>{account.name || account.provider || "订阅账户"}{account.plan ? ` · ${account.plan}` : ""}</strong>
        {account.error ? <small>{account.error}</small> : account.windows?.map((window, i) => {
          const remaining = typeof window.remaining === "number" ? window.remaining : typeof window.used === "number" ? 100 - window.used : undefined;
          return <div className="provider-quota-window" key={i}><span>{window.name || "额度"}</span>{remaining !== undefined && <meter min={0} max={100} value={Math.max(0, Math.min(100, remaining))} aria-label={`${window.name || "额度"}剩余`} />}<span>{window.display || (remaining === undefined ? "未报告" : `剩余 ${Math.round(remaining)}%`)}</span>{window.resetsAt && <small>重置于 {new Date(window.resetsAt).toLocaleString()}</small>}</div>;
        })}
      </div>)}
      {status.quotas.error && <small>网关未提供额度：{status.quotas.error}</small>}
    </div>}
    {error && <p role="alert" className="provider-field-error">{error}</p>}
  </section>;
}
