import { invoke } from "./native";
import { useQuery } from "@tanstack/react-query";

export type RuntimeDiscovery = {
  home: string;
  agentDir: string;
  sessionsDir: string;
  resourcesDir: string;
  node: string;
  hostNode: string;
  nodeVersion: string;
  pi: string;
  piVersion: string;
  piSource: "bundled" | "project" | "global";
  nodeModules: string;
  extension: string;
  cwd: string;
};

export function useRuntimeDiscovery(enabled: boolean) {
  return useQuery({
    queryKey: ["discovery"],
    queryFn: () => invoke<RuntimeDiscovery>("discover"),
    enabled,
    staleTime: 30_000,
  });
}
