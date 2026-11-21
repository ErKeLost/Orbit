/**
 * 设置 → 语音。
 *
 * 断句、打断、闲聊、出声都在 Rime Prism。这里只留那把 Key。
 * Jev 只判这句要不要交给桌面上正在用的会话。
 */
import { useEffect, useState } from "react";
import { toast } from "../../../shared/ui/toast";
import { Group, Input, Row, SecondaryButton } from "../../../shared/ui/controls";
import { invoke } from "@/lib/native";

export function VoiceSettingsPage() {
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void invoke<{ hasCredential?: boolean }>("rime_config")
      .then(value => { if (live) setHasKey(value.hasCredential === true) })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) });
    return () => { live = false };
  }, []);

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || saving) return;
    setSaving(true);
    try {
      const result = await invoke<{ hasCredential?: boolean }>("save_rime_api_key", { apiKey: key });
      setHasKey(result.hasCredential === true);
      setKeyDraft("");
      toast.success("已保存 Rime API Key");
    } catch (cause) {
      toast.error("保存密钥失败", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-xs text-negative">{error}</p> : null}

      <Group title="凭据" description="API Key 存在 Pi 的 auth.json 里，只在后端使用，页面拿不到它。">
        <Row anchorId="voice-key" label="Rime API Key" description={hasKey ? "已保存。填新的会覆盖。" : "还没有保存，语音页会拒绝开麦。"}>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={hasKey ? "•••••••• 已保存" : "rime_…"}
              value={keyDraft}
              onChange={event => setKeyDraft(event.target.value)}
            />
            <SecondaryButton disabled={!keyDraft.trim() || saving} onClick={() => void saveKey()}>
              保存
            </SecondaryButton>
          </div>
        </Row>
      </Group>

      <Group title="这一通怎么走" description="麦、断句、打断、闲聊、出声都是 Rime Prism。Jev 只回答一件事：这句要不要交给桌面上正在用的那条会话。不够把握就不交。">
        <Row label="语言" description="Prism 现在只说英语，听也只按英语。中文说进去它不会按中文回。这是他们现在的边界，不是这边还能补的。" />
        <Row label="音色" description="通话用 aurora。挂断之后的一句播报用 Coda 的 celeste，同一把 Key。" />
      </Group>
    </div>
  );
}
