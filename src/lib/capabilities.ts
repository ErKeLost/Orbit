// Pi 1.0 capability snapshots. The RPC protocol has no commands for MCP servers,
// media models, virtual models, or tool exposure, so the GUI extension publishes
// them as `setStatus` payloads; this module parses them for the UI.

export type MediaModelInfo = { provider: string; id: string; name?: string; available: boolean };
export type McpServerInfo = {
  name: string;
  source: "extension" | "mcp.json";
  transport: "stdio" | "http" | "unknown";
  exposure?: string;
  description?: string;
  enabled?: boolean;
  tools: string[];
  extensionPath?: string;
};
export type VirtualModelInfo = { provider: string; id: string; name: string; thinkingLevels?: string[] };
export type CodemodeSettings = { mode?: "on" | "only"; inlineBudget?: number } | null;

export type PiCapabilities = {
  tools: {
    total: number;
    active: number;
    exposure: Record<string, number>;
    codemode: boolean;
    toolSearch: boolean;
    mcpTools: number;
  };
  mcp: McpServerInfo[];
  media: { image: MediaModelInfo[]; classifier: MediaModelInfo[] };
  virtualModels: VirtualModelInfo[];
  settings: {
    cacheWarming?: string | null;
    codemode?: CodemodeSettings;
    defaultTools?: string[] | null;
    extensions?: string[] | null;
  } | null;
};

export const CODEMODE_TOOL = "codemode";
export const TOOL_SEARCH_TOOL = "tool_search";

export const BUILTIN_EXTENSION_LABELS: Record<string, string> = {
  "builtin:codemode": "Codemode",
  "builtin:tool-search": "Tool Search",
  "builtin:mcp": "MCP",
  "builtin:llama.cpp": "llama.cpp",
};

export const CACHE_WARMING_LABELS: Record<string, string> = {
  off: "关闭",
  streaming: "运行中",
  idle: "运行中与空闲",
};

export const MCP_EXPOSURE_LABELS: Record<string, string> = {
  codemode: "Codemode 脚本",
  direct: "直接声明给模型",
  deferred: "由 tool_search 加载",
  hidden: "隐藏",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readMediaModels(value: unknown): MediaModelInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.provider !== "string" || typeof item.id !== "string") return [];
    return [{ provider: item.provider, id: item.id, name: typeof item.name === "string" ? item.name : undefined, available: item.available === true }];
  });
}

function readMcpServers(value: unknown): McpServerInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    const transport = item.transport === "stdio" || item.transport === "http" ? item.transport : "unknown";
    return [{
      name: item.name,
      source: item.source === "extension" ? "extension" as const : "mcp.json" as const,
      transport,
      exposure: typeof item.exposure === "string" ? item.exposure : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
      enabled: item.enabled !== false,
      tools: Array.isArray(item.tools) ? item.tools.filter((tool): tool is string => typeof tool === "string") : [],
      extensionPath: typeof item.extensionPath === "string" ? item.extensionPath : undefined,
    }];
  });
}

function readVirtualModels(value: unknown): VirtualModelInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.provider !== "string" || typeof item.id !== "string") return [];
    return [{ provider: item.provider, id: item.id, name: typeof item.name === "string" ? item.name : item.id, thinkingLevels: Array.isArray(item.thinkingLevels) ? item.thinkingLevels.filter((level): level is string => typeof level === "string") : [] }];
  });
}

export function parseCapabilities(raw: string | undefined): PiCapabilities | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !isRecord(value.tools)) return null;
    const tools = value.tools;
    const media = isRecord(value.media) ? value.media : {};
    const settings = isRecord(value.settings) ? value.settings : null;
    return {
      tools: {
        total: typeof tools.total === "number" ? tools.total : 0,
        active: typeof tools.active === "number" ? tools.active : 0,
        exposure: isRecord(tools.exposure) ? Object.fromEntries(Object.entries(tools.exposure).filter((entry): entry is [string, number] => typeof entry[1] === "number")) : {},
        codemode: tools.codemode === true,
        toolSearch: tools.toolSearch === true,
        mcpTools: typeof tools.mcpTools === "number" ? tools.mcpTools : 0,
      },
      mcp: readMcpServers(value.mcp),
      media: { image: readMediaModels(media.image), classifier: readMediaModels(media.classifier) },
      virtualModels: readVirtualModels(value.virtualModels),
      settings: settings ? {
        cacheWarming: typeof settings.cacheWarming === "string" ? settings.cacheWarming : null,
        codemode: isRecord(settings.codemode) ? { mode: settings.codemode.mode === "only" ? "only" : "on", inlineBudget: typeof settings.codemode.inlineBudget === "number" ? settings.codemode.inlineBudget : undefined } : null,
        defaultTools: Array.isArray(settings.defaultTools) ? settings.defaultTools.filter((tool): tool is string => typeof tool === "string") : null,
        extensions: Array.isArray(settings.extensions) ? settings.extensions.filter((extension): extension is string => typeof extension === "string") : null,
      } : null,
    };
  } catch { return null; }
}

/** Catalogued capability tools (`codemode`, `tool_search`) that are not active yet. */
export function inactiveCapabilityTools(capabilities: PiCapabilities | null, active: string[]): string[] {
  if (!capabilities) return [];
  const current = new Set(active);
  const offered = [
    capabilities.tools.codemode ? CODEMODE_TOOL : null,
    capabilities.tools.toolSearch ? TOOL_SEARCH_TOOL : null,
  ];
  return offered.filter((tool): tool is string => tool !== null && !current.has(tool));
}

export function availableMediaModels(models: MediaModelInfo[]): MediaModelInfo[] {
  return models.filter(model => model.available);
}
