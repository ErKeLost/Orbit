export type VoiceTrace = { id: string; startedAt: number; marks: Record<string, number>; intent?: string; target?: string; error?: string; ttsRequestId?: string; clarificationReason?: string; confidence?: number; actionability?: number }
/** Bounded diagnostics; no audio or user content is persisted. */
export class VoiceMetrics {
  private traces: VoiceTrace[] = []
  begin(id: string, lastSample = performance.now()) {
    const trace = { id, startedAt: Date.now(), marks: { speech_last_sample: lastSample } }
    this.traces.push(trace); this.traces = this.traces.slice(-100)
    return trace
  }
  mark(trace: VoiceTrace, stage: string, at = performance.now()) { trace.marks[stage] ??= at }
  snapshot() { return this.traces.map(trace => ({ ...trace, marks: { ...trace.marks } })) }
}
