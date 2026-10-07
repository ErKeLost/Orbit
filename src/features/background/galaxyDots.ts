/**
 * The empty-session backdrop: the Orbit galaxy, stamped into the same 6px
 * terminal grid the arcade used to fill.
 *
 * The picture is never shown as a picture. It is sampled down to the grid,
 * each cell becomes one square whose opacity follows the artwork's luminance,
 * and the isolated bright points of the artwork become twinkling stars. That
 * keeps the backdrop in the app's own vocabulary (mono squares, 6px pitch, a
 * 6% graph-paper border) while still reading as the galaxy.
 *
 * The picture meets the pane exactly like `object-fit` on an `<img>`: `cover`
 * fills and crops, `contain` keeps the whole frame and lets the paper show
 * around it, top and bottom edges dissolving into the grid.
 *
 * Pure canvas code with no React in it, so it can be driven from a component,
 * a test, or a scratch page.
 */

/** Retina-independent backdrops; matches the terminal grid rhythm. */
export const CELL = 6;
export const GAP = 1;
export const PITCH = CELL + GAP;

/**
 * The ink budget, per theme. On a dark surface the galaxy is drawn with light
 * ink, so it can carry real contrast. On a light surface dark ink piles up
 * fast: the same numbers turn the nebula into a grey smear behind the
 * composer, so light mode keeps its distance — only the star-forming areas
 * and the brightest points make it onto the paper, and nothing that would
 * out-shout the text in front of it.
 */
export type GalaxyInk = {
  /** Graph-paper border every cell carries, same as the arcade grid. */
  border: number;
  /** Where a pixel stops being "sky" and starts being nebula. */
  nebulaFloor: number;
  /** Brightest nebula cell. */
  nebulaPeak: number;
  nebulaGamma: number;
  /** A cell this bright, and this much brighter than its neighbours, is a star. */
  starFloor: number;
  starGap: number;
  starPeak: number;
  /** What the squares are painted with when the caller has no preference. */
  mode: "mono" | "color";
  /** How far the artwork's own hues are pushed apart. */
  sat: number;
};

export const DARK_INK: GalaxyInk = {
  border: 0.06,
  nebulaFloor: 0.08,
  nebulaPeak: 0.4,
  nebulaGamma: 1.5,
  starFloor: 0.6,
  starGap: 0.22,
  starPeak: 0.85,
  mode: "mono",
  sat: 1,
};

/**
 * Light mode prints the artwork in its own colours. Grey ink at light-theme
 * strength reads as dirt; the same dots in the picture's own lavender read as
 * a watercolour print, and they can carry more presence without ever getting
 * darker than the text in front of them.
 */
export const LIGHT_INK: GalaxyInk = {
  border: 0.05,
  nebulaFloor: 0.12,
  nebulaPeak: 0.85,
  nebulaGamma: 1.2,
  starFloor: 0.6,
  starGap: 0.26,
  starPeak: 0.8,
  mode: "color",
  sat: 1.4,
};

/** Star side in px, from the dimmest to the brightest one. */
const STAR_SIZE = [2, 4] as const;
/** Fraction of the picture's width/height kept beyond the pane (`cover` overscan). */
const OVERSCAN = 1.06;
/**
 * How the picture meets the pane, like `object-fit` on an `<img>`:
 * `cover` fills the pane and crops, `contain` keeps the whole picture and
 * leaves the paper showing around it.
 */
const FIT: "cover" | "contain" = "contain";
/** `object-position`, 0 = left/top edge, 1 = right/bottom edge. */
const ANCHOR_X = 0.5;
const ANCHOR_Y = 0.5;
/** In `contain`, the picture's top and bottom rows dissolve into the paper. */
const FEATHER = 0.16;

export type GalaxyStar = {
  /** Centre, in CSS px of the pane. */
  x: number;
  y: number;
  /** Side of the square, in px. */
  size: number;
  /** Radians offset so no two stars blink together. */
  phase: number;
  /** Radians per millisecond. */
  speed: number;
  /** The artwork's own hue, when the squares are painted in colour. */
  color: string | null;
};

