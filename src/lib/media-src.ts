import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { invoke } from "./native";
import { mobileRuntime } from "./runtime";

/** A part's synchronous source: inline bytes, a materialised file, or a URL. */
export function imageSrc(part?: { data?: string; file?: string; mimeType?: string; url?: string }): string | undefined {
  if (!part) return undefined;
  if (part.data && part.mimeType) return `data:${part.mimeType};base64,${part.data}`;
  if (part.file) return mobileRuntime() ? undefined : convertFileSrc(part.file);
  return part.url;
}

/**
 * Images that Rust left inside the session file.
 *
 * `history::project` replaces an image's base64 with `{session, at, ordinal}` so
 * the transcript never carries 166 MB of pixels. The bytes are decoded one image
 * at a time, only for what is on screen, and the resulting `data:` URL is kept in
 * a small LRU: scrolling back re-uses it, scrolling past evicts it.
 */
type SessionImage = { data?: string; file?: string; mimeType?: string; url?: string; session?: string; at?: number; ordinal?: number };

/**
 * 缓存上限按**字节**算，不只按条数。
 *
 * 一张 computer-use 截图可以是 1–10MB 的 base64，而一条长会话里几十张很正常。
 * 之前是「最多 120 条」：120 张 5MB 的图就是 600MB 的字符串常驻在渲染进程的 JS
 * 堆里（data URL 在 V8 里按 UTF-16 算，还要乘 2）。这就是「放着不动一会儿，内存
 * 压力起来，做任何操作都卡十几秒」的一个直接来源。现在按总字符量给预算，超了就
 * 从最旧的开始丢；超大单图干脆不缓存（还能显示，只是滚走再回来要重读）。
 */
const CACHE_ENTRIES = 96;
/** data URL 字符串的字符数上限（V8 里一个字符约 2 字节）。 */
const CACHE_CHARS = 24 * 1024 * 1024;
/** 超过这个尺寸的单张图不进缓存。 */
const CACHE_MAX_ENTRY_CHARS = 6 * 1024 * 1024;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();
let cacheChars = 0;

function cacheKey(part: SessionImage): string | undefined {
  if (!part.session || typeof part.at !== "number") return undefined;
  return `${part.session}|${part.at}|${part.ordinal ?? 0}`;
}

function forget(key: string) {
  const value = cache.get(key);
  if (value === undefined) return;
  cacheChars -= value.length;
  cache.delete(key);
}

function remember(key: string, url: string) {
  if (url.length > CACHE_MAX_ENTRY_CHARS) return;
  forget(key);
  cache.set(key, url);
  cacheChars += url.length;
  while (cache.size > CACHE_ENTRIES || (cacheChars > CACHE_CHARS && cache.size > 1)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
}

export async function loadSessionImage(part: SessionImage): Promise<string | undefined> {
  const direct = imageSrc(part);
  if (direct) return direct;
  const key = cacheKey(part);
  if (!key) return undefined;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = fetchSessionImage(part).then((url) => {
    if (url) remember(key, url);
    return url;
  }).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/**
 * 桌面端先让 Rust 把图片落成文件（asset 协议直读），拿不到再退回 base64。
 *
 * 一张 5MB 的截图在 JSON 里是 6.7MB 的字符串，IPC 要把它解析一遍，JS 堆里再留
 * 一份 UTF-16 副本。改走文件后 IPC 只剩一条路径，解码和内存都在浏览器自己的
 * 图片缓存里。手机读不到这台机器的路径，所以仍然走 base64。
 */
async function fetchSessionImage(part: SessionImage): Promise<string | undefined> {
  const args = { sessionPath: part.session, at: part.at, ordinal: part.ordinal ?? 0 };
  if (!mobileRuntime()) {
    try {
      const saved = await invoke<{ mimeType: string; file: string }>("session_image_file", args);
      if (saved?.file) return convertFileSrc(saved.file);
    } catch {
      // 回退到 base64：命令不存在、文件写不进去、旧版本桌面端都走这一条。
    }
  }
  try {
    const { mimeType, data } = await invoke<{ mimeType: string; data: string }>("session_image", args);
    return `data:${mimeType};base64,${data}`;
  } catch {
    return undefined;
  }
}

/** Resolves a part to something an `<img>` can show, fetching session bytes when needed. */
export function useImageSrc(part?: { data?: string; file?: string; mimeType?: string; url?: string; session?: string; at?: number; ordinal?: number }): string | undefined {
  const direct = imageSrc(part);
  const key = part ? cacheKey(part) : undefined;
  const [resolved, setResolved] = useState<string | undefined>(() => (key ? cache.get(key) : undefined));
  useEffect(() => {
    if (direct) return;
    if (!key) {
      setResolved(undefined);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setResolved(hit);
      return;
    }
    let alive = true;
    void loadSessionImage(part ?? {}).then((url) => {
      if (alive) setResolved(url);
    });
    return () => {
      alive = false;
    };
    // `key` covers session/at/ordinal; `direct` covers the inline transports.
  }, [key, direct]);
  return direct ?? resolved;
}
