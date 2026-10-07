import { useEffect, useState } from "react";
import { toast as gooeyToast } from "../../shared/ui/toast";
import { useWorkspace } from "../../lib/store";
import {
  computerUseConfig,
  report,
  saveComputerUseCloudflareToken,
  saveComputerUseConfig,
  saveComputerUseKey,
  setComputerUseMode,
  testComputerUseDecision,
  type ComputerUseConfig,
  type ComputerUseModel,
} from "../../lib/rpc";
import { Button, Input, Select, Switch } from "../UI";
import { Icon } from "../Icon";
import { SettingsGroup, SettingRow } from "./GeneralSettingsPanel";

const MODEL_LABELS: Record<ComputerUseModel, string> = {
  jev: "Jev · TypeSafe",
  "clef-flash": "Clef-flash · Cloudflare（9B）",
};

function formatAnswer(answer: Record<string, unknown> | null): string {
  if (!answer) return "无回答";
  return Object.entries(answer)
    .map(([id, value]) => {
      const entry = value as { type?: string; noul?: number; choice?: string; score?: number } | null;
      if (entry?.type === "noul") return `${id}=是 ${(entry.noul ?? 0).toFixed(3)}`;
      if (entry?.type === "choice") return `${id}=${entry.choice ?? "?"}`;
      if (entry?.type === "score") return `${id}=${entry.score ?? "?"}`;
      return id;
    })
    .join(" · ");
}

