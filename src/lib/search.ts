import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "./store";

export type SearchFileHit = {
  path: string;
  relative: string;
  line: number | null;
  snippet: string | null;
  kind: "name" | "content";
};

export type SearchSessionHit = {
  path: string;
  title: string;
  snippet: string | null;
  modified: string;
};

const desktop = () => useWorkspace.getState().runtimeTarget === "desktop";
export const MIN_QUERY = 2;

export function searchFiles(cwd: string, query: string) {
  return invoke<SearchFileHit[]>("search_files", { cwd, query });
}

export function searchSessions(query: string) {
  return invoke<SearchSessionHit[]>("search_sessions", { query });
}

export function useFileSearch(cwd: string, query: string, enabled: boolean) {
  return useQuery({
    queryKey: ["search", "files", cwd, query],
    queryFn: () => searchFiles(cwd, query),
    enabled: enabled && desktop() && query.trim().length >= MIN_QUERY && Boolean(cwd),
    staleTime: 10_000,
  });
}

export function useSessionSearch(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ["search", "sessions", query],
    queryFn: () => searchSessions(query),
    enabled: enabled && desktop() && query.trim().length >= MIN_QUERY,
    staleTime: 10_000,
  });
}
