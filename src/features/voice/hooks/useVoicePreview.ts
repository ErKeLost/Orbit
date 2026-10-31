import { useCallback, useEffect, useRef, useState } from "react"
import { SpeechOutput } from "../model/speech-output"

/** A short preview uses the same streaming decoder as calls, without a Pi session. */
export function useVoicePreview(settingsKey: string, onError: (message: string) => void) {
  const output = useRef<SpeechOutput | null>(null)
  const [playing, setPlaying] = useState(false)
  const [firstAudioMs, setFirstAudioMs] = useState<number | null>(null)
  const stop = useCallback(() => {
    const previous = output.current; output.current = null
    previous?.dispose(); setPlaying(false)
  }, [])
  useEffect(() => {
    return stop
  }, [settingsKey, stop])
  const play = useCallback(async (text: string) => {
    stop(); setFirstAudioMs(null); setPlaying(true)
    const began = performance.now()
    const clear = () => { if (output.current === speech) { output.current = null; speech.dispose(); setPlaying(false) } }
    const speech = new SpeechOutput({
      onActivity() {}, onLevel() {},
      onFirstAudio: at => { if (output.current === speech) setFirstAudioMs(Math.round(at - began)) },
      onComplete: clear,
      onError: message => { if (output.current === speech) { clear(); onError(message) } },
    })
    output.current = speech
    try {
      // Resume during the click gesture so WebKit can unlock the output device.
      await speech.prepare()
      if (output.current !== speech) return
      speech.begin(); speech.append(text); speech.finish()
    } catch (error) { if (output.current === speech) { clear(); onError(error instanceof Error ? error.message : String(error)) } }
  }, [stop, onError])
  return { playing, firstAudioMs, play, stop }
}
