import { invoke } from "./native";
import { useQuery } from "@tanstack/react-query";

export type MediaKind = "image" | "audio" | "video" | "pdf";

export type MediaMeta = { mime: string; size: number };

const EXT_KIND: Record<string, MediaKind> = {};
for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]) EXT_KIND[ext] = "image";
for (const ext of ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]) EXT_KIND[ext] = "audio";
for (const ext of ["mp4", "m4v", "webm", "mov", "mkv"]) EXT_KIND[ext] = "video";
for (const ext of ["pdf"]) EXT_KIND[ext] = "pdf";

export function mediaKind(path: string): MediaKind | null {
  const ext = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? null;
}

export const mediaMeta = (path: string) => invoke<MediaMeta | null>("media_meta", { path });

export function useMediaMeta(path: string, kind: MediaKind | null) {
  return useQuery({ queryKey: ["media", path], queryFn: () => mediaMeta(path), enabled: kind != null, staleTime: 30_000 });
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
