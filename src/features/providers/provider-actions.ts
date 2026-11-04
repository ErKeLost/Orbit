import {
  connect,
  disconnect,
  expectModel,
  persistDefaultModel,
  refresh,
  request,
  saveProvider,
  settleModel,
  syncProviderModels,
  type ModelEffort,
} from "../../lib/rpc";
import type { RpcSessionState } from "../../lib/protocol";
import { effortLevels } from "./effort-levels";

/** 「应用配置」和「使用此模型」共用的一条落盘链路所需的全部输入。 */
export type ActivationPlan = {
  provider: string;
  label?: string;
  /** 想要的目标模型；没有就退到 Pi 返回的第一个。 */
  defaultModel?: string;
  /** `syncProviderModels` 回来的首个模型，作为目标模型的兜底。 */
  firstModelId?: string;
  modelEfforts?: Record<string, ModelEffort>;
};

export type ActivationContext = { cwd: string; online: boolean };

async function applyThinkingLevel(level: string | undefined, cwd: string) {
  const validLevel = effortLevels.find(value => value === level);
  if (validLevel) await request({ type: "set_thinking_level", level: validLevel }, 30_000, cwd);
}

/**
 * 把一个 provider 的模型真正交给 Pi：写意图 chip → 重启 Pi（disconnect + connect，
 * 停进程、重新起、恢复会话，好几秒）→ 用 `get_available_models` 认领目标 → 落盘默认模型。
 *
 * 两条不变量：目标模型一旦知道就先贴到 chip 上，那几秒里不能还写着上一个 provider；
 * Pi 最后说的才算数，对不上就把被意图盖过的那份换回来。
 * 失败时把状态回滚到 `previous`，调用方只负责 toast。
 */
export async function activateProvider(plan: ActivationPlan, ctx: ActivationContext, previous?: RpcSessionState | null): Promise<{ provider: string; modelId: string }> {
  const { cwd, online } = ctx;
  const provider = plan.provider;
  try {
    const intended = plan.defaultModel ?? plan.firstModelId;
    if (intended) expectModel(cwd, { provider, id: intended });
    if (online) await disconnect();
    await connect(cwd);
    const available = await request<{ models: { provider: string; id: string }[] }>({ type: "get_available_models" }, 30_000, cwd);
    const choices = available.models.filter(model => model.provider === provider);
    const target = choices.find(model => model.id === plan.defaultModel) ?? choices.find(model => model.id === plan.firstModelId) ?? choices[0];
    if (!target) throw new Error(`${plan.label || provider} 没有可用模型，请检查配置`);
    expectModel(cwd, { provider, id: target.id });
    await request({ type: "set_model", provider, modelId: target.id }, 30_000, cwd);
    await applyThinkingLevel(plan.modelEfforts?.[plan.defaultModel ?? ""]?.default, cwd);
    const [current] = await Promise.all([refresh(cwd), persistDefaultModel(provider, target.id)]);
    if (current.model?.provider !== provider || current.model.id !== target.id) {
      settleModel(cwd, current);
      throw new Error("Pi 没有确认 Provider 切换");
    }
    settleModel(cwd);
    return { provider, modelId: target.id };
  } catch (error) {
    settleModel(cwd, previous ?? undefined);
    throw error;
  }
}

/** 目录同步 + 启用，返回启用的模型 id。同步结果同时作为目标模型的兜底。 */
export async function syncAndActivate(plan: ActivationPlan, ctx: ActivationContext, previous?: RpcSessionState | null) {
  const synced = await syncProviderModels(plan.provider);
  const result = await activateProvider({ ...plan, firstModelId: plan.firstModelId ?? synced.firstModelId }, ctx, previous);
  return { ...result, count: synced.count };
}

export type ProviderPayload = {
  provider: string;
  name?: string;
  baseUrl: string;
  modelsUrl?: string;
  api: string;
  apiKey?: string;
  authHeader: boolean;
  contextWindow?: number;
  modelEfforts: Record<string, ModelEffort>;
};

/**
 * 保存表单 → 同步目录 → 启用。比 `syncAndActivate` 多两件事：同步失败时允许退回到
 * 手填的模型 ID（所以失败不致命），启用失败时要顺手把 Pi 停掉，别留一个半启动的进程。
 */
export async function saveAndActivate(input: {
  payload: ProviderPayload;
  manualModelId: string;
  context: ActivationContext;
  onSyncFailure?: (message: string) => void;
}): Promise<{ id: string; count: number; modelId?: string }> {
  const { payload, context, manualModelId } = input;
  const result = await saveProvider(payload);
  let count = 0;
  let syncedFirst: string | undefined;
  try {
    const synced = await syncProviderModels(result.id);
    count = synced.count;
    syncedFirst = synced.firstModelId;
  } catch (syncError) {
    const message = syncError instanceof Error ? syncError.message : String(syncError);
    if (!manualModelId.trim()) throw new Error(`Provider 已保存，但同步到 Pi 失败：${message}`);
    input.onSyncFailure?.(message);
  }
  const preferredModelId = manualModelId.trim() || syncedFirst;
  let modelId: string | undefined;
  try {
    if (preferredModelId) await persistDefaultModel(result.id, preferredModelId);
    if (context.online) await disconnect();
    await connect(context.cwd);
    const available = await request<{ models: { provider: string; id: string }[] }>({ type: "get_available_models" }, 30_000, context.cwd);
    const target = available.models.find(model => model.provider === result.id && model.id === preferredModelId)
      ?? available.models.find(model => model.provider === result.id);
    if (!target) throw new Error(`Pi 没有加载 ${result.id} 的可用模型`);
    await request({ type: "set_model", provider: target.provider, modelId: target.id }, 30_000, context.cwd);
    await applyThinkingLevel(payload.modelEfforts?.[target.id]?.default, context.cwd);
    const current = await refresh(context.cwd);
    if (current.model?.provider !== target.provider || current.model?.id !== target.id) {
      throw new Error(`Pi 仍在使用 ${current.model?.provider ?? "未知 Provider"}/${current.model?.id ?? "未知模型"}`);
    }
    await persistDefaultModel(target.provider, target.id);
    modelId = target.id;
  } catch (activationError) {
    await disconnect().catch(() => undefined);
    throw new Error(`Provider 已保存，但 Pi 未能启用：${activationError instanceof Error ? activationError.message : String(activationError)}`);
  }
  return { id: result.id, count, modelId };
}
