/**
 * Low-latency Speech Engine settings.
 *
 * Eleven Realtime v1 Mini/Max cannot be attached to a Speech Engine or any custom
 * LLM. Pi has to stay on this path: WebRTC in the page, scribe_realtime for ASR,
 * a flash TTS model, and eager turn-taking. See
 * https://elevenlabs.io/docs/eleven-agents/customization/realtime-models
 */
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js"

const CLIENT_EVENTS = [
  "conversation_initiation_metadata",
  "asr_initiation_metadata",
  "ping",
  "audio",
  "interruption",
  "user_transcript",
  "tentative_user_transcript",
  "agent_response",
  "agent_response_correction",
  "vad_score",
  "agent_chat_response_part",
  "client_error",
  "agent_response_complete",
] as const

export function wsUrlFrom(publicUrl: string) {
  return `${publicUrl.replace(/^http/, "ws").replace(/\/$/, "")}${process.env.WS_PATH ?? "/ws"}`
}

function numberEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function keywordsOf(current: string[] | undefined) {
  const extra = (process.env.SPEECH_KEYWORDS ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
  return [...new Set([...(current ?? []), ...extra])]
}

export function realtimeEngineConfig(wsUrl: string, current?: { tts?: { voiceId?: string }; asr?: { keywords?: string[] } }) {
  const modelId = (process.env.SPEECH_TTS_MODEL ?? "eleven_flash_v2_5") as ElevenLabs.TtsConversationalModel
  const language = process.env.SPEECH_LANGUAGE?.trim()
  const keywords = keywordsOf(current?.asr?.keywords)
  return {
    speechEngine: { wsUrl, requestHeaders: {} },
    // Unset means: do not pin a language. The call follows whatever is spoken.
    ...(language ? { language } : {}),
    asr: {
      provider: "scribe_realtime" as const,
      ...(keywords.length ? { keywords } : {}),
    },
    tts: {
      modelId,
      ...(current?.tts?.voiceId ? { voiceId: current.tts.voiceId } : {}),
      // Flash is not a v3 model; expressive tags only add work before the first sound.
      expressiveMode: false,
    },
    turn: {
      // Eager takes the turn at the first natural pause. speculativeTurn would
      // start a tool-using Pi run on speech that is not a finished utterance.
      turnEagerness: "eager" as const,
      turnTimeout: numberEnv("SPEECH_TURN_TIMEOUT", 8, 1, 30),
      speculativeTurn: false,
    },
    conversation: {
      maxDurationSeconds: numberEnv("SPEECH_MAX_SECONDS", 3600, 60, 7200),
      clientEvents: [...CLIENT_EVENTS],
    },
    // The page already mints a WebRTC token. Require it, so a leaked seng_ id is not enough.
    auth: { enableAuth: true },
    privacy: {
      recordVoice: false,
      deleteAudio: true,
      retentionDays: 1,
    },
    // Handshake budget for the tunnel, not the Pi first-token budget. 2–15s.
    cascadeTimeoutSeconds: numberEnv("SPEECH_CASCADE_TIMEOUT", 8, 2, 15),
  }
}
