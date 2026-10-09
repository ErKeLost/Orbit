import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "./native";
import type { RuntimeTarget } from "./store"

export type RuntimeEnvironment = {
  target: Extract<RuntimeTarget, "desktop" | "mobile">
  platform: string
}

function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  if (!value || typeof value !== "object") return false
  const environment = value as Record<string, unknown>
  return (environment.target === "desktop" || environment.target === "mobile")
    && typeof environment.platform === "string"
    && environment.platform.length > 0
}

export async function detectRuntimeEnvironment(): Promise<RuntimeEnvironment | { target: "browser"; platform: "browser" }> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("preview") === "mobile") {
    return { target: "mobile", platform: "preview" }
  }
  if (!isTauri()) return { target: "browser", platform: "browser" }
  const environment: unknown = await invoke("runtime_environment")
  if (!isRuntimeEnvironment(environment)) throw new Error("Orbit 返回了无效的运行环境")
  return environment
}
