import type { RefObject } from "react";

/**
 * Galaxy 档的画布层，移植自 ozzy 的 galaxy brain effort slider
 * （mygo `examples/effort-slider`，galaxy.go / effort.go）。
 *
 * 进入 Galaxy 时：轨道被深紫底 + 闪烁像素网格填满，16 条虚线光柱从大脑
 * 向外流，28 颗像素爆开、白光闪一下，大脑变大变蓝紫（这部分在 CSS/SVG 里），
 * 卡片跟着抖 14 帧。离开时所有东西 250ms 淡出。
 */

const GALAXY_IN = 160;
const GALAXY_OUT = 250;
const PIXEL_PITCH = 4;
const PIXEL_SIZE = 3;
const RAY_FROM = 19;
const RAY_COUNT = 16;

/** 卡片进入 Galaxy 后每帧的偏移（1/60s 一帧），和 demo 里一样。 */
const SHAKE: ReadonlyArray<readonly [number, number]> = [
  [0.75, 1], [-0.78, 0.3], [0.9, -1.03], [0.4, 0.37], [0.25, 0], [0.15, -0.2],
  [0.15, 0.32], [-0.5, -0.22], [-0.22, 0], [0.15, -0.25], [-0.3, 0.35],
  [-0.22, -0.15], [-0.15, -0.08], [-0.05, -0.02],
];

/**
 * 像素、光柱、爆闪的颜色也跟主题强调色走：从算好的 `--ds-effort-accent`
 * 现场混出几档，避免画布还是写死的粉紫。
 */
type GalaxyPalette = {
  pixel: string[];
  ray: string[];
  glow: string;
  /** 轨道深底与渐变末端的深色主题色（rgba 用）。 */
  deep: string;
  deepEnd: string;
};

function rgba(hex: string, alpha: number) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixHex(a: string, b: string, amount: number) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const to = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return `#${((1 << 24) | (to(ar, br) << 16) | (to(ag, bg) << 8) | to(ab, bb)).toString(16).slice(1)}`;
}

function resolveAccentHex(root: HTMLElement | null): string {
  if (root) {
    const raw = getComputedStyle(root).getPropertyValue("--ds-effort-accent").trim();
    const parsed = parseCssColor(raw);
    if (parsed) return parsed;
  }
  return "#3b82f6";
}

/** `color-mix` 在部分环境里算出的值带空格/百分比，这里只认 hex 与 rgb()。 */
function parseCssColor(value: string): string | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return value.toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
  if (rgb) {
    const to = (x: string) => Math.min(255, Number(x)).toString(16).padStart(2, "0");
    return `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`;
  }
  return null;
}

function paletteFor(accent: string): GalaxyPalette {
  return {
    pixel: [
      mixHex(accent, "#ffffff", 0.35),
      mixHex(accent, "#ffffff", 0.15),
      accent,
      mixHex(accent, "#ffffff", 0.5),
      mixHex(accent, "#c084fc", 0.3),
      mixHex(accent, "#67e8f9", 0.35),
      mixHex(accent, "#ffffff", 0.72),
      mixHex(accent, "#ffffff", 0.55),
    ],
    ray: [mixHex(accent, "#ffffff", 0.5), mixHex(accent, "#9a9aac", 0.6), mixHex(accent, "#ffffff", 0.28)],
    glow: mixHex(accent, "#ffffff", 0.12),
    deep: mixHex(accent, "#05030d", 0.82),
    deepEnd: mixHex(accent, "#0a0618", 0.58),
  };
}

export type GalaxyField = {
  enter: () => void;
  leave: () => void;
  destroy: () => void;
};

type GalaxyFieldOptions = {
  rootRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  trackRef: RefObject<HTMLElement | null>;
};

/** 只跟参数有关的伪随机，和 demo 的 hash 一致。 */
function hash(a: number, b: number, c: number) {
  let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h & 0xffffff) / 0xffffff;
}

