/**
 * 设置 → 语音：语音 Agent 的 Rime 配置。
 *
 * 这些字段只在"配一次"的时候动，放在对话页上会让人每开一次页面就读到一堆
 * 下拉框，而真正每次都要看的东西（它在听吗、它说了什么）反而被挤下去。
 * 页面上的「语音」只负责说话，配置一律在设置里。
 */
import { useState } from "react";
import { toast } from "../../../shared/ui/toast";
import { Group, Input, Row, SecondaryButton, Select } from "../../../shared/ui/controls";
import { useVoiceConfig } from "../hooks/useVoiceConfig";

const MODEL_LABELS: Record<string, string> = {
  coda: "Coda · 旗舰，音质最好",
  mistv3: "Mist v3 · 最低延迟（37ms）",
};

const LANG_LABELS: Record<string, string> = {
  en: "英语 en",
  es: "西班牙语 es",
  fr: "法语 fr",
  de: "德语 de",
  it: "意大利语 it",
  pt: "葡萄牙语 pt",
  nl: "荷兰语 nl",
  ar: "阿拉伯语 ar",
  hi: "印地语 hi",
  ja: "日语 ja",
};

export function VoiceSettingsPage() {
  const { config, error, saveKey, updateConfig } = useVoiceConfig();
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const hasKey = config?.hasCredential ?? false;

  const submitKey = async () => {
    if (!keyDraft.trim()) return;
    setSaving(true);
    try {
      const saved = await saveKey(keyDraft);
      if (saved) {
        setKeyDraft("");
        toast.success("Rime key 已保存", { description: "落在 auth.json 的 rime 条目下。", showTimestamp: false });
      } else {
        toast.error("保存后仍然读不到密钥", { description: "检查一下 Pi 配置目录的写入权限。" });
      }
    } catch (cause) {
      toast.error("保存失败", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error ? <p className="mb-4 rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2 text-[12px] leading-relaxed text-red-400">{error}</p> : null}

      <Group title="凭据" description="TTS 和 STT 共用一把 key。密钥写进 auth.json，不落到 rime.json。">
        <Row
          anchorId="voice-key"
          label="Rime API Key"
          description={hasKey ? "已配置。粘贴新的会直接替换。" : "在 app.rime.ai → Tokens 创建。"}
        >
          <Input
            type="password"
            value={keyDraft}
            placeholder={hasKey ? "已配置" : "粘贴 Rime API Key"}
            onChange={(event) => setKeyDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitKey();
            }}
            className="max-w-52"
          />
          <SecondaryButton disabled={saving || !keyDraft.trim()} onClick={() => void submitKey()}>
            {saving ? "保存中" : "保存"}
          </SecondaryButton>
        </Row>
      </Group>

      <Group title="模型与音色" description="换模型会换端点（coda.api / mist.api），换音色下一句生效。">
        <Row anchorId="voice-model" label="模型" description="Coda 音质最好；Mist v3 首字延迟最低。">
          <Select
            label="模型"
            value={config?.model ?? "coda"}
            options={(config?.models ?? Object.keys(MODEL_LABELS)).map((model) => ({
              value: model,
              label: MODEL_LABELS[model] ?? model,
            }))}
            onChange={(value) => void updateConfig({ model: value })}
          />
        </Row>
        <Row anchorId="voice-speaker" label="音色" description="云端音色 id，例如 astra、luna，取自 Rime 的音色目录。">
          <Input
            defaultValue={config?.speaker ?? "astra"}
            onBlur={(event) => void updateConfig({ speaker: event.target.value })}
            className="max-w-52"
          />
        </Row>
      </Group>

      <Group title="语言" description="转写语言决定它听得懂什么，合成语言决定它用什么语言说。">
        <Row
          anchorId="voice-lang"
          label="合成语言"
          description="Rime 的十种语言里没有中文——这正是对话本身要说英文的原因。"
        >
          <Select
            label="合成语言"
            value={config?.lang ?? "en"}
            options={(config?.langs ?? Object.keys(LANG_LABELS)).map((lang) => ({
              value: lang,
              label: LANG_LABELS[lang] ?? lang,
            }))}
            onChange={(value) => void updateConfig({ lang: value })}
          />
        </Row>
        <Row anchorId="voice-stt-lang" label="转写语言" description="Rime STT 只支持这两种，且不自动识别，必须显式声明。">
          <Select
            label="转写语言"
            value={config?.sttLang ?? "en"}
            options={(config?.sttLangs ?? ["en", "es"]).map((lang) => ({
              value: lang,
              label: LANG_LABELS[lang] ?? lang,
            }))}
            onChange={(value) => void updateConfig({ sttLang: value })}
          />
        </Row>
      </Group>
    </>
  );
}
