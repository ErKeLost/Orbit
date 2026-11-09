// 输入延迟诊断开关：localStorage.setItem('pi-gui.perfLog','1') 后重启应用生效。
//
// 帧率/停顿/长任务/内存这些数字现在由 `perf-monitor.ts` 常驻采集（rAF 漂移 +
// 引擎 longtask + 堆占用），这里只保留「点击发送 → 下一次绘制」这个单点测量。
// 之前这个文件自己挂着第二个 rAF 循环，两边各算一份停顿：合并成一个循环，
// 数字只有一个来源，HUD 和 console 也不会互相矛盾。
import { installPerfMonitor, setPerfDiagnostics } from "./perf-monitor";

function diagnosticsEnabled() {
  return typeof localStorage !== "undefined" && localStorage.getItem("pi-gui.perfLog") === "1";
}

/** 点击发送 → 下一次绘制的耗时（开启 perfLog 时才记录）。
 * 两层 rAF：第一层在本帧绘制前，第二层在绘制之后，差值即用户感知到的响应延迟。 */
export function perfMarkSend(label = "send") {
  if (!diagnosticsEnabled()) return;
  const start = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    console.info(`[perf] ${label} → 绘制 ${Math.round(performance.now() - start)}ms`);
  }));
}

export function installPerfLog() {
  installPerfMonitor();
  setPerfDiagnostics(diagnosticsEnabled());
}
