// 输入延迟诊断开关：localStorage.setItem('pi-gui.perfLog','1') 后重启应用生效。
// WebKit 没有 longtask/long-animation-frame 观测入口，用 rAF 漂移测量主线程
// 停顿：帧间隔 >150ms 记一次 jank，>400ms 时打到 console（标注当时是否流式），
// 每 10s 汇总一次。用于对照「AI 响应时打字卡」的复现与验证修复效果。
import { useWorkspace } from "./store";

/** 点击发送 → 下一次绘制的耗时（开启 perfLog 时才记录）。
 * 两层 rAF：第一层在本帧绘制前，第二层在绘制之后，差值即用户感知到的响应延迟。 */
export function perfMarkSend(label = "send") {
  if (typeof localStorage === "undefined" || localStorage.getItem("pi-gui.perfLog") !== "1") return;
  const start = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    console.info(`[perf] ${label} → 绘制 ${Math.round(performance.now() - start)}ms`);
  }));
}

export function installPerfLog() {
  if (typeof localStorage === "undefined" || localStorage.getItem("pi-gui.perfLog") !== "1") return;
  let last = performance.now();
  let windowStart = last;
  let janks = 0;
  let worst = 0;
  const tick = (now: number) => {
    const gap = now - last;
    last = now;
    if (gap > 150) {
      janks += 1;
      worst = Math.max(worst, gap);
      if (gap > 400) {
        const running = useWorkspace.getState().transcript.running;
        console.warn(`[perf] 主线程停顿 ${Math.round(gap)}ms${running ? "（流式中）" : ""}`);
      }
    }
    if (now - windowStart >= 10000) {
      if (janks) console.info(`[perf] 10s 内 ${janks} 次主线程停顿，最长 ${Math.round(worst)}ms`);
      janks = 0;
      worst = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
