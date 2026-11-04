import type { ComponentType } from "react";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import AzureColor from "@lobehub/icons/es/Azure/components/Color";
import AzureMono from "@lobehub/icons/es/Azure/components/Mono";
import BedrockColor from "@lobehub/icons/es/Bedrock/components/Color";
import BedrockMono from "@lobehub/icons/es/Bedrock/components/Mono";
import TogetherColor from "@lobehub/icons/es/Together/components/Color";
import TogetherMono from "@lobehub/icons/es/Together/components/Mono";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";
import BailianColor from "@lobehub/icons/es/Bailian/components/Color";
import BailianMono from "@lobehub/icons/es/Bailian/components/Mono";
import SiliconCloudColor from "@lobehub/icons/es/SiliconCloud/components/Color";
import SiliconCloudMono from "@lobehub/icons/es/SiliconCloud/components/Mono";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color";
import VolcengineMono from "@lobehub/icons/es/Volcengine/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import OpenRouterColor from "@lobehub/icons/es/OpenRouter/components/Color";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import PerplexityColor from "@lobehub/icons/es/Perplexity/components/Color";
import PerplexityMono from "@lobehub/icons/es/Perplexity/components/Mono";
import FireworksColor from "@lobehub/icons/es/Fireworks/components/Color";
import FireworksMono from "@lobehub/icons/es/Fireworks/components/Mono";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import NvidiaMono from "@lobehub/icons/es/Nvidia/components/Mono";
import CerebrasColor from "@lobehub/icons/es/Cerebras/components/Color";
import CerebrasMono from "@lobehub/icons/es/Cerebras/components/Mono";
import DeepInfraColor from "@lobehub/icons/es/DeepInfra/components/Color";
import DeepInfraMono from "@lobehub/icons/es/DeepInfra/components/Mono";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import DoubaoMono from "@lobehub/icons/es/Doubao/components/Mono";
import HunyuanColor from "@lobehub/icons/es/Hunyuan/components/Color";
import HunyuanMono from "@lobehub/icons/es/Hunyuan/components/Mono";
import CloudflareColor from "@lobehub/icons/es/Cloudflare/components/Color";
import CloudflareMono from "@lobehub/icons/es/Cloudflare/components/Mono";

/**
 * 供应商标记不走 `@lobehub/icons` 的 barrel：那个入口是 1.9 MB / 351 个供应商，
 * `import { ProviderIcon }` 会把整个库同步求值（实测 ~300 ms 主线程 + ~140 MB RSS），
 * 供应商页每次进入都要付这笔钱。这里直接取品牌组件本体，连目录下的 `Avatar` / `Text` /
 * `Combine` 都不导入——它们会把 `antd-style` 整套主题运行时一起拖进来。
 * `ModelMeta` 那份懒加载继续负责模型标记。
 */
type BrandIcon = ComponentType<{ size?: number }>;
type BrandLogo = { color?: BrandIcon; mono: BrandIcon };

const LOGOS: Record<string, BrandLogo> = {
  anthropic: { mono: AnthropicMono },
  openai: { mono: OpenAIMono },
  google: { color: GoogleColor, mono: GoogleMono },
  azure: { color: AzureColor, mono: AzureMono },
  bedrock: { color: BedrockColor, mono: BedrockMono },
  together: { color: TogetherColor, mono: TogetherMono },
  deepseek: { color: DeepSeekColor, mono: DeepSeekMono },
  zhipu: { color: ZhipuColor, mono: ZhipuMono },
  bailian: { color: BailianColor, mono: BailianMono },
  siliconcloud: { color: SiliconCloudColor, mono: SiliconCloudMono },
  vercel: { mono: VercelMono },
  volcengine: { color: VolcengineColor, mono: VolcengineMono },
  moonshot: { mono: MoonshotMono },
  ollama: { mono: OllamaMono },
  openrouter: { color: OpenRouterColor, mono: OpenRouterMono },
  groq: { mono: GroqMono },
  mistral: { color: MistralColor, mono: MistralMono },
  xai: { mono: XAIMono },
  perplexity: { color: PerplexityColor, mono: PerplexityMono },
  fireworks: { color: FireworksColor, mono: FireworksMono },
  cohere: { color: CohereColor, mono: CohereMono },
  nvidia: { color: NvidiaColor, mono: NvidiaMono },
  cerebras: { color: CerebrasColor, mono: CerebrasMono },
  deepinfra: { color: DeepInfraColor, mono: DeepInfraMono },
  qwen: { color: QwenColor, mono: QwenMono },
  minimax: { color: MinimaxColor, mono: MinimaxMono },
  doubao: { color: DoubaoColor, mono: DoubaoMono },
  hunyuan: { color: HunyuanColor, mono: HunyuanMono },
  cloudflare: { color: CloudflareColor, mono: CloudflareMono },
};

