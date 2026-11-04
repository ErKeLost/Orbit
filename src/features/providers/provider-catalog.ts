import { listProviderModels, type ProviderModel } from "../../lib/rpc";

/**
 * 模型目录来自 Rust 侧的 `list_provider_models`：OAuth / 原生供应商那条路会 spawn 一个
 * Node 凭据进程（实测 240–270 ms 纯 CPU）再走一次网络。侧边栏点来点去是高频操作，
 * 所以目录在内存里按 provider 缓存一小段时间，点击时先用缓存立刻出内容。
 */
const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; models: ProviderModel[] }>();
const inflight = new Map<string, Promise<ProviderModel[]>>();

export function cachedCatalog(provider: string): ProviderModel[] | undefined {
  const hit = cache.get(provider);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL) { cache.delete(provider); return undefined; }
  return hit.models;
}

export function rememberCatalog(provider: string, models: ProviderModel[]) {
  cache.set(provider, { at: Date.now(), models });
}

export function forgetCatalog(provider: string) {
  cache.delete(provider);
}

/** 同一个 provider 的并发请求合并成一次；结果写回缓存。 */
export function loadCatalog(provider: string): Promise<ProviderModel[]> {
  const pending = inflight.get(provider);
  if (pending) return pending;
  const run = listProviderModels(provider)
    .then((catalog) => {
      const models = Array.isArray(catalog.data) ? catalog.data : [];
      rememberCatalog(provider, models);
      return models;
    })
    .finally(() => { inflight.delete(provider); });
  inflight.set(provider, run);
  return run;
}
