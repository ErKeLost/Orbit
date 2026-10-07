import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "./store";

export type GithubStatus = { installed: boolean; connected: boolean };
export type GitlabStatus = { connected: boolean; host: string | null };
export type InboxItem = {
  id: string;
  kind: "pr" | "issue" | "mr" | string;
  title: string;
  repo: string;
  url: string;
  state: string;
  author: string;
  updated: string;
};

const desktop = () => useWorkspace.getState().runtimeTarget === "desktop";

export const githubStatus = () => invoke<GithubStatus>("github_status");
export const githubInbox = () => invoke<InboxItem[]>("github_inbox");
export const gitlabStatus = () => invoke<GitlabStatus>("gitlab_status");
export const gitlabConnect = (host: string, token: string) => invoke<string>("gitlab_connect", { host, token });
export const gitlabDisconnect = () => invoke<void>("gitlab_disconnect");
export const gitlabInbox = () => invoke<InboxItem[]>("gitlab_inbox");

export function useGithubStatus(enabled = true) {
  return useQuery({ queryKey: ["inbox", "github-status"], queryFn: githubStatus, enabled: enabled && desktop(), staleTime: 60_000 });
}

export function useGitlabStatus(enabled = true) {
  return useQuery({ queryKey: ["inbox", "gitlab-status"], queryFn: gitlabStatus, enabled: enabled && desktop(), staleTime: 60_000 });
}

export function useGithubInbox(enabled = true) {
  return useQuery({ queryKey: ["inbox", "github"], queryFn: githubInbox, enabled: enabled && desktop(), refetchInterval: 120_000 });
}

export function useGitlabInbox(enabled = true) {
  return useQuery({ queryKey: ["inbox", "gitlab"], queryFn: gitlabInbox, enabled: enabled && desktop(), refetchInterval: 120_000 });
}
