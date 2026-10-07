import { useEffect, useRef } from "react";
import { paintGalaxy, paintGalaxyStars, type GalaxyInk, type GalaxyStar } from "./galaxyDots";

/** Shipped at 768×432; big enough for the 6px grid, small enough to sit in the bundle. */
const SOURCE = "/orbit-galaxy-background.jpg";
/** A blink does not need 60fps. */
const FRAME_MS = 40;

function parseRgb(value: string, fallback: string) {
  const match = value.match(/\d+/g);
  if (!match || match.length < 3) return fallback;
  return `${match[0]}, ${match[1]}, ${match[2]}`;
}

function contentRgb() {
  return parseRgb(getComputedStyle(document.body).color, "235, 238, 241");
}

/**
 * The empty-session backdrop: the galaxy stamped into the app's terminal grid,
 * with its bright points left to twinkle. `fit` mirrors `object-fit` on an
 * `<img>` — `cover` fills the pane and crops, `contain` keeps the whole frame.
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
    // The static layer (borders + nebula) is painted once per layout; only the
    // stars are redrawn per frame.
    const base = document.createElement("canvas");
    const baseCtx = base.getContext("2d");
    let stars: GalaxyStar[] = [];
    let width = 0;
    let height = 0;

    const image = new Image();
    let ready = false;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    const layout = () => {
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || !baseCtx) return;
      width = rect.width;
      height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      for (const target of [canvas, base]) {
        target.width = Math.floor(width * dpr);
        target.height = Math.floor(height * dpr);
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!ready) return;
      stars = paintGalaxy(baseCtx, {
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
    };

    const draw = (time: number) => {
      if (document.hidden) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
      if (time - lastFrame < FRAME_MS) return;
      lastFrame = time;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(base, 0, 0, width, height);
      // Reduced motion: hold every star at its mid-brightness instead of blinking.
      paintGalaxyStars(ctx, stars, still.matches ? 180 : time, rgb, ink);
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

    const resizeObserver = new ResizeObserver(() => {
      layout();
      onVisible();
    });
    resizeObserver.observe(root);

    // Light/dark flips the ink colour, so the whole stamp has to be redone.
    const themeObserver = new MutationObserver(() => {
      const next = contentRgb();
      if (next === rgb) return;
      rgb = next;
      layout();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    return () => {
      cancelAnimationFrame(raf);
      image.onload = null;
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
