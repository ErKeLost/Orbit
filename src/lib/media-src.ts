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

const CACHE_LIMIT = 120;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

function cacheKey(part: SessionImage): string | undefined {
  if (!part.session || typeof part.at !== "number") return undefined;
  return `${part.session}|${part.at}|${part.ordinal ?? 0}`;
}

function remember(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
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
  const task = invoke<{ mimeType: string; data: string }>("session_image", {
    sessionPath: part.session,
    at: part.at,
    ordinal: part.ordinal ?? 0,
  })
    .then(({ mimeType, data }) => {
      const url = `data:${mimeType};base64,${data}`;
      remember(key, url);
      return url;
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
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
