import { useEffect, useRef } from "react";
import {
  createMotes,
  drawGalaxyPlate,
  galaxyBreath,
  galaxyDrift,
  galaxyGridPattern,
  galaxyPlateSize,
  GALAXY_INK,
  paintGalaxy,
  paintGalaxyMeteors,
  paintGalaxyMotes,
  paintGalaxyStars,
  paintGalaxySweep,
  meteorBurst,
  spawnMeteor,
  type GalaxyDrift,
  type GalaxyInk,
  type GalaxyMeteor,
  type GalaxyMote,
  type GalaxyStar,
} from "./galaxyDots";
import { isLowPerf } from "../../lib/perf-tier";
import { isDegraded } from "../../lib/perf-monitor";

/**
 * The artwork, lossless and 1280×720. It is never shown as a picture: it is
 * sampled down to the 6px grid, so what this needs is a clean source, not a
 * big one — the previous 41KB JPEG thumbnail put compression blocks straight
 * into the dot pitch.
 */
const SOURCE = "/orbit-galaxy.png";
/** A blink does not need 60fps. */
const FRAME_MS = 40;
/** Three streaks at once, each from its own direction, then a pause. */
const METEOR_BURST = 3;
const METEOR_GAP = 9000;
const METEOR_SPREAD = 7000;

function parseRgb(value: string, fallback: string) {
  const match = value.match(/\d+/g);
  if (!match || match.length < 3) return fallback;
  return `${match[0]}, ${match[1]}, ${match[2]}`;
}

function contentRgb(element?: Element | null) {
  // Read the ink from the pane the backdrop fills, not from <body>: the empty
  // session pins itself to the dark theme, so the galaxy keeps the same light
  // ink even while the app is in light mode.
  const target = element ?? document.body;
  return parseRgb(getComputedStyle(target).color, "235, 238, 241");
}

/**
 * The empty-session backdrop: the galaxy stamped into the app's terminal grid.
 *
 * One plate of nebula squares floats as a whole and breathes, a soft band of
 * light crosses it every half minute, the artwork's bright points blink on top,
 * a few motes wander, and a meteor crosses every so often. The whole thing also
 * gives a few pixels under the cursor. `fit` mirrors `object-fit` on an `<img>`
 * — `cover` (the default) fills the pane and crops, `contain` keeps the whole
 * frame.
 */
