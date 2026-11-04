/** UI-neutral JSONL bridge to Pi's own credential store and OAuth flows.
 * Requests arrive on stdin. Only non-secret projections leave on stdout.
 * This process owns no agent session and loads no project extensions/tools.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ModelRuntime, readStoredCredential, SettingsManager } from "./index.ts";
import { getSupportedThinkingLevels, type AuthPrompt, type Model, type Api } from "@earendil-works/pi-ai";

const [operation, agentDir, providerId] = process.argv.slice(2);
const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort(new Error("操作超时，请重试"));
  emit({ type: "error", message: "操作超时，请重试" });
  process.exit(1);
}, operation === "login" ? 10 * 60_000 : 30_000);
const input = createInterface({ input: process.stdin, terminal: false });
const pending = new Map<string, { resolve: (value: string) => void; reject: (reason: unknown) => void }>();
let sequence = 0;
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");

input.on("line", line => {
  try {
    const message = JSON.parse(line);
    if (message.type === "cancel") controller.abort(new Error("登录已取消"));
    else if (message.type === "answer" && typeof message.id === "string" && typeof message.value === "string") {
      pending.get(message.id)?.resolve(message.value);
    }
  } catch { /* Ignore incomplete/invalid messages; never echo input secrets. */ }
});
input.on("close", () => { if (operation === "login") controller.abort(new Error("登录窗口已关闭")); });

function prompt(request: AuthPrompt): Promise<string> {
  const id = String(++sequence);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  signal.throwIfAborted();
  const { signal: _, ...fields } = request;
  emit({ type: "prompt", id, prompt: fields });
  let abort: () => void;
  return new Promise<string>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.set(id, { resolve, reject });
  }).finally(() => {
    signal.removeEventListener("abort", abort);
    pending.delete(id);
    emit({ type: "prompt_closed", id });
  });
}

function catalogModel(model: Model<Api>) {
  const levels = getSupportedThinkingLevels(model);
  return {
    id: model.id, name: model.name,
    context_window: model.contextWindow, max_output_tokens: model.maxTokens,
    input_modalities: model.input, reasoning: model.reasoning,
    thinking_levels: Object.fromEntries(levels.map(level => [level, level])),
    pricing: model.cost,
  };
}

try {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  // Account metadata does not resolve request auth. A status read must never
  // rotate a token or run a configured API-key command.
  const authPath = join(agentDir, "auth.json");
  if (operation === "list") {
    const auth = runtime.getProviders().filter(provider => provider.auth?.oauth).map(provider => {
      const credential = readStoredCredential(provider.id, authPath);
      return {
        id: provider.id, name: provider.auth.oauth!.name,
        type: credential?.type, configured: !!credential,
        oauth: credential?.type === "oauth",
        expiresAt: credential?.type === "oauth" ? credential.expires : undefined,
        isSubscription: provider.auth.oauth!.isSubscription === true,
      };
    });
    const profiles = auth.filter(item => item.configured).map(item => {
      const models = runtime.getModels(item.id).map(catalogModel);
      return { ...item, native: true, authType: item.type, isOAuth: item.oauth, hasApiKey: item.type === "api_key", models, modelCount: models.length };
    });
    emit({ type: "result", data: { auth, profiles } });
  } else if (operation === "catalog" || operation === "catalog-stored") {
    // Explicit user refresh may query provider model endpoints. Pi keeps its
    // own cache, including personalized OpenRouter and Radius catalogs.
    const network = operation === "catalog";
    const refreshed = await runtime.refresh({ providers: [providerId], force: network, allowNetwork: network, signal: AbortSignal.timeout(20_000) });
    const failure = refreshed.errors.get(providerId);
    if (failure && runtime.getModels(providerId).length === 0) throw failure;
    emit({ type: "result", data: { data: (await runtime.getAvailable(providerId, { signal: controller.signal })).map(catalogModel) } });
  } else if (operation === "login") {
    if (!runtime.getProvider(providerId)?.auth?.oauth) throw new Error("该 Provider 不支持 Pi OAuth 登录");
    const modelsPath = join(agentDir, "models.json");
    let config;
    try { config = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8"))?.providers?.[providerId] : undefined; }
    catch { throw new Error("Pi models.json 格式不正确，请检查模型配置"); }
    // A token must never inherit an old API gateway's endpoint. Keep that
    // profile under its own id before reusing a built-in id for a subscription.
    if (config && config.oauth !== "radius" && (config.baseUrl || config.api || config.apiKey || config.headers || config.models?.some((model: { api?: string; baseUrl?: string }) => model.api || model.baseUrl))) {
      throw new Error("该 Provider ID 已绑定自定义 API 端点。请先将该端点保存为其他 ID，再删除旧配置并登录订阅。");
    }
    await runtime.login(providerId, "oauth", { signal: controller.signal, prompt, notify: emit }, {
      getDeviceId: () => SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getOrCreateDeviceId(),
      agentName: "Orbit",
    });
    emit({ type: "done" });
  } else if (operation === "logout") {
    await runtime.logout(providerId, { signal: controller.signal });
    emit({ type: "result", data: { id: providerId, loggedOut: true } });
  } else {
    throw new Error("未知的凭据操作");
  }
} catch (error) {
  // SDK errors may include token endpoint bodies. Keep those in the process;
  // expose only their top-level message, with common secret fields redacted.
  const message = (error instanceof Error ? error.message : "登录失败")
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization)["'\s:=]+)[^\s,"'}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s,"'}]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:code|token|state)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
  emit({ type: "error", message });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  input.close();
  process.stdin.destroy();
}