export function ComputerUsePanel() {
  const desktop = useWorkspace(state => state.runtimeTarget === "desktop");
  const platform = useWorkspace(state => state.runtimePlatform);
  const online = useWorkspace(state => state.connection === "online");
  const running = useWorkspace(state => state.transcript.running);
  const enabled = useWorkspace(state => state.computerUseEnabled);
  const macos = platform === "macos";
  const [config, setConfig] = useState<ComputerUseConfig | null>(null);
  const [jevKey, setJevKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  async function reload() {
    try {
      const next = await computerUseConfig();
      setConfig(next);
      setAccountId(next.cloudflareAccountId);
      setBaseUrl(next.systemoneBaseUrl);
    } catch (error) { report(error); }
  }
  useEffect(() => { if (desktop) void reload(); }, [desktop]);

  async function patch(patchValue: Partial<Pick<ComputerUseConfig, "decisionModel" | "cloudflareAccountId" | "systemoneBaseUrl">>, label: string) {
    setBusy(label);
    try {
      const next = await saveComputerUseConfig(patchValue);
      setConfig(next);
      gooeyToast.success("已保存", { description: `${label} 已更新；重连项目后生效`, showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusy(null); }
  }

  async function saveJevKey(clear = false) {
    setBusy("jev");
    try {
      const status = await saveComputerUseKey(clear ? "" : jevKey);
      setConfig(current => current ? { ...current, keys: { ...current.keys, jev: status.hasKey } } : current);
      if (!clear) setJevKey("");
      gooeyToast.success(status.hasKey ? "Jev Key 已保存" : "Jev Key 已清除", { showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusy(null); }
  }

  async function saveCloudflareToken(clear = false) {
    setBusy("cloudflare");
    try {
      const status = await saveComputerUseCloudflareToken(clear ? "" : cloudflareToken);
      setConfig(current => current ? { ...current, keys: { ...current.keys, cloudflare: status.hasToken } } : current);
      if (!clear) setCloudflareToken("");
      gooeyToast.success(status.hasToken ? "Cloudflare Token 已保存" : "Cloudflare Token 已清除", { showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusy(null); }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const result = await testComputerUseDecision();
      const usage = result.usage ? ` · in ${result.usage.input_tokens ?? "?"} / out ${result.usage.output_tokens ?? "?"} tokens` : "";
      setTest({ ok: true, text: `${result.provider} ${result.model} · ${result.latencyMs}ms · ${formatAnswer(result.answer)}${usage}` });
      gooeyToast.success("决策模型可用", { description: `${result.model} · ${result.latencyMs}ms`, showTimestamp: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTest({ ok: false, text: message });
      gooeyToast.error("决策模型不可用", { description: message, showTimestamp: false });
    } finally { setTesting(false); }
  }

  const model = config?.decisionModel ?? "jev";
  const jevSelected = model === "jev";
  const keyReady = config ? (jevSelected ? config.keys.jev : config.keys.cloudflare) : false;

  return <>
    <div className="panel-heading"><div><h1><Icon name="desktop" />操作电脑</h1><p>Computer Use 使用的决策模型与凭据。Jev 与 Cloudflare Clef-flash 两套都保留，随时切换。</p></div></div>
    <SettingsGroup title="开关" icon="desktop" description="让当前 Pi 模型通过界面观察和点击桌面应用。有可靠 API 或 CLI 时不要用。">
      <SettingRow title="电脑操作" description={!desktop ? "电脑操作只能在运行 Pi 的电脑上使用。" : !macos ? "Computer Use 目前只支持 macOS；此平台功能已关闭。" : "由你手动打开。macOS 请在 系统设置 → 隐私与安全性 → 辅助功能 中允许「Orbit Agent」（列表里显示为「Orbit」，位于 ~/Library/Application Support/ai.pi.gui/runtime）。只需授权一次，之后更新 Orbit 不会失效；「Orbit Agent Dev」只属于 tauri dev。授权后完全退出 Orbit 再打开。"}>
        {desktop && macos ? <Switch aria-label="电脑操作" checked={enabled} disabled={!online || running} onChange={checked => void setComputerUseMode(checked).catch(report)} /> : <span className="remote-settings-note">{desktop ? "macOS 专用" : "电脑端设置"}</span>}
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="决策模型" icon="robot" description="每轮从当前界面的候选集中选择操作与目标。两套模型共用同一个 SystemOne 协议，其余逻辑完全一致。">
      <SettingRow title="使用模型" description={jevSelected ? "TypeSafe Jev，默认后端，与现有钥匙和评测一致。" : "Cloudflare 开源决策模型 Clef-flash，经 Workers AI 托管；协议与 Jev 兼容。"}>
        <Select aria-label="决策模型" value={model} disabled={busy !== null} onChange={event => void patch({ decisionModel: event.target.value as ComputerUseModel }, "决策模型")}>
          <option value="jev">{MODEL_LABELS.jev}</option>
          <option value="clef-flash">{MODEL_LABELS["clef-flash"]}</option>
        </Select>
      </SettingRow>
      <SettingRow title="连接测试" description={test ? test.text : "发一条真实的三选一决策请求，验证当前模型与凭据是否可用，并返回延迟与 token 用量。"}>
        <div className="settings-directory-actions">
          <span className="remote-settings-note">{keyReady ? "凭据就绪" : "缺少凭据"}</span>
          <Button variant="outline" disabled={!desktop || testing} onClick={() => void runTest()}>{testing ? "测试中…" : "测试连接"}</Button>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="凭据" icon="key" description="密钥只保存在这台电脑（~/.pi/agent），不会写入项目、前端或日志。">
      <SettingRow title="Jev API Key" description={config?.keys.jev ? "已保存。留空再保存可覆盖。" : "从 TypeSafe 控制台粘贴。"}>
        <div className="settings-directory-control">
          <Input type="password" value={jevKey} onChange={event => setJevKey(event.target.value)} placeholder={config?.keys.jev ? "已保存，留空再保存可覆盖" : "粘贴 TypeSafe API Key"} autoComplete="off" aria-label="Jev API Key" />
          <div className="settings-directory-actions">
            <Button variant="default" disabled={busy !== null || !jevKey.trim()} onClick={() => void saveJevKey()}>{busy === "jev" ? "保存中…" : "保存"}</Button>
            <Button variant="outline" disabled={busy !== null || !config?.keys.jev} onClick={() => void saveJevKey(true)}>清除</Button>
          </div>
        </div>
      </SettingRow>
      <SettingRow title="Cloudflare Account ID" description="Workers AI 所属账号的 Account ID，可在 Cloudflare 控制台右侧栏复制。">
        <div className="settings-directory-control">
          <Input value={accountId} onChange={event => setAccountId(event.target.value)} placeholder="32 位十六进制 Account ID" autoComplete="off" spellCheck={false} aria-label="Cloudflare Account ID" />
          <div className="settings-directory-actions"><Button variant="default" disabled={busy !== null || accountId.trim() === (config?.cloudflareAccountId ?? "")} onClick={() => void patch({ cloudflareAccountId: accountId }, "Cloudflare Account ID")}>{busy === "Cloudflare Account ID" ? "保存中…" : "保存"}</Button></div>
        </div>
      </SettingRow>
      <SettingRow title="Cloudflare API Token" description={config?.keys.cloudflare ? "已保存。需要一个拥有 Workers AI 权限的 Token。" : "新建一个拥有 Workers AI 权限的 Token 并粘贴。"}>
        <div className="settings-directory-control">
          <Input type="password" value={cloudflareToken} onChange={event => setCloudflareToken(event.target.value)} placeholder={config?.keys.cloudflare ? "已保存，留空再保存可覆盖" : "粘贴 Cloudflare API Token"} autoComplete="off" aria-label="Cloudflare API Token" />
          <div className="settings-directory-actions">
            <Button variant="default" disabled={busy !== null || !cloudflareToken.trim()} onClick={() => void saveCloudflareToken()}>{busy === "cloudflare" ? "保存中…" : "保存"}</Button>
            <Button variant="outline" disabled={busy !== null || !config?.keys.cloudflare} onClick={() => void saveCloudflareToken(true)}>清除</Button>
          </div>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="高级" icon="sliders-horizontal" description="仅在选择 Jev 时生效。留空使用官方 https://api.typesafe.ai。">
      <SettingRow title="SystemOne Base URL" description="自建或代理的 SystemOne 兼容端点。Cloudflare Clef 由内置适配器直连 Workers AI，不需要填写。">
        <div className="settings-directory-control">
          <Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.typesafe.ai" autoComplete="off" spellCheck={false} aria-label="SystemOne Base URL" />
          <div className="settings-directory-actions"><Button variant="default" disabled={busy !== null || baseUrl.trim() === (config?.systemoneBaseUrl ?? "")} onClick={() => void patch({ systemoneBaseUrl: baseUrl }, "SystemOne Base URL")}>{busy === "SystemOne Base URL" ? "保存中…" : "保存"}</Button></div>
        </div>
      </SettingRow>
    </SettingsGroup>
  </>;
}