export function GalaxyDotBackground({
  fit,
  mode,
  ink,
  anchorX,
  anchorY,
}: {
  fit?: "cover" | "contain";
  mode?: "mono" | "color";
  /** Ink overrides on top of the theme's own budget. */
  ink?: Partial<GalaxyInk>;
  anchorX?: number;
  anchorY?: number;
} = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!root || !canvas || !ctx) return;

    let raf = 0;
    let lastFrame = 0;
    let rgb = contentRgb(root);
    /** 静态网格层：布局时画一次，之后每帧只 blit，不再全屏描边。 */
    let grid: HTMLCanvasElement | null = null;
    let stars: GalaxyStar[] = [];
    let drift: GalaxyDrift = { x: 0, y: 0 };
    let float = { x: true, y: true };
    let pointer: { x: number; y: number } | null = null;
    let motes: GalaxyMote[] = [];
    let width = 0;
    let height = 0;
    let nextMeteor = 0;
    /** 元素是否在视口里（首页被滚出屏幕后不再画）。 */
    let visible = true;
    /** 静态档（低配 / 减少动态效果 / 已降级）只画一帧。 */
    let stillPainted = false;
    /** 布局算出来的矩形：指针移动时不再每次 getBoundingClientRect()。 */
    let bounds = { left: 0, top: 0, width: 0, height: 0 };

    // Drawn one pixel per CSS pixel, not per device pixel: the plate only ever
    // lands on whole pixels, so nearest-neighbour keeps every square exactly
    // square, and the backing store stays a quarter of the size.
    const plate = document.createElement("canvas");
    const plateCtx = plate.getContext("2d");
    const meteors: GalaxyMeteor[] = [];

    const image = new Image();
    let ready = false;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    // 低配档等同「减少动态效果」：只落一帧静态图，不再 25fps 重绘整块画布。
    // 首页是唯一挂着这块画布的地方，但它同时也是用户停最久的界面。
    const stillMotion = () => still.matches || isLowPerf;

    const layout = () => {
      const rect = root.getBoundingClientRect();
      bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      if (rect.width <= 0 || rect.height <= 0) {
        width = 0;
        height = 0;
        return;
      }
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      stillPainted = false;

      // 网格层：整块画一次。之前是每帧对全屏 fillRect 一次 6px 的 CanvasPattern，
      // 相当于每帧把整块画布重新描一遍边。
      const nextGrid = document.createElement("canvas");
      nextGrid.width = canvas.width;
      nextGrid.height = canvas.height;
      const gridCtx = nextGrid.getContext("2d");
      if (gridCtx) {
        gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const tile = galaxyGridPattern(gridCtx, rgb, { ...GALAXY_INK, ...ink });
        if (tile) {
          gridCtx.fillStyle = tile;
          gridCtx.fillRect(0, 0, width, height);
          grid = nextGrid;
        }
      }

      motes = createMotes(width, height);
      meteors.length = 0;
      nextMeteor = 0;
      if (!ready) return;

      const size = galaxyPlateSize(width, height);
      plate.width = size.width;
      plate.height = size.height;
      plateCtx?.setTransform(1, 0, 0, 1, 0, 0);

      if (plateCtx) {
        const stamp = paintGalaxy(plateCtx, {
          image,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          width,
          height,
          rgb,
          fit,
          mode,
          ink,
          anchorX,
          anchorY,
        });
        stars = stamp.stars;
        float = stamp.float;
      }
    };

    const draw = (time: number) => {
      if (document.hidden || !visible) {
        raf = 0;
        return;
      }
      // 面板被收起来时（切到设置/收件箱、或整块 `hidden`）这块是 0×0：继续跑
      // 25 fps 只是白烧定时器与合成器。尺寸回来时 ResizeObserver 会重新 start()。
      if (width <= 0 || height <= 0) {
        raf = 0;
        return;
      }
      // Reduced motion / 低配 / 运行时降级 / 窗口在后台：只落一帧静态图，然后
      // 彻底停下。之前这里每 40ms 把同一张静态图重画一遍，正好和「省电」相反。
      const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
      const motion = !stillMotion() && !isDegraded() && focused;
      if (motion) {
        raf = requestAnimationFrame(draw);
        if (time - lastFrame < FRAME_MS) return;
        lastFrame = time;
        stillPainted = false;
      } else if (stillPainted) {
        raf = 0;
        return;
      }

      const clock = motion ? time : 0;

      drift = galaxyDrift(clock, motion, float, pointer);
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = false;
      if (grid) {
        ctx.globalAlpha = 1;
        ctx.drawImage(grid, 0, 0, width, height);
      }
      drawGalaxyPlate(ctx, plate, drift, galaxyBreath(clock, motion));
      paintGalaxySweep(ctx, clock, width, height);
      paintGalaxyStars(ctx, stars, motion ? time : 180, rgb, ink, drift);
      if (!motion) {
        stillPainted = true;
        raf = 0;
        return;
      }

      if (time >= nextMeteor) {
        const headings = meteorBurst(METEOR_BURST);
        for (let index = 0; index < headings.length; index += 1) {
          if (meteors.length >= METEOR_BURST) break;
          // A few hundred ms apart: one shower, not one streak copied twice.
          meteors.push(spawnMeteor(width, height, time + index * 170, headings[index]));
        }
        nextMeteor = time + METEOR_GAP + Math.random() * METEOR_SPREAD;
      }
      paintGalaxyMeteors(ctx, meteors, time, rgb, ink);
      paintGalaxyMotes(ctx, motes, time, width, height, rgb, ink);
    };

    const start = () => {
      if (raf || document.hidden || !visible || width <= 0 || height <= 0) return;
      lastFrame = 0;
      raf = requestAnimationFrame(draw);
    };

    image.onload = () => {
      ready = true;
      layout();
      start();
    };
    image.src = SOURCE;

    layout();

    const onVisible = () => {
      if (document.hidden) return;
      stillPainted = false;
      start();
    };
    document.addEventListener("visibilitychange", onVisible);
    still.addEventListener("change", onVisible);
    // 窗口在后台（但没最小化）时也停：全屏画布 25fps 一直在往合成器送新纹理。
    const onFocus = () => {
      stillPainted = false;
      start();
    };
    window.addEventListener("focus", onFocus);

    // 首页被滚出视口 / 面板藏起来时别再画：25fps 的全屏画布在后台是纯浪费。
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              visible = entries.some((entry) => entry.isIntersecting);
              if (visible) {
                stillPainted = false;
                start();
              } else if (raf) {
                cancelAnimationFrame(raf);
                raf = 0;
              }
            },
            { rootMargin: "96px" },
          )
        : null;
    intersection?.observe(root);

    // A few pixels of give under the cursor. The pane itself is
    // `pointer-events-none`, so this watches the window and only reads the
    // cached rectangle — 之前每次 pointermove 都 getBoundingClientRect()，
    // 那是一次强制布局，鼠标一扫就是 120Hz 的同步 reflow。
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (!visible || stillMotion() || isDegraded() || bounds.width <= 0 || bounds.height <= 0) return;
      pointer = {
        x: Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1)),
        y: Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1)),
      };
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      layout();
      onVisible();
    });
    resizeObserver.observe(root);

    // Light/dark flips the ink colour, so the whole plate has to be re-stamped.
    // 主题切换会一次改多个属性：合并到下一帧，只重刷一次整块画布。
    let themeFrame = 0;
    const themeObserver = new MutationObserver(() => {
      if (themeFrame) return;
      themeFrame = requestAnimationFrame(() => {
        themeFrame = 0;
        const next = contentRgb(root);
        if (next === rgb) return;
        rgb = next;
        layout();
        onVisible();
      });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    return () => {
      cancelAnimationFrame(raf);
      if (themeFrame) cancelAnimationFrame(themeFrame);
      image.onload = null;
      intersection?.disconnect();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisible);
      still.removeEventListener("change", onVisible);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [fit, mode, ink, anchorX, anchorY]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
