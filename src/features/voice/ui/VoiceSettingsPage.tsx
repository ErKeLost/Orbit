/**
 * 设置 → 语音。
 *
 * 通话本身没有可调的音频参数了：断句、打断、语速、音色全在 ElevenLabs 那边，
 * 音色绑在 Speech Engine 资源上。这里只剩两件真正属于本机的事——
 * 那把 API Key，和 Pi 那边的服务端地址（engine id）。
 */
import { useEffect, useState } from "react";
import { toast } from "../../../shared/ui/toast";
import { Group, Input, Row, SecondaryButton } from "../../../shared/ui/controls";
import {
  saveSpeechEngineApiKey,
  saveSpeechEngineConfig,
  speechEngineCheck,
  speechEngineConfig,
  type SpeechEngineCheck,
  type SpeechEngineConfig,
} from "@/lib/rpc-projects";

export function VoiceSettingsPage() {
  const [config, setConfig] = useState<SpeechEngineConfig | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [engineDraft, setEngineDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<SpeechEngineCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void speechEngineConfig()
      .then(value => {
        if (!live) return;
        setConfig(value);
        setEngineDraft(value.engineId);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || saving) return;
    setSaving(true);
    try {
      const result = await saveSpeechEngineApiKey(key);
      setConfig(current => (current ? { ...current, hasCredential: result.hasCredential } : current));
      setKeyDraft("");
      toast.success("已保存 ElevenLabs API Key");
    } catch (cause) {
      toast.error("保存密钥失败", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  const saveEngine = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await saveSpeechEngineConfig({ engineId: engineDraft.trim() || null });
      setConfig(next);
      setEngineDraft(next.engineId);
      toast.success("已保存 Speech Engine");
    } catch (cause) {
      toast.error("保存 Speech Engine 失败", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setReport(null);
    try {
      setReport(await speechEngineCheck());
    } catch (cause) {
      toast.error("检查失败", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setChecking(false);
    }
  };

  const hasKey = config?.hasCredential ?? false;
  const remaining = report && typeof report.characterLimit === "number" && typeof report.characterCount === "number"
    ? `${Math.max(0, report.characterLimit - report.characterCount).toLocaleString()} / ${report.characterLimit.toLocaleString()}`
    : null;

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-xs text-negative">{error}</p> : null}

      <Group title="凭据" description="API Key 存在 Pi 的 auth.json 里，只在后端使用，页面拿不到它。">
        <Row anchorId="voice-key" label="ElevenLabs API Key" description={hasKey ? "已保存。填新的会覆盖。" : "还没有保存，语音页会拒绝开麦。"}>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={hasKey ? "•••••••• 已保存" : "sk_…"}
              value={keyDraft}
              onChange={event => setKeyDraft(event.target.value)}
            />
            <SecondaryButton disabled={!keyDraft.trim() || saving} onClick={() => void saveKey()}>
              保存
            </SecondaryButton>
          </div>
        </Row>
        <Row
          anchorId="voice-engine"
          label="Speech Engine ID"
          description="dashboard 里没有创建界面，用 tools/speech-engine 的 create-engine 生成 seng_… 后填这里。语音链路是：浏览器 ↔ ElevenLabs ↔ 本机 127.0.0.1 的 speech-engine 服务。"
        >
          <div className="flex items-center gap-2">
            <Input placeholder="seng_…" value={engineDraft} onChange={event => setEngineDraft(event.target.value)} />
            <SecondaryButton disabled={saving || engineDraft.trim() === (config?.engineId ?? "")} onClick={() => void saveEngine()}>
              保存
            </SecondaryButton>
          </div>
        </Row>
      </Group>

      <Group title="连接检查" description="只读一次账户信息：确认 Key 有效，并看免费额度还剩多少。">
        <Row anchorId="voice-check" label="账户与额度" description={remaining ? `剩余 ${remaining} 字符（${report?.tier ?? "?"} 计划）` : "免费计划约 1 万字符/月，通话按分钟消耗积分。"}>
          <SecondaryButton disabled={!hasKey || checking} onClick={() => void check()}>
            {checking ? "检查中…" : "检查"}
          </SecondaryButton>
        </Row>
      </Group>

      <Group title="服务端" description="Pi 那一端不在这个应用里：ElevenLabs 从云端连接到 tools/speech-engine，每次通话起一个独立的 pi --mode rpc 进程。">
        <Row label="启动方式" description="bun run start（需要 ELEVENLABS_API_KEY、SPEECH_ENGINE_ID、PI_CWD），再用 ngrok/cloudflared 把 3001 端口暴露成 wss://。">
          <code className="text-xs text-ink-3">tools/speech-engine</code>
        </Row>
      </Group>
    </div>
  );
}