export type GalaxyPaintOptions = {
  image: CanvasImageSource;
  /** Intrinsic size of `image`, for the cover fit. */
  imageWidth: number;
  imageHeight: number;
  /** Pane size in CSS px. */
  width: number;
  height: number;
  /** Theme content colour as an `r, g, b` triple. */
  rgb: string;
  /** `"mono"` tints every square with the theme; `"color"` keeps the artwork's. */
  mode?: "mono" | "color";
  /** Overrides the module default, so a caller can try both fits. */
  fit?: "cover" | "contain";
  anchorX?: number;
  anchorY?: number;
  /** Ink overrides on top of the theme's own budget. */
  ink?: Partial<GalaxyInk>;
};

/** One downsampled cell of the picture. */
type Texel = { r: number; g: number; b: number; lum: number };

/** Where the picture landed on the grid, in cells. */
type FitRect = { x: number; y: number; w: number; h: number };

let sampler: HTMLCanvasElement | null = null;
let samplerCtx: CanvasRenderingContext2D | null = null;
let texels: Texel[] = [];
let rect: FitRect = { x: 0, y: 0, w: 0, h: 0 };
let texelKey = "";

function luminance(r: number, g: number, b: number) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Draw the sampled picture at grid resolution, once per size.
 * `getImageData` is the expensive part, so it is cached by `cols×rows`.
 */
function sample(
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  cols: number,
  rows: number,
  fit: "cover" | "contain",
  anchorX: number,
  anchorY: number,
) {
  const key = `${cols}x${rows}:${imageWidth}x${imageHeight}:${fit}:${anchorX}:${anchorY}`;
  if (key === texelKey && texels.length === cols * rows) return { texels, rect };

  if (!sampler) {
    sampler = document.createElement("canvas");
    samplerCtx = sampler.getContext("2d", { willReadFrequently: true });
  }
  const ctx = samplerCtx;
  if (!sampler || !ctx) return { texels, rect };

  sampler.width = cols;
  sampler.height = rows;
  ctx.clearRect(0, 0, cols, rows);

  // Same maths as object-fit: cover fills and crops, contain leaves paper around.
  const ratio =
    fit === "cover"
      ? Math.max(cols / imageWidth, rows / imageHeight) * OVERSCAN
      : Math.min(cols / imageWidth, rows / imageHeight);
  const w = imageWidth * ratio;
  const h = imageHeight * ratio;
  const dx = (cols - w) * anchorX;
  const dy = (rows - h) * anchorY;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, dx, dy, w, h);

  const data = ctx.getImageData(0, 0, cols, rows).data;
  const next: Texel[] = new Array(cols * rows);
  for (let i = 0, p = 0; i < next.length; i++, p += 4) {
    const r = data[p] ?? 0;
    const g = data[p + 1] ?? 0;
    const b = data[p + 2] ?? 0;
    next[i] = { r, g, b, lum: luminance(r, g, b) };
  }
  texels = next;
  rect = { x: dx, y: dy, w, h };
  texelKey = key;
  return { texels, rect };
}

function saturate(texel: Texel, boost: number) {
  const l = texel.lum * 255;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `${clamp(l + (texel.r - l) * boost)}, ${clamp(l + (texel.g - l) * boost)}, ${clamp(l + (texel.b - l) * boost)}`;
}

/**
 * Which budget the theme earns, read straight off the ink it hands us: dark
 * text means a light surface.
 */
function toneFor(rgb: string): GalaxyInk {
  const [r, g, b] = rgb.split(",").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return DARK_INK;
  return luminance(r, g, b) < 0.5 ? LIGHT_INK : DARK_INK;
}

/**
 * Stamp the static layer — graph-paper borders plus every nebula square — and
 * collect the stars the caller should animate on top of it.
 */
