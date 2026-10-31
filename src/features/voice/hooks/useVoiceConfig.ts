/**
 * Rime 配置的读取与写回。
 *
 * 单独一个 hook，是因为它有两个消费者：设置页负责改，对话页只读（显示用的是哪个模型）。
 * 配置的真相在 `rime.json` + `auth.json`，这里只是一份投影，改完就刷新。
 */
import { useCallback, useEffect, useState } from "react";
import { rimeConfig, saveRimeApiKey, saveRimeConfig, type RimeConfig } from "../../../lib/rpc-projects";
import { resolveVoiceConfig } from "../model/voice-config";

export function useVoiceConfig() {
  const [config, setConfig] = useState<RimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setConfig(resolveVoiceConfig(await rimeConfig()));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 存 key 只是写 auth.json；`hasCredential` 由后端重新读一遍再回给页面。 */
  const saveKey = useCallback(async (key: string) => {
    const result = await saveRimeApiKey(key.trim() || null);
    setConfig((current) => (current ? { ...current, hasCredential: result.hasCredential } : current));
    return result.hasCredential;
  }, []);

  const updateConfig = useCallback(async (patch: Partial<RimeConfig>) => {
    const next = await saveRimeConfig(patch);
    setConfig(resolveVoiceConfig(next));
  }, []);

  return { config, error, reload, saveKey, updateConfig, clearError: () => setError(null) };
}