const providerIconAliases: Record<string, string> = {
  anthropicclaude: "anthropic",
  claude: "anthropic",
  openaiapi: "openai",
  chatgpt: "openai",
  googleai: "google",
  geminiai: "google",
  vertexai: "google",
  googlevertex: "google",
  azureopenai: "azure",
  amazonbedrock: "bedrock",
  awsbedrock: "bedrock",
  aws: "bedrock",
  togetherai: "together",
  deepseekapi: "deepseek",
  bigmodel: "zhipu",
  zhipuai: "zhipu",
  智谱: "zhipu",
  glm: "zhipu",
  alibabadashscope: "bailian",
  dashscope: "bailian",
  阿里云: "bailian",
  aliyun: "bailian",
  siliconflow: "siliconcloud",
  硅基流动: "siliconcloud",
  vercelaigateway: "vercel",
  volcengine: "volcengine",
  火山引擎: "volcengine",
  arkcode: "volcengine",
  doubaoapi: "doubao",
  moonshotai: "moonshot",
  kimi: "moonshot",
  mistralai: "mistral",
  grok: "xai",
  fireworksai: "fireworks",
  perplexityai: "perplexity",
  nvidianim: "nvidia",
  tongyi: "qwen",
  qwenapi: "qwen",
};

/** 没有 `Color` 变体的品牌，用单色才是它的正规形态。 */
const monochromeProviderIcons = new Set(["anthropic", "openai", "vercel", "moonshot", "ollama", "groq", "xai"]);

/** No logo means one letter, not an abbreviation: "T" reads as a mark, "TA" reads as a typo. */
function fallbackProviderMark(id: string, name?: string) {
  const label = (name || id).trim();
  const initial = label.match(/[A-Za-z0-9]|[\u3400-\u9fff]/)?.[0] ?? "P";
  // FNV-1a: the previous `hash * 31` put three of six sample ids on the same
  // tone, which reads as a bug when the letter is the only differentiator.
  let hash = 2166136261;
  for (const char of id) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return <span className="provider-fallback-mark" data-tone={(hash >>> 0) % 4}>{initial.toUpperCase()}</span>;
}

function resolveProviderIcon(value: string): string | null {
  const key = value.toLowerCase().replace(/[\s._\-/]+/g, "");
  const aliased = providerIconAliases[key] ?? key;
  return LOGOS[aliased] ? aliased : null;
}

export function ProviderMark({ id, name }: { id: string; name?: string }) {
  const iconId = resolveProviderIcon(id) ?? resolveProviderIcon(name ?? "");
  const logo = iconId ? LOGOS[iconId] : null;
  if (!logo || !iconId) return <span className="provider-brand-mark" aria-hidden="true">{fallbackProviderMark(id, name)}</span>;
  const Icon = monochromeProviderIcons.has(iconId) || !logo.color ? logo.mono : logo.color;
  return <span className="provider-brand-mark" aria-hidden="true"><Icon size={19} /></span>;
}
