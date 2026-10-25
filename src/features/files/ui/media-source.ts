import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readMediaFile, useMediaMeta, type MediaKind, type MediaMeta } from "../../../lib/media";
import { base64ToBytes, planMediaPreview } from "../../../lib/media-preview";

/** An object URL's payload as the wire sends it: base64 in, `Blob` out. */
export type MediaBytesPayload = { mime: string; data: string };

/**
 * One object URL per payload, revoked when it is replaced or the view goes away.
 *
 * The bytes arrive as base64 because the wire has no binary frame small enough
 * to be worth one; a `Blob` is what `<img>`/`<video>`/`<embed>` can actually
 * point at. An object URL pins its bytes for as long as the document lives, and
 * a phone has nowhere to put them, so the revocation is not optional.
 */
function useMediaObjectUrl(payload: MediaBytesPayload | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (payload === undefined) return;
    const next = URL.createObjectURL(new Blob([base64ToBytes(payload.data)], { type: payload.mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [payload]);
  return url;
}

/**
 * Where a piece of media can be read from, and whether it can be read at all.
 *
 * The asset protocol is "this webview reads this machine's disk", so it is the
 * whole answer on the desktop and no answer at all on a phone; the phone takes
 * the bytes over the pairing socket instead. See `lib/media-preview.ts`.
 */
export function useMediaSrc(
  path: string,
  kind: MediaKind,
  remote: boolean,
): { src: string | null; meta: MediaMeta | null; notice: string | null; fetching: boolean } {
  const meta = useMediaMeta(path, kind);
  const plan = planMediaPreview({ remote, kind, size: meta.data?.size ?? null });
  const bytes = useQuery({
    queryKey: ["media-bytes", path],
    queryFn: () => readMediaFile(path),
    enabled: plan.mode === "socket",
    staleTime: 30_000,
  });
  // Unconditional, like every hook here: `plan` moves from `socket` to
  // `blocked` when `media_meta` answers, so a hook call that followed it would
  // change the hook order between renders.
  const objectUrl = useMediaObjectUrl(bytes.data);
  return {
    src: plan.mode === "asset" ? convertFileSrc(path) : objectUrl,
    meta: meta.data ?? null,
    notice:
      plan.mode === "blocked" ? plan.message
      : bytes.isError ? String(bytes.error)
      : null,
    fetching: meta.isFetching,
  };
}
