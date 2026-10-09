export type EffortFieldMode = "off" | "minimal" | "low" | "medium" | "high" | "extra" | "max";

type Rgb = readonly [number, number, number];

const LEVEL_PALETTE: Record<string, { base: Rgb; soft: Rgb; deep: Rgb }> = {
  off: { base: [145, 145, 150], soft: [214, 214, 218], deep: [100, 100, 106] },
  minimal: { base: [115, 159, 176], soft: [190, 216, 224], deep: [64, 117, 137] },
  low: { base: [91, 143, 205], soft: [180, 207, 239], deep: [55, 97, 160] },
  medium: { base: [83, 181, 160], soft: [177, 230, 215], deep: [44, 125, 109] },
  high: { base: [112, 161, 255], soft: [190, 211, 250], deep: [57, 105, 205] },
  extra: { base: [176, 140, 250], soft: [214, 198, 246], deep: [120, 80, 203] },
  max: { base: [211, 126, 232], soft: [233, 193, 242], deep: [151, 72, 183] },
};

const VISUAL_SLOT: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  extra: 4,
  xhigh: 4,
  max: 5,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const smoothstep = (value: number) => {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
};
const normalize = (level?: string) => (level ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const mixColor = (from: Rgb, to: Rgb, amount: number): Rgb => [
  mix(from[0], to[0], amount),
  mix(from[1], to[1], amount),
  mix(from[2], to[2], amount),
];
const rgb = (color: Rgb) => `rgb(${Math.round(color[0])} ${Math.round(color[1])} ${Math.round(color[2])})`;

export function effortLabel(level?: string) {
  if (!level || level === "off") return "Off";
  if (level === "xhigh") return "XHigh";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Medium 是速度和质量之间的推荐档，demo 里它是轨道上那根竖条。 */
export function effortIsRecommended(level?: string) {
  return effortFieldMode(level) === "medium";
}

/**
 * 最高档就是 Galaxy：demo 里它比 Max 还高一档（大脑变蓝紫、轨道变成像素网格、
 * 光柱外射），我们把它绑在最后一个可用档位上，所以最高只到 High 的模型同样能看到。
 */
export function effortIsGalaxy(level: string | undefined, levels: readonly string[]) {
  return levels.length > 0 && level === levels[levels.length - 1];
}

export function effortVisualSlot(level?: string) {
  return VISUAL_SLOT[normalize(level)] ?? 0;
}

export function effortVisualPosition(level?: string) {
  return VISUAL_SLOT[normalize(level)] ?? 0;
}

export function effortFieldMode(level?: string): EffortFieldMode {
  const canonical = normalize(level);
  if (canonical === "max") return "max";
  if (canonical === "extra" || canonical === "xhigh") return "extra";
  if (canonical === "high") return "high";
  if (canonical === "medium") return "medium";
  if (canonical === "low") return "low";
  if (canonical === "minimal") return "minimal";
  return "off";
}

export function effortColorsForLevels(levels: readonly string[], value: number) {
  const max = Math.max(0, levels.length - 1);
  const safe = clamp(Number.isFinite(value) ? value : 0, 0, max);
  const lowerIndex = Math.floor(safe);
  const upperIndex = Math.min(lowerIndex + 1, max);
  const amount = smoothstep(safe - lowerIndex);
  const palette = (level?: string) => LEVEL_PALETTE[effortFieldMode(level)];
  const lower = palette(levels[lowerIndex]);
  const upper = palette(levels[upperIndex]);
  return {
    base: rgb(mixColor(lower.base, upper.base, amount)),
    soft: rgb(mixColor(lower.soft, upper.soft, amount)),
    deep: rgb(mixColor(lower.deep, upper.deep, amount)),
  };
}

export function magnetizeEffort(value: number, targets: number[]) {
  if (!targets.length) return value;
  let nearest = targets[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const delta = Math.abs(value - target);
    if (delta < distance) {
      distance = delta;
      nearest = target;
    }
  }
  if (distance < 0.001 || distance > 0.5) return value;
  const delta = value - nearest;
  const strength = 1 - distance / 0.5;
  return value - delta * (0.68 + 0.42 * strength) * strength * strength;
}
