// 设备性能档位：低配和手机自动降级流式渲染的花活，桌面高配保持原效果。
// 判定只用同步可得的信号，不做耗时探测。
// 用户可用 localStorage 'pi-gui.perfTier' = 'low' | 'high' 强制覆盖。
export type PerfTier = "low" | "high";

export function decidePerfTier(input: {
  forced?: string | null;
  cores: number;
  memory?: number;
  reduced: boolean;
  handheld: boolean;
}): PerfTier {
  if (input.forced === "low" || input.forced === "high") return input.forced;
  // A phone WebView often reports 8 cores. That is not a desktop GPU budget:
  // the galaxy, shimmer and typing dots are the things that heat the phone.
  if (input.handheld || input.cores <= 4 || (input.memory !== undefined && input.memory <= 4) || input.reduced) return "low";
  return "high";
}

export function handheldSurface(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("preview") === "mobile") return true;
  } catch { /* query string is optional */ }
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function detect(): PerfTier {
  if (typeof window === "undefined") return "high";
  let forced: string | null = null;
  try {
    forced = localStorage.getItem("pi-gui.perfTier");
  } catch { /* storage unavailable */ }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return decidePerfTier({
    forced,
    cores: nav.hardwareConcurrency ?? 8,
    memory: nav.deviceMemory,
    reduced: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    handheld: handheldSurface(),
  });
}

export const perfTier: PerfTier = detect();
export const isLowPerf = perfTier === "low";

// CSS 侧的降级规则挂在 `[data-perf-tier="low"]` 上（styles/orbit.css）。
// 这里曾经写成 `data-perf`，于是低配档只改了 JS、样式一条都没命中——降级开关
// 一直是空转的。两个都写，旧覆盖脚本按 `data-perf` 读也还能用。
if (typeof document !== "undefined") {
  document.documentElement.dataset.perfTier = perfTier;
  document.documentElement.dataset.perf = perfTier;
  if (handheldSurface()) document.documentElement.dataset.runtime = "mobile";
}
