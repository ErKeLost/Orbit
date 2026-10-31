/**
 * 设置 → 语音：语音 Agent 的 Rime 配置。
 *
 * 这些字段只在"配一次"的时候动，放在对话页上会让人每开一次页面就读到一堆
 * 下拉框，而真正每次都要看的东西（它在听吗、它说了什么）反而被挤下去。
 * 页面上的「语音」只负责说话，配置一律在设置里。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "../../../shared/ui/toast";
import { Group, Input, Row, SecondaryButton, Select, TextArea } from "../../../shared/ui/controls";
import { useVoiceConfig } from "../hooks/useVoiceConfig";
import { rimeCheck, rimeVoices, type RimeVoice, type RimeConfig, type RimeServiceCheck } from "@/lib/rpc-projects";
import { rimeErrorMessage } from "@/lib/rime-error";
import { useVoicePreview } from "../hooks/useVoicePreview";
import { voiceController } from "../model/voice-controller";

const MODEL_LABELS: Record<string, string> = {
  coda: "Coda · 旗舰，音质最好",
  mistv3: "Mist v3 · 优先响应速度",
};

const LANG_LABELS: Record<string, string> = {
  en: "英语 en",
  es: "西班牙语 es",
};

export function VoiceSettingsPage() {
  const { config, error, saveKey, updateConfig } = useVoiceConfig();
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const hasKey = config?.hasCredential ?? false;
  const [voices, setVoices] = useState<RimeVoice[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [changingVoice, setChangingVoice] = useState(false);
  const model = config?.model ?? "coda";
  const language = config?.spokenLang ?? "en";
  const call = useSyncExternalStore(voiceController.subscribe, voiceController.getSnapshot);
  const callActive = call.starting || call.state !== "off";
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<{stt:RimeServiceCheck;tts:RimeServiceCheck} | null>(null);
  const settingsKey = JSON.stringify(config);
  const preview = useVoicePreview(settingsKey, message => toast.error("试听失败", {description:message}));
  const checkGeneration = useRef(0);
  useEffect(() => {
    checkGeneration.current++; setReport(null); setChecking(false);
    return () => { checkGeneration.current++; };
  }, [settingsKey]);
  const saveSettings = async (patch: Partial<RimeConfig>) => {
    try { await updateConfig(patch); }
    catch (cause) { toast.error("语音设置保存失败", {description:rimeErrorMessage(cause)}); }
  };
  const checkConnection = async () => {
    if (checking || callActive) return;
    const generation = ++checkGeneration.current;
    setChecking(true); setReport(null);
    try { const result = await rimeCheck(); if (generation === checkGeneration.current) setReport(result); }
    catch (cause) { if (generation === checkGeneration.current) toast.error("连接检查失败", {description:rimeErrorMessage(cause)}); }
    finally { if (generation === checkGeneration.current) setChecking(false); }
  };

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true); setCatalogError(null); setVoices([]);
    void rimeVoices(model, language).then(result => { if (!cancelled) setVoices(result.voices); }).catch(cause => {
      if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [model, language]);

  const chooseEngine = async (patch: Partial<RimeConfig>) => {
    if (changingVoice) return;
    setChangingVoice(true);
    try {
      const nextModel = patch.model ?? model, nextLanguage = patch.spokenLang ?? language;
      const result = await rimeVoices(nextModel, nextLanguage);
      const speaker = result.voices.find(voice => voice.speaker === config?.speaker)?.speaker ?? result.voices[0]?.speaker;
      if (!speaker) throw new Error("Rime 音色目录中没有这个模型和语言的可用音色");
      await updateConfig({ ...patch, speaker, spokenLang: nextLanguage, lang: nextLanguage, sttLang: nextLanguage });
    } catch (cause) { toast.error("更新语音设置失败", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setChangingVoice(false); }
  };

  const submitKey = async () => {
    if (!keyDraft.trim()) return;
    setSaving(true);
    try {
      const saved = await saveKey(keyDraft);
      if (saved) {
        setKeyDraft("");
        toast.success("Rime key 已保存", { description: "已保存。可以检查识别和合成服务的连接。", showTimestamp: false });
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

      <Group title="实时对话" description="识别和合成统一使用 Rime。每次开麦创建独立会话，可以发任务、问进度或旁观已有任务。">
        <Row label="对话语言" description="Rime 识别目前支持英语和西班牙语，不支持中文，也不会自动识别语言。">
          <Select label="对话语言" value={language} disabled={!config || changingVoice || checking} options={Object.entries(LANG_LABELS).map(([value,label])=>({value,label}))} onChange={spokenLang=>void chooseEngine({spokenLang})} />
        </Row>
        <Row label="断句等待" description="说完后等待的静音毫秒数。更短更快，更长更适合句中停顿；默认 450ms。">
          <Input key={config?.endpointMs ?? 450} type="number" min={200} max={1200} step={50} defaultValue={config?.endpointMs ?? 450} onBlur={event=>{const endpointMs=Number(event.target.value);if(Number.isInteger(endpointMs)&&endpointMs>=200&&endpointMs<=1200)void saveSettings({endpointMs})}} className="max-w-24" />
        </Row>
        <Row label="意图判断" description="由 Jev / Clef 判断发布任务、询问进度和对话；需要执行的工作交给 Pi。" />
      </Group>

      <Group title="凭据" description="Rime 语音识别与合成共用这把 Key。意图判断继续使用 Jev / Clef 的配置。">
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
        <Row anchorId="voice-check" label="服务连接" description="分别检查识别与合成是否接受当前配置。检查不上传录音或合成语音，耗时包含网络握手。">
          <SecondaryButton disabled={!hasKey || checking || callActive || preview.playing || saving} onClick={()=>void checkConnection()}>{checking ? "检查中…" : "检查连接"}</SecondaryButton>
        </Row>
        {report ? <div role="status" className="space-y-2 px-1 pb-3 text-[12px] leading-relaxed text-content/65">
          {([['stt','语音识别'],['tts','语音合成']] as const).map(([key,label])=>{
            const service = report[key];
            return <p key={key} className={service.ok ? "text-emerald-500" : "text-red-400"}>{label}：{service.ok ? `连接正常 · ${service.latencyMs}ms` : rimeErrorMessage(service.error ?? "检查失败")}</p>;
          })}
        </div> : null}
      </Group>

      <Group title="模型与音色" description="音色来自 Rime 官方实时目录，按当前模型和对话语言筛选。更改后在下次通话生效。">
        <Row anchorId="voice-model" label="模型" description="Coda 音质最好；Mist v3 首字延迟最低。">
          <Select
            label="模型"
            value={config?.model ?? "coda"}
            options={(config?.models ?? Object.keys(MODEL_LABELS)).map((model) => ({
              value: model,
              label: MODEL_LABELS[model] ?? model,
            }))}
            disabled={!config || changingVoice || checking}
            onChange={(value) => void chooseEngine({ model: value })}
          />
        </Row>
        <Row anchorId="voice-speaker" label="音色" description={catalogError ?? (catalogLoading ? "正在读取 Rime 音色目录…" : voices.find(voice=>voice.speaker===config?.speaker)?.description ?? "选择适合当前语言的音色。") }>
          <Select label="音色" value={config?.speaker ?? "astra"} disabled={catalogLoading || changingVoice || checking || !voices.length} options={voices.map(voice=>({value:voice.speaker,label:`${voice.speaker}${voice.country ? ` · ${voice.country}` : ""}${voice.flagship ? " · 推荐" : ""}`}))} onChange={speaker=>void saveSettings({speaker})} />
        </Row>
        <Row label="试听音色" description={preview.firstAudioMs === null ? "使用当前音色和语速试听一句话。" : `本次试听首音 ${preview.firstAudioMs}ms，包含设备准备及网络等待。`}>
          <SecondaryButton disabled={!hasKey || changingVoice || checking || callActive} onClick={()=>preview.playing ? preview.stop() : void preview.play(language === "es" ? "Hola, estoy listo para ayudarte con tus tareas." : "Hello, I'm ready to help with your tasks.")}>{preview.playing ? "停止试听" : "试听"}</SecondaryButton>
        </Row>
        <Row label="语速" description="调整整段语音的速度；不改变音高。">
          <Select label="语速" value={String(config?.timeScaleFactor ?? 1)} options={[{value:"1.2",label:"舒缓"},{value:"1",label:"自然"},{value:"0.85",label:"稍快"},{value:"0.7",label:"快速"}]} onChange={value=>void saveSettings({timeScaleFactor:Number(value)})} />
        </Row>
        {model === "coda" ? <Row label="流式前瞻" description="较多前瞻可以改善首句韵律，也会增加首音等待；实时对话默认不等待。">
          <Select label="流式前瞻" value={String(config?.textLookaheadTokens ?? 0)} options={[{value:"0",label:"最快响应"},{value:"8",label:"少量前瞻"},{value:"16",label:"优先韵律"}]} onChange={value=>void saveSettings({textLookaheadTokens:Number(value)})} />
        </Row> : null}
      </Group>

      {model === "coda" ? <Group title="自定义发音" description="为人名、项目名和专业术语指定读法。词典仅用于 Coda；切换 Mist 时保留配置，但不发送。">
        <Row anchorId="voice-lexicon" label="发音词典" description="每行填写：词语 = X-SAMPA 音标。音标之间用空格分隔；最多 500 项，编码后最多 60 KiB。">
          <TextArea aria-label="发音词典" key={JSON.stringify(config?.customLexicon ?? [])} rows={4} defaultValue={config?.customLexicon?.map(entry=>`${entry.spelling} = ${entry.pronunciation}`).join("\n") ?? ""} placeholder="词语 = 音标" className="max-w-80" onBlur={event=>{
            try {
              const customLexicon = event.target.value.split("\n").map(line=>line.trim()).filter(Boolean).map((line,index)=>{
                const separator = line.indexOf("=");
                if(separator < 1 || !line.slice(separator+1).trim()) throw new Error(`第 ${index+1} 行需要词语和音标，以 = 分隔`);
                return {spelling:line.slice(0,separator).trim(),pronunciation:line.slice(separator+1).trim()};
              });
              void updateConfig({customLexicon}).catch(cause=>toast.error("发音词典保存失败",{description:rimeErrorMessage(cause)}));
            } catch(cause) { toast.error("发音词典格式错误",{description:rimeErrorMessage(cause)}); }
          }} />
        </Row>
      </Group> : null}

      <Group title="识别优化" description="关键词提示帮助 Rime 识别人名、项目名和专业术语；提示不保证命中。">
        <Row label="转写方式" description="整理文本适合对话；逐字转写保留更多重复、停顿和读出的数字。">
          <Select label="转写方式" value={config?.sttMode ?? "written"} options={[{value:"written",label:"整理文本"},{value:"verbatim",label:"逐字转写"}]} onChange={value=>void saveSettings({sttMode:value as "written"|"verbatim"})} />
        </Row>
        <Row label="识别关键词" description="用英文逗号分隔；总长度最多 1024 UTF-8 字节。">
          <Input key={config?.contextTerms?.join(",")} defaultValue={config?.contextTerms?.join(", ") ?? ""} placeholder="输入项目名或专业术语" onBlur={event=>{const contextTerms=event.target.value.split(",").map(term=>term.trim()).filter(Boolean);void updateConfig({contextTerms}).catch(cause=>toast.error("关键词保存失败",{description:cause instanceof Error?cause.message:String(cause)}));}} className="max-w-64" />
        </Row>
      </Group>
    </>
  );
}
