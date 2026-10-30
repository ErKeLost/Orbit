/**
 * 主题 → ElevenLabs Orb 的两个颜色。
 *
 * 那个 orb 是 Three.js 画的，只接受 `[string, string]`（一浅一深，用来做渐变），
 * 而不是一套语义色。所以这里只做一件事：把 Orbit 的 `--color-accent` 归一化成 hex，
 * 再往白、往黑各混一档，深浅主题各一套比例。
 *
 * 归一化走 canvas 的 `fillStyle`：`hsl()` / `oklch()` / `color-mix()` 都能吃进去，
 * 手写解析一定会漏掉某个语法。
 */
import { useEffect, useState } from "react";
import { useAppearance } from "../../../lib/appearance";

function toHex(color: string): string | null {
  if (!color) return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#000000";
  context.fillStyle = color.trim();
  const resolved = context.fillStyle;
  if (typeof resolved !== "string") return null;
  if (resolved.startsWith("#")) return resolved.slice(0, 7).toUpperCase();
  const match = resolved.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const [r, g, b] = match[1]!.split(",").map((part) => Number.parseFloat(part));
  if ([r, g, b].some((value) => !Number.isFinite(value))) return null;
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`.toUpperCase();
}

function mix(a: string, b: string, ratio: number): string {
  const parse = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const blend = (x: number, y: number) => Math.min(255, Math.max(0, Math.round(x + (y - x) * ratio)));
  const hex = (value: number) => value.toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(blend(ar!, br!))}${hex(blend(ag!, bg!))}${hex(blend(ab!, bb!))}`;
}

function build(): [string, string] {
  const styles = getComputedStyle(document.documentElement);
  const accent = toHex(styles.getPropertyValue("--color-accent")) ?? "#459BF7";
  const light = document.documentElement.classList.contains("theme-light");
  // 一浅一深：浅色主题下把两档都提亮，否则白底上像一块脏石头。
  return light
    ? [mix(accent, "#FFFFFF", 0.72), mix(accent, "#000000", 0.06)]
    : [mix(accent, "#FFFFFF", 0.58), mix(accent, "#000000", 0.28)];
}

export function useOrbColors(): [string, string] {
  const signature = useAppearance((state) => `${state.scheme}|${state.accent ?? ""}|${state.hue}|${state.saturation}`);
  const [colors, setColors] = useState<[string, string]>(build);

  useEffect(() => {
    // 等一帧：主题变量是这次渲染里刚写到 :root 上的。
    const frame = requestAnimationFrame(() => setColors(build()));
    return () => cancelAnimationFrame(frame);
  }, [signature]);

  return colors;
}
