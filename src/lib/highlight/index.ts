import type {
  HighlightKind,
  HighlightRequest,
  HighlightResponse,
  HighlightResult,
  HighlightToken,
} from "./types";

export type { HighlightKind, HighlightResult, HighlightToken };

/**
 * shiki 跑在一个小 Worker 池上，并且全应用共用一个缓存：聊天代码块、文件预览、
 * diff 行都走这里。三条规则决定了它的行为：
 *
 * - **UI 线程绝不 tokenize。** Worker 起不来就返回 `null`，调用方退回纯文本；
 *   宁可少点颜色，也不要悄悄卡一帧。
 * - **同源共享一次计算。** 同一个文件在 diff 和预览里同时打开，只算一次。
 * - **缓存按字节封顶，不按条目。** 高亮后的 HTML 是源码的 5–10 倍，
 *   「40 条 × 40 万字符」不叫缓存，叫泄漏。
 */

const WORKER_COUNT = 2;
const JOB_TIMEOUT_MS = 20_000;
const CACHE_BYTES = 12 * 1024 * 1024;
/** 同一个 Worker 连续失败这么多次，就认为这个环境跑不了它，本会话退回纯文本。 */
const FAILURE_LIMIT = 2;
/** 单个 token 对象的粗略开销（`{text, color, darkColor}` + 两个指针）。 */
const TOKEN_OVERHEAD_BYTES = 40;

export type HighlightTransport = (
  kind: HighlightKind,
  code: string,
  lang: string,
) => Promise<HighlightResult>;

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

