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

function contentRgb() {
  return parseRgb(getComputedStyle(document.body).color, "235, 238, 241");
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
    let rgb = contentRgb();
    let pattern: CanvasPattern | null = null;
    let stars: GalaxyStar[] = [];
    let drift: GalaxyDrift = { x: 0, y: 0 };
    let float = { x: true, y: true };
    let pointer: { x: number; y: number } | null = null;
    let motes: GalaxyMote[] = [];
    let width = 0;
    let height = 0;
    let nextMeteor = 0;

    // Drawn one pixel per CSS pixel, not per device pixel: the plate only ever
    // lands on whole pixels, so nearest-neighbour keeps every square exactly
    // square, and the backing store stays a quarter of the size.
    const plate = document.createElement("canvas");
    const plateCtx = plate.getContext("2d");
    const meteors: GalaxyMeteor[] = [];

    const image = new Image();
    let ready = false;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    const layout = () => {
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

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
      pattern = galaxyGridPattern(ctx, rgb, { ...GALAXY_INK, ...ink });
    };

    const draw = (time: number) => {
      if (document.hidden) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
      if (time - lastFrame < FRAME_MS) return;
      lastFrame = time;

      // Reduced motion: the plate sits at home and holds a fixed brightness,
      // which is exactly the still frame the star layer holds as well.
      const motion = !still.matches;
      const clock = motion ? time : 0;

      drift = galaxyDrift(clock, motion, float, pointer);
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = false;
      if (pattern) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, width, height);
      }
      drawGalaxyPlate(ctx, plate, drift, galaxyBreath(clock, motion));
      paintGalaxySweep(ctx, clock, width, height);
      paintGalaxyStars(ctx, stars, motion ? time : 180, rgb, ink, drift);
      if (!motion) return;

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
      if (raf) return;
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
      start();
    };
    document.addEventListener("visibilitychange", onVisible);
    still.addEventListener("change", onVisible);

    // A few pixels of give under the cursor. The pane itself is
    // `pointer-events-none`, so this watches the window and only reads the
    // position; nothing re-renders.
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer = {
        x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
        y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)),
      };
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      layout();
      onVisible();
    });
    resizeObserver.observe(root);

    // Light/dark flips the ink colour, so the whole plate has to be re-stamped.
    const themeObserver = new MutationObserver(() => {
      const next = contentRgb();
      if (next === rgb) return;
      rgb = next;
      layout();
      onVisible();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    return () => {
      cancelAnimationFrame(raf);
      image.onload = null;
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
