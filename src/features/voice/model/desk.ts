/**
 * The mouth after Prism. Prism speaks inside a call; this says one sentence
 * when the call cannot, and reads the working session's last answer so the
 * handoff has something speakable. Nothing here opens a session.
 */
import type { Transcript } from "@/lib/protocol"
import { invoke } from "@/lib/native"
import { voiceCall } from "./call"

function messageText(content: { text?: string }[] | string | undefined) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => part.text ?? "").join("")
}

export function lastAssistantText(transcript: Transcript) {
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index]?.message
    if (message?.role !== "assistant") continue
    const text = messageText(message.content).trim()
    if (text) return text.slice(0, 800)
  }
  return ""
}

/** Only while the call is open and not paused. Hangup does not keep playing. */
export async function speakOut(sentence: string) {
  const text = sentence.trim()
  if (!text || !voiceCall.canSpeak()) return
  if (voiceCall.announce(text)) return
  if (!voiceCall.canSpeak()) return
  await playLocal(text)
}

let localAudio: HTMLAudioElement | null = null
let localToken = 0

export function stopLocalAudio() {
  localToken += 1
  const audio = localAudio
  localAudio = null
  if (!audio) return
  audio.pause()
  audio.src = ""
}

async function playLocal(text: string) {
  const token = localToken
  try {
    const spoken = await invoke<{ audioBase64: string }>("rime_speak", { text })
    if (token !== localToken || !voiceCall.canSpeak() || !spoken.audioBase64) return
    const audio = new Audio(`data:audio/mpeg;base64,${spoken.audioBase64}`)
    localAudio = audio
    await audio.play()
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error("播放失败"))
    })
  } catch {
    // A missed sentence is better than a second Pi session.
  } finally {
    if (token === localToken) localAudio = null
  }
}
