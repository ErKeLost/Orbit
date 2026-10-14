import { buildUnifiedFile } from "./unifiedDiff";

// Only this worker runs the potentially expensive line comparison.
self.onmessage = (event: MessageEvent<{ original: string; current: string }>) => {
  try {
    self.postMessage({ result: buildUnifiedFile(event.data.original, event.data.current) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