type CacheEntry = { result: HighlightResult; bytes: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<HighlightResult>>();
let cacheBytes = 0;

function keyFor(kind: HighlightKind, lang: string, code: string): string {
  // 源码本身就是键：V8 会把算过的字符串哈希挂在字符串上，重复查询不必重扫
  // 25 万字符；换成自己算的摘要反而每次都要多走一遍。
  return `${kind}\u0000${lang}\u0000${code}`;
}

function resultBytes(result: HighlightResult): number {
  if (result.kind === "html") return result.html.length * 2;
  let total = 0;
  for (const line of result.lines) {
    for (const token of line) {
      total += token.text.length * 2 + TOKEN_OVERHEAD_BYTES;
    }
  }
  return total;
}

function remember(key: string, result: HighlightResult): void {
  const bytes = resultBytes(result) + key.length * 2;
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cacheBytes -= existing.bytes;
  }
  // 一条就能把预算吃光的结果不值得进缓存：它会立刻把别的条目全挤掉。
  if (bytes > CACHE_BYTES) return;
  cache.set(key, { result, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    if (!entry) break;
    cache.delete(oldest);
    cacheBytes -= entry.bytes;
  }
}

/** 命中后移到队尾，让 LRU 的「最近使用」名副其实。 */
function touch(key: string, entry: CacheEntry): CacheEntry {
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

/** 同步读缓存：重开一个会话/切回一个标签时，第一帧就是成品而不是纯文本。 */
export function peekHtml(code: string, lang: string): string | null {
  const entry = cache.get(keyFor("html", lang, code));
  return entry && entry.result.kind === "html" ? entry.result.html : null;
}

export function peekLines(code: string, lang: string): HighlightToken[][] | null {
  const entry = cache.get(keyFor("lines", lang, code));
  return entry && entry.result.kind === "lines" ? entry.result.lines : null;
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

async function run(
  kind: HighlightKind,
  code: string,
  lang: string,
): Promise<HighlightResult> {
  const key = keyFor(kind, lang, code);
  const hit = cache.get(key);
  if (hit) return touch(key, hit).result;

  const pending = inflight.get(key);
  if (pending) return pending;

  const next = dispatch(kind, code, lang)
    .then((result) => {
      remember(key, result);
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, next);
  return next;
}

export async function highlightToHtml(
  code: string,
  lang: string,
): Promise<string | null> {
  if (!code) return null;
  try {
    const result = await run("html", code, lang);
    return result.kind === "html" ? result.html : null;
  } catch {
    return null;
  }
}

export async function highlightToLines(
  code: string,
  lang: string,
): Promise<HighlightToken[][] | null> {
  if (!code) return null;
  try {
    const result = await run("lines", code, lang);
    return result.kind === "lines" ? result.lines : null;
  } catch {
    return null;
  }
}

/**
 * 提前把池子建起来：首个代码块/差异块出现时 shiki 还要加载语法和主题，
 * 那几十到几百毫秒不该由「第一次滚到那里」来买单。
 */
export function warmHighlight(): void {
  if (workerDisabled || typeof Worker === "undefined") return;
  try {
    ensurePool();
  } catch {
    /* Worker 起不来就退回纯文本，预热不该影响启动 */
  }
}

/** 测试与嵌入式宿主用：换掉 Worker 传输层。传 `null` 恢复默认。 */
export function setHighlightTransport(next: HighlightTransport | null): void {
  customTransport = next;
  workerDisabled = false;
  resetPool();
}

export function resetHighlightCache(): void {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
}

/* ------------------------------------------------------------------ *
 * Worker 池
 * ------------------------------------------------------------------ */

type QueuedJob = {
  id: number;
  kind: HighlightKind;
  code: string;
  lang: string;
  resolve: (result: HighlightResult) => void;
  reject: (error: Error) => void;
};

type Slot = { worker: Worker; jobId: number | null };

let customTransport: HighlightTransport | null = null;
let slots: Slot[] | null = null;
let workerDisabled = false;
let consecutiveFailures = 0;
let nextJobId = 1;
const queue: QueuedJob[] = [];
const pending = new Map<
  number,
  { job: QueuedJob; timer: number; slot: Slot }
>();

function dispatch(
  kind: HighlightKind,
  code: string,
  lang: string,
): Promise<HighlightResult> {
  if (customTransport) return customTransport(kind, code, lang);
  if (workerDisabled || typeof Worker === "undefined") {
    // 明确失败而不是返回空结果：空结果会被缓存成一个「这段没有颜色」的结论。
    return Promise.reject(new Error("高亮不可用"));
  }
  ensurePool();
  return new Promise<HighlightResult>((resolve, reject) => {
    queue.push({ id: nextJobId, kind, code, lang, resolve, reject });
    nextJobId += 1;
    pump();
  });
}

function ensurePool(): Slot[] {
  if (slots) return slots;
  slots = Array.from({ length: WORKER_COUNT }, spawnSlot);
  return slots;
}

function spawnSlot(): Slot {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    workerDisabled = true;
    throw new Error("高亮 Worker 不可用");
  }
  const slot: Slot = { worker, jobId: null };

  worker.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
    const data = event.data;
    const entry = pending.get(data.id);
    // 迟到的结果（超时后 Worker 才回话）直接丢弃，不要落进下一个请求。
    if (!entry || entry.slot !== slot) return;
    pending.delete(data.id);
    window.clearTimeout(entry.timer);
    slot.jobId = null;
    consecutiveFailures = 0;
    if (data.error || !data.result) {
      entry.job.reject(new Error(data.error ?? "高亮失败"));
    } else {
      entry.job.resolve(data.result);
    }
    pump();
  });

  worker.addEventListener("error", (event) => {
    event.preventDefault?.();
    failSlot(slot, new Error("高亮 Worker 崩溃"));
  });

  return slot;
}

function pump(): void {
  const pool = slots;
  if (!pool) return;
  for (const slot of pool) {
    if (slot.jobId !== null) continue;
    const job = queue.shift();
    if (!job) return;
    slot.jobId = job.id;
    const timer = window.setTimeout(
      () => failSlot(slot, new Error("高亮超时")),
      JOB_TIMEOUT_MS,
    );
    pending.set(job.id, { job, timer, slot });
    const request: HighlightRequest = {
      id: job.id,
      kind: job.kind,
      code: job.code,
      lang: job.lang,
    };
    try {
      slot.worker.postMessage(request);
    } catch (error) {
      window.clearTimeout(timer);
      pending.delete(job.id);
      slot.jobId = null;
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function failSlot(slot: Slot, error: Error): void {
  consecutiveFailures += 1;

  if (slot.jobId !== null) {
    const entry = pending.get(slot.jobId);
    pending.delete(slot.jobId);
    if (entry) {
      window.clearTimeout(entry.timer);
      entry.job.reject(error);
    }
  }
  slot.jobId = null;
  slot.worker.terminate();

  if (consecutiveFailures >= FAILURE_LIMIT) {
    // 放弃这条路径：本会话剩下的高亮都退回纯文本，绝不把主线程当备胎。
    workerDisabled = true;
    for (const [, entry] of pending) {
      window.clearTimeout(entry.timer);
      entry.job.reject(error);
    }
    pending.clear();
    queue.length = 0;
    resetPool();
    return;
  }

  const index = slots?.indexOf(slot) ?? -1;
  if (index >= 0 && slots) {
    try {
      slots[index] = spawnSlot();
    } catch {
      /* spawnSlot 已经把 workerDisabled 置位 */
    }
  }
  pump();
}

function resetPool(): void {
  if (!slots) return;
  for (const slot of slots) slot.worker.terminate();
  slots = null;
  consecutiveFailures = 0;
  for (const [, entry] of pending) window.clearTimeout(entry.timer);
  pending.clear();
  queue.length = 0;
}
