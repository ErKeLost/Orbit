export type AgentStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "unknown";

export type AgentNode = {
  id: string;
  parentId: string | null;
  name: string;
  task: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  model?: string;
  /** 头像图标（Iconify 名字），spawn 时由模型给；不存在时渲染层回落。 */
  logo?: string;
  pid?: number;
  childrenIds: string[];
  children: AgentNode[];
  sessionId?: string;
  sessionPath?: string;
};

export type AgentSnapshot = {
  version: number;
  rootId: string | null;
  active: AgentNode[];
  recent: AgentNode[];
  updatedAt: number;
};

const statuses = new Set<AgentStatus>(["queued", "running", "completed", "failed", "aborted", "unknown"]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseNode(value: unknown, inheritedParentId: string | null = null): AgentNode | null {
  const source = object(value);
  if (!source || typeof source.id !== "string" || typeof source.name !== "string" || typeof source.task !== "string") return null;
  const nodeId = source.id;
  const status = typeof source.status === "string" && statuses.has(source.status as AgentStatus) ? source.status as AgentStatus : "unknown";
  const children = Array.isArray(source.children)
    ? source.children.map(child => parseNode(child, nodeId)).filter((child): child is AgentNode => child !== null)
    : [];
  const referencedChildren = Array.isArray(source.childrenIds)
    ? source.childrenIds.filter((id): id is string => typeof id === "string")
    : [];
  const startedAt = optionalNumber(source.startedAt);
  const endedAt = optionalNumber(source.endedAt);
  const pid = optionalNumber(source.pid);
  const summary = optionalString(source.summary);
  const error = optionalString(source.error);
  const model = optionalString(source.model);
  const logo = optionalString(source.logo);
  const sessionId = optionalString(source.sessionId);
  const sessionPath = optionalString(source.sessionPath);
  return {
    id: nodeId,
    parentId: typeof source.parentId === "string" ? source.parentId : inheritedParentId,
    name: source.name,
    task: source.task,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(model ? { model } : {}),
    ...(logo ? { logo } : {}),
    ...(pid === undefined ? {} : { pid }),
    childrenIds: [...new Set([...referencedChildren, ...children.map(child => child.id)])],
    children,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionPath ? { sessionPath } : {}),
  };
}

function parseList(value: unknown): AgentNode[] | null {
  if (!Array.isArray(value)) return null;
  const result = value.map(item => parseNode(item));
  return result.every((item): item is AgentNode => item !== null) ? result : null;
}

/** Strict boundary parser for the versioned `gui-agents` wire snapshot. */
export function parseAgentSnapshot(input: unknown): AgentSnapshot | null {
  if (input == null || input === "") return null;
  let decoded: unknown = input;
  if (typeof input === "string") {
    try { decoded = JSON.parse(input) as unknown; }
    catch { return null; }
  }
  const source = object(decoded);
  if (!source || typeof source.version !== "number" || typeof source.rootId !== "string" || typeof source.updatedAt !== "number") return null;
  const active = parseList(source.active);
  const recent = parseList(source.recent);
  if (!active || !recent) return null;
  const activeIds = new Set(active.map(agent => agent.id));
  return { version: source.version, rootId: source.rootId, active, recent: recent.filter(agent => !activeIds.has(agent.id)), updatedAt: source.updatedAt };
}

export function agentNodes(snapshot: AgentSnapshot | null): AgentNode[] {
  if (!snapshot) return [];
  const result: AgentNode[] = [];
  const seen = new Set<string>();
  const visit = (agent: AgentNode) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    result.push(agent);
    agent.children.forEach(visit);
  };
  [...snapshot.active, ...snapshot.recent].forEach(visit);
  return result;
}

export function hasRunningAgents(snapshot: AgentSnapshot | null): boolean {
  return agentNodes(snapshot).some(agent => agent.status === "running" || agent.status === "queued");
}

export function elapsedMs(agent: AgentNode, now = Date.now()): number | undefined {
  return agent.startedAt === undefined ? undefined : Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
}

export function formatAgentElapsed(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
