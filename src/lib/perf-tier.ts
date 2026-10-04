// 设备性能档位：低配机器自动降级流式渲染的"花活"，高配机器保持原效果。
// 判定只用同步可得的信号（核数/内存/系统"减少动态效果"），不做耗时探测；
// 用户可用 localStorage 'pi-gui.perfTier' = 'low' | 'high' 强制覆盖。
export type PerfTier = "low" | "high";

function detect(): PerfTier {
  if (typeof window === "undefined") return "high";
  try {
    const forced = localStorage.getItem("pi-gui.perfTier");
    if (forced === "low" || forced === "high") return forced;
  } catch { /* storage unavailable */ }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 8;
  const memory = nav.deviceMemory; // WebKit 不提供，缺省视为未知
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return cores <= 4 || (memory !== undefined && memory <= 4) || reduced ? "low" : "high";
}

export const perfTier: PerfTier = detect();
export const isLowPerf = perfTier === "low";

// CSS 侧通过 [data-perf="low"] 关掉无限循环动画等重绘源。
if (typeof document !== "undefined") document.documentElement.dataset.perf = perfTier;
