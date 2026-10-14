import type { UnifiedFileDiff } from "./unifiedDiff";

type Job = {
  original: string;
  current: string;
  resolve: (value: UnifiedFileDiff) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  detach: () => void;
};

let worker: Worker | null = null;
let active: Job | null = null;
const queue: Job[] = [];

function stopWorker() {
  worker?.terminate();
  worker = null;
}

function finish(result?: UnifiedFileDiff, error?: unknown) {
  const job = active;
  active = null;
  if (job) {
    job.detach();
    if (error !== undefined) job.reject(error);
    else job.resolve(result!);
  }
  pump();
}

function pump() {
  if (active || queue.length === 0) return;
  active = queue.shift()!;
  try {
    if (!worker) {
      worker = new Worker(new URL("./unifiedDiff.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ result?: UnifiedFileDiff; error?: string }>) => {
        finish(event.data.result, event.data.error ? new Error(event.data.error) : undefined);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        stopWorker();
        finish(undefined, new Error(event.message || "差异计算失败"));
      };
    }
    // A single job at a time bounds both CPU and structured-clone memory.
    worker.postMessage({ original: active.original, current: active.current });
  } catch (error) {
    stopWorker();
    finish(undefined, error);
  }
}

export function buildUnifiedFileAsync(original: string, current: string, signal?: AbortSignal): Promise<UnifiedFileDiff> {
  if (signal?.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const job: Job = { original, current, resolve, reject, signal, detach: () => signal?.removeEventListener("abort", abort) };
    const abort = () => {
      job.detach();
      if (active === job) {
        // Termination also cancels an ongoing expensive comparison.
        stopWorker();
        active = null;
      } else {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      }
      reject(new DOMException("已取消", "AbortError"));
      pump();
    };
    signal?.addEventListener("abort", abort, { once: true });
    queue.push(job);
    pump();
  });
}
