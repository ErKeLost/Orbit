/**
 * Three.js 的 orb 出错时，不要让它把整页带走。
 *
 * 它是一个 WebGL 画布：显卡/驱动/上下文丢失都可能抛错，而这颗球在页面里是**唯一**
 * 的可视元素——一旦它 throw，React 会把整棵树卸载，用户看到的就是一块黑屏
 * （这次"语音页黑屏"就是这么来的）。所以给它一个边界：失败就退回一个用 Orb 配色
 * 画的静态渐变圆，功能照常可用。
 */
import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; colors: [string, string]; fallback?: ReactNode };

export class OrbBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[voice] orb 渲染失败，退回静态圆", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      this.props.fallback ?? (
        <div
          className="h-full w-full rounded-full"
          style={{
            background:
              `radial-gradient(circle at 34% 28%, ${this.props.colors[1]}, ${this.props.colors[0]} 62%, color-mix(in srgb, ${this.props.colors[0]} 65%, black))`,
          }}
        />
      )
    );
  }
}
