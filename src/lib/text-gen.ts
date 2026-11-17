import { invoke } from "./native";

export type TextGenConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

export const textGenConfig = () => invoke<TextGenConfig>("text_gen_config");

export function saveTextGen(input: { enabled: boolean; baseUrl: string; model: string; apiKey?: string }) {
  return invoke<TextGenConfig>("save_text_gen", {
    enabled: input.enabled,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey ?? null,
  });
}

/** Empty string when the cheap model is off, so the caller can fall back to Pi. */
export async function generateText(prompt: string): Promise<string | null> {
  try {
    const text = await invoke<string>("text_generate", { prompt });
    return text.trim() || null;
  } catch (error) {
    if (String(error).includes("unconfigured")) return null;
    throw error;
  }
}
