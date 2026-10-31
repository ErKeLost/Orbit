import { useSyncExternalStore } from "react";
import { useWorkspace } from "@/lib/store";
import { voiceController } from "../model/voice-controller";
import { useVoiceConfig } from "./useVoiceConfig";
export type { VoiceState, VoiceLogItem } from "../model/voice-controller";

/** React projects the application-owned call. Rendering never owns audio or session lifecycle. */
export function useVoiceAgent() {
  const snapshot = useSyncExternalStore(voiceController.subscribe, voiceController.getSnapshot);
  const { config, error, saveKey, updateConfig } = useVoiceConfig();
  const online = useWorkspace(state => state.connection === "online");
  return { ...snapshot, error: snapshot.error ?? error, config, online, runningTools: [],
    start: () => voiceController.start(), stop: voiceController.stop, interrupt: voiceController.interrupt,
    setDeviceId: voiceController.setDeviceId,
    diagnostics: voiceController.diagnostics, clearError: voiceController.clearError, saveKey, updateConfig };
}
