import type { ModelEffort, ProviderModel, ProviderProfile } from "../../lib/rpc";

export const apiTypes = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "azure-openai-responses",
  "mistral-conversations",
] as const;

export type ProviderFormState = {
  provider: string;
  name: string;
  baseUrl: string;
  modelsUrl: string;
  api: (typeof apiTypes)[number];
  apiKey: string;
  defaultModelId: string;
  authHeader: boolean;
  contextWindow: string;
  modelEfforts: Record<string, ModelEffort>;
  models: ProviderModel[];
  busy: "save" | "probe" | "use" | null;
};

export function initialForm(profile?: ProviderProfile): ProviderFormState {
  return {
    provider: profile?.id ?? "",
    name: profile?.name ?? "",
    baseUrl: profile?.baseUrl ?? "",
    modelsUrl: profile?.modelsUrl ?? "",
    api: (profile?.api as (typeof apiTypes)[number]) || "openai-completions",
    apiKey: "",
    defaultModelId: profile?.defaultModel ?? "",
    authHeader: profile?.authHeader !== false,
    contextWindow: profile?.contextWindow ? String(profile.contextWindow) : "",
    modelEfforts: profile?.modelEfforts ?? {},
    models: profile?.models ?? [],
    busy: null,
  };
}
