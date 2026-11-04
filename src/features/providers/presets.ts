/** 官方端点模板：侧边栏「模板」和对话框「快速填入」共用同一份。 */
export const presets = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", api: "openai-completions" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
  { id: "anthropic", name: "Anthropic / Claude", baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages" },
] as const;

export type Preset = (typeof presets)[number];