export function paintGalaxy(ctx: CanvasRenderingContext2D, options: GalaxyPaintOptions): GalaxyStar[] {
  const { image, imageWidth, imageHeight, width, height, rgb } = options;
  const ink = { ...toneFor(rgb), ...options.ink };
  const mode = options.mode ?? ink.mode;
  const fit = options.fit ?? FIT;
  const anchorX = options.anchorX ?? ANCHOR_X;
  const anchorY = options.anchorY ?? ANCHOR_Y;
  const cols = Math.max(1, Math.ceil(width / PITCH));
  const rows = Math.max(1, Math.ceil(height / PITCH));
  const { texels: cells, rect: fitRect } = sample(
    image,
    imageWidth,
    imageHeight,
    cols,
    rows,
    fit,
    anchorX,
    anchorY,
  );
  // In `contain` the picture has edges inside the pane; soften them so the
  // stamp fades into the paper instead of stopping on a line.
  const feather = fit === "contain" ? Math.max(1, fitRect.h * FEATHER) : 0;
  const edge = (y: number) => {
    if (feather <= 0) return 1;
    const top = (y - fitRect.y) / feather;
    const bottom = (fitRect.y + fitRect.h - 1 - y) / feather;
    return Math.max(0, Math.min(1, Math.min(top, bottom)));
  };

  const stars: GalaxyStar[] = [];
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(${rgb}, ${ink.border})`;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      const texel = cells[index];
      const px = x * PITCH;
      const py = y * PITCH;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
      if (!texel) continue;

      if (isStar(cells, cols, rows, x, y, texel, ink) && edge(y) > 0) {
        // Skipped here: the star layer redraws it every frame.
        stars.push(star(x, y, texel, index, ink, mode === "color"));
        continue;
      }

      if (texel.lum <= ink.nebulaFloor) continue;
      const dissolve = edge(y);
      if (dissolve <= 0) continue;
      const lit = Math.min(1, (texel.lum - ink.nebulaFloor) / (1 - ink.nebulaFloor));
      const alpha = ink.nebulaPeak * lit ** ink.nebulaGamma * dissolve;
      if (alpha <= 0.012) continue;
      ctx.fillStyle = `rgba(${mode === "color" ? saturate(texel, ink.sat) : rgb}, ${alpha})`;
      ctx.fillRect(px, py, CELL, CELL);
    }
  }

  return stars;
}

/** Redraw the stars, each on its own blink. `time` is a millisecond clock. */
export function paintGalaxyStars(
  ctx: CanvasRenderingContext2D,
  stars: GalaxyStar[],
  time: number,
  rgb: string,
  overrides?: Partial<GalaxyInk>,
) {
  if (!stars.length) return;
  const ink = { ...toneFor(rgb), ...overrides };
  for (const star of stars) {
    const blink = 0.5 + 0.5 * Math.sin(time * star.speed + star.phase);
    const alpha = ink.starPeak * (0.3 + 0.7 * blink);
    if (alpha <= 0.02) continue;
    ctx.fillStyle = star.color ?? `rgb(${rgb})`;
    ctx.globalAlpha = alpha;
    ctx.fillRect(
      Math.round(star.x - star.size / 2),
      Math.round(star.y - star.size / 2),
      star.size,
      star.size,
    );
  }
  ctx.globalAlpha = 1;
}

/** Bright, and clearly brighter than the sky around it — so clouds stay clouds. */
function isStar(
  cells: Texel[],
  cols: number,
  rows: number,
  x: number,
  y: number,
  texel: Texel,
  ink: GalaxyInk,
) {
  if (texel.lum < ink.starFloor) return false;
  let sum = 0;
  let count = 0;
  for (let ny = y - 1; ny <= y + 1; ny++) {
    for (let nx = x - 1; nx <= x + 1; nx++) {
      if (nx === x && ny === y) continue;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      sum += cells[ny * cols + nx]?.lum ?? 0;
      count++;
    }
  }
  return count > 0 && texel.lum - sum / count >= ink.starGap;
}

function star(
  x: number,
  y: number,
  texel: Texel,
  index: number,
  ink: GalaxyInk,
  color: boolean,
): GalaxyStar {
  // A cheap hash so a cell's blink pattern is stable across repaints.
  const hash = (index * 2654435761) % 4294967296;
  const pick = (hash % 1000) / 1000;
  const bright = Math.min(1, (texel.lum - ink.starFloor) / (1 - ink.starFloor));
  return {
    x: x * PITCH + CELL / 2,
    y: y * PITCH + CELL / 2,
    size: Math.round(STAR_SIZE[0] + (STAR_SIZE[1] - STAR_SIZE[0]) * bright),
    phase: pick * Math.PI * 2,
    speed: 0.0011 + ((hash >> 10) % 7) * 0.00021,
    color: color ? `rgb(${saturate(texel, ink.sat)})` : null,
  };
}