/** 某个像素在 t 秒时的亮度：各自按自己的节奏闪。 */
function twinkle(a: number, b: number, t: number) {
  const period = 0.7 + 1.1 * hash(a, b, 1);
  const phase = hash(a, b, 2);
  const k = (((t / period + phase) % 1) + 1) % 1;
  const on = 0.35 + 0.4 * hash(a, b, 3);
  if (k > on) return 0;
  return Math.sin((k / on) * Math.PI);
}

/** 轨道像素的呼吸亮度，0 到 1。 */
function shimmer(a: number, b: number, t: number) {
  const period = 0.5 + hash(a, b, 1);
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / period + hash(a, b, 2)));
}

function smoothstep(lo: number, hi: number, x: number) {
  const k = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return k * k * (3 - 2 * k);
}

/** 柔光位图按 (颜色, 透明度档) 缓存，和 demo 的 glows 一样。 */
const glows = new Map<string, HTMLCanvasElement>();
const GLOW_STEPS = 32;
const GLOW_N = 96;

function glowBitmap(color: string, alpha: number) {
  const step = Math.round(alpha * GLOW_STEPS);
  if (step <= 0) return null;
  const key = `${color}/${step}`;
  const cached = glows.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_N;
  canvas.height = GLOW_N;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(GLOW_N, GLOW_N);
  const [r, g, b] = hexToRgb(color);
  const a = step / GLOW_STEPS;
  for (let y = 0; y < GLOW_N; y++) {
    for (let x = 0; x < GLOW_N; x++) {
      const dx = ((x + 0.5) / GLOW_N) * 2 - 1;
      const dy = ((y + 0.5) / GLOW_N) * 2 - 1;
      const d2 = dx * dx + dy * dy;
      const v = a * Math.exp(-d2 * 4.5) * Math.max(0, 1 - d2);
      const i = (y * GLOW_N + x) * 4;
      image.data[i] = Math.round(r * v);
      image.data[i + 1] = Math.round(g * v);
      image.data[i + 2] = Math.round(b * v);
      image.data[i + 3] = Math.round(255 * v);
    }
  }
  ctx.putImageData(image, 0, 0);
  glows.set(key, canvas);
  return canvas;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

type Layout = {
  ctx: CanvasRenderingContext2D;
  /** 大脑滑块相对 demo（24px）的缩放，光柱/爆闪/柔光跟着一起缩。 */
  scale: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  trackH: number;
  thumbBase: number;
  thumbTravel: number;
};

/** 45fps 就够闪了，省下来的主线程要留给 RPC 回来的 state。 */
const FRAME_INTERVAL = 1000 / 45;

export function createGalaxyField({ rootRef, canvasRef, trackRef }: GalaxyFieldOptions): GalaxyField {
  let enteredAt = 0;
  let leftAt = 0;
  let frame = 0;
  let running = false;
  let lastDrawn = 0;
  let layout: Layout | null = null;
  let observer: ResizeObserver | null = null;
  /** 进档时抓一次主题强调色，canvas 颜色全部由它派生。 */
  let accentHex = "#3b82f6";

  const galaxyLevel = (now: number) => {
    if (!enteredAt) return 0;
    if (leftAt) return Math.max(1 - (now - leftAt) / GALAXY_OUT, 0);
    return Math.min((now - enteredAt) / GALAXY_IN, 1);
  };

  const shakeAt = (now: number): [number, number] => {
    if (!enteredAt || leftAt) return [0, 0];
    const f = ((now - enteredAt) / 1000) * 60;
    const i = Math.floor(f);
    if (f < 0 || i >= SHAKE.length) return [0, 0];
    const a = SHAKE[i];
    const b = i + 1 < SHAKE.length ? SHAKE[i + 1] : [0, 0];
    const k = f - i;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };

  /** 只在进档 / 尺寸变化时量一次几何，之后每帧只读动画进度。 */
  const measure = () => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) {
      layout = null;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx || !rect.width || !rect.height) {
      layout = null;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const styles = getComputedStyle(track);
    const thumbW = Number.parseFloat(styles.getPropertyValue("--ds-effort-thumb-w")) || 24;
    const inset = Number.parseFloat(styles.getPropertyValue("--ds-effort-thumb-inset")) || 2;
    layout = {
      ctx,
      scale: thumbW / 24,
      width: rect.width,
      height: rect.height,
      originX: trackRect.left - rect.left,
      originY: trackRect.top - rect.top,
      trackH: trackRect.height,
      thumbBase: inset + thumbW * 0.5,
      thumbTravel: Math.max(0, trackRect.width - thumbW - inset * 2),
    };
  };

  const thumbOffset = () => {
    const root = rootRef.current;
    const progress = root ? Number.parseFloat(getComputedStyle(root).getPropertyValue("--ds-effort-progress")) : 0;
    return Number.isFinite(progress) ? progress : 0;
  };

  const drawTrack = (view: Layout, thumbX: number, g: number, secs: number, palette: GalaxyPalette) => {
    const { ctx, originX, originY, trackH } = view;
    const end = thumbX - 10;
    if (end <= 0 || g <= 0) return;
    ctx.save();
    // 内缩 1px：给 CSS 的深色描边让位，画布不要盖住它。
    const inset = 1;
    const fillX = originX + inset;
    const fillY = originY + inset;
    const fillH = trackH - inset * 2;
    roundRect(ctx, fillX, fillY, Math.max(0, end - inset), fillH, Math.min(5, end / 2));
    ctx.clip();
    const gradient = ctx.createLinearGradient(originX, originY, originX + end, originY);
    gradient.addColorStop(0, rgba(palette.deep, g));
    gradient.addColorStop(1, rgba(palette.deepEnd, g));
    ctx.fillStyle = gradient;
    ctx.fillRect(fillX, fillY, Math.max(0, end - inset), fillH);

    const cols = Math.floor((thumbX - 2) / PIXEL_PITCH);
    const rows = Math.max(1, Math.floor((fillH - 1) / PIXEL_PITCH));
    for (let c = 0; c < cols; c++) {
      const x = 0.5 + c * PIXEL_PITCH;
      const u = x / Math.max(1, thumbX);
      for (let r = 0; r < rows; r++) {
        if (hash(c, r, 0) > 0.45 + u) continue;
        const bright = 0.12 + 0.88 * smoothstep(0.3, 0.95, u);
        const alpha = bright * (0.5 + 0.5 * shimmer(c, r, secs)) * g;
        if (alpha < 0.03) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = palette.pixel[Math.floor(hash(c, r, 4) * palette.pixel.length) % palette.pixel.length];
        // 3px 的像素用方块画，圆角在这个尺寸上看不出来，但快好几倍。
        ctx.fillRect(fillX + x, fillY + 0.5 + r * PIXEL_PITCH, PIXEL_SIZE, PIXEL_SIZE);
      }
    }
    ctx.restore();
  };

  const drawGlow = (ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string, alpha: number) => {
    const bitmap = glowBitmap(color, alpha);
    if (!bitmap) return;
    ctx.globalAlpha = 1;
    ctx.drawImage(bitmap, cx - radius, cy - radius, radius * 2, radius * 2);
  };

  const drawRays = (ctx: CanvasRenderingContext2D, cx: number, cy: number, g: number, secs: number, scale: number, palette: GalaxyPalette) => {
    const from = RAY_FROM * scale;
    const step = 2 * scale;
    for (let i = 0; i < RAY_COUNT; i++) {
      const angle = (i + 0.4 * hash(i, 0, 5)) * 2 * Math.PI / RAY_COUNT;
      const length = (10 + 26 * hash(i, 0, 6) * hash(i, 0, 12)) * scale;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let d = from; d < from + length; d += step) {
        const k = (d - from) / length;
        const lit = 0.4 + 0.6 * twinkle(i, Math.floor(d), secs * 1.6);
        const alpha = (1 - k) * 0.65 * lit * g;
        if (alpha < 0.03) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = palette.ray[Math.floor(hash(i, Math.floor(d), 7) * palette.ray.length) % palette.ray.length];
        ctx.fillRect(cx + d * cos - 0.5, cy + d * sin - 0.5, 1, 1);
      }
    }
  };

  const drawSparkles = (ctx: CanvasRenderingContext2D, cx: number, cy: number, g: number, secs: number, scale: number, palette: GalaxyPalette) => {
    for (let i = 0; i < 10; i++) {
      const x = cx + (-10 + 20 * hash(i, 2, 10)) * scale;
      const y = cy + (-9 + 18 * hash(i, 2, 11)) * scale;
      const alpha = twinkle(i, 99, secs * 1.3) * g;
      if (alpha < 0.05) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = i % 3 === 0 ? mixHex(palette.glow, "#ffffff", 0.5) : "#ffffff";
      ctx.fillRect(x - 0.75 * scale, y - 0.75 * scale, 1.5 * scale, 1.5 * scale);
    }
  };

  const render = (now: number) => {
    const view = layout;
    if (!view) return;
    const { ctx, originX, originY, trackH } = view;
    ctx.clearRect(0, 0, view.width, view.height);
    const g = galaxyLevel(now);
    if (g <= 0) return;
    const secs = enteredAt ? (now - enteredAt) / 1000 : 0;
    const thumbX = view.thumbBase + view.thumbTravel * thumbOffset();
    const brainY = originY + trackH / 2;
    const cx = originX + thumbX;
    const palette = paletteFor(accentHex);

    drawTrack(view, thumbX, g, secs, palette);
    const scale = view.scale;
    drawRays(ctx, cx, brainY, g, secs, scale, palette);
    drawGlow(ctx, cx, brainY, 34 * scale, palette.glow, 0.4 * g);
    drawSparkles(ctx, cx, brainY, g, secs, scale, palette);
    ctx.globalAlpha = 1;
  };

  const tick = (now: number) => {
    // 弹层关掉 / 窗口切到后台时不再画，也不占主线程。
    if (typeof document !== "undefined" && document.hidden) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const g = galaxyLevel(now);
    const [dx, dy] = shakeAt(now);
    const root = rootRef.current;
    if (root && (dx || dy || root.style.getPropertyValue("--ds-effort-shake-x") !== "0px")) {
      root.style.setProperty("--ds-effort-shake-x", `${dx.toFixed(2)}px`);
      root.style.setProperty("--ds-effort-shake-y", `${dy.toFixed(2)}px`);
    }
    // 限帧：动画还在，但主线程不会一直被 canvas 占着。
    if (now - lastDrawn >= FRAME_INTERVAL) {
      lastDrawn = now;
      render(now);
    }
    const done = g <= 0 && (!enteredAt || leftAt > 0) && now - leftAt > GALAXY_OUT;
    if (done) {
      frame = 0;
      running = false;
      root?.style.setProperty("--ds-effort-shake-x", "0px");
      root?.style.setProperty("--ds-effort-shake-y", "0px");
      if (layout) layout.ctx.clearRect(0, 0, layout.width, layout.height);
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const start = () => {
    if (running) return;
    running = true;
    lastDrawn = 0;
    measure();
    if (typeof ResizeObserver !== "undefined" && !observer && trackRef.current) {
      observer = new ResizeObserver(() => measure());
      observer.observe(trackRef.current);
    }
    frame = requestAnimationFrame(tick);
  };

  return {
    enter() {
      enteredAt = performance.now();
      leftAt = 0;
      accentHex = resolveAccentHex(rootRef.current);
      rootRef.current?.setAttribute("data-galaxy", "");
      start();
    },
    leave() {
      if (!enteredAt || leftAt) return;
      leftAt = performance.now();
      rootRef.current?.removeAttribute("data-galaxy");
      start();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      observer = null;
      layout = null;
      frame = 0;
      running = false;
      enteredAt = 0;
      leftAt = 0;
      rootRef.current?.style.setProperty("--ds-effort-shake-x", "0px");
      rootRef.current?.style.setProperty("--ds-effort-shake-y", "0px");
    },
  };
}
