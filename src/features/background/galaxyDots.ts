/**
 * The empty-session backdrop: the Orbit galaxy, stamped into the same 6px
 * terminal grid the arcade used to fill.
 *
 * The picture is never shown as a picture. It is sampled down to the grid,
 * each cell becomes one square whose opacity follows the artwork's luminance,
 * and the isolated bright points of the artwork become twinkling stars. That
 * keeps the backdrop in the app's own vocabulary (mono squares, 6px pitch, a
 * 5% graph-paper border) while still reading as the galaxy.
 *
 * The ink is not the theme's ink: on a dark surface the squares keep the
 * artwork's own colours, and the lightness lives in the colour rather than in
 * the opacity. An opacity that tracked luminance would encode brightness twice
 * and flatten the pastel gradients into contour bands.
 *
 * The nebula is stamped once into a canvas a few cells wider than the pane and
 * then blitted at whole-pixel offsets with smoothing off, so a frame costs one
 * draw and every square stays exactly on the grid. It floats as a single plate:
 * splitting it into layers that drift at different speeds tears a hole wherever
 * a layer's edge slides off its neighbour's, and a hole in this grid is a fat
 * black contour line. The parallax lives in the star layer and the ambient
 * instead, which have no edges to tear.
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
 * Cells of headroom the plate keeps on each side. The plate drifts by at most a
 * couple of cells, so this is what stops a drift from pulling its edge into the
 * pane.
 */
export const PAD = 5;

/**
 * The ink budget. One budget for both themes, on purpose: the picture is pastel
 * and the two cloud creatures are what carry it, so light and dark print the
 * same mosaic and only the paper under it changes. A mono rendering collapses
 * the whole thing into a grey wash, and a budget that tracked the theme would
 * give light mode a different picture.
 */
export type GalaxyInk = {
  /** Graph-paper border every cell carries, same as the arcade grid. */
  border: number;
  /** Where a pixel stops being "sky" and starts being nebula. */
  nebulaFloor: number;
  /** Brightest nebula cell. */
  nebulaPeak: number;
  /**
   * Below 1 the shadows are lifted: the colour keeps the contrast and the
   * opacity stays out of the way.
   */
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

export const GALAXY_INK: GalaxyInk = {
  border: 0.05,
  nebulaFloor: 0.06,
  nebulaPeak: 0.2,
  nebulaGamma: 0.5,
  starFloor: 0.74,
  starGap: 0.16,
  starPeak: 0.95,
  mode: "color",
  // Below 1 pulls the artwork's hues toward their own grey, so the nebula
  // prints as pastel instead of as the vivid blue the PNG carries.
  sat: 0.8,
};

/**
 * How far the plate floats, in cells, and how slowly. Two periods that do not
 * divide into each other, so the plate never retraces the same path.
 */
const GALAXY_DRIFT = { x: 0.8, y: 0.34, speed: 0.000121, tilt: 0.69, phase: 2.2 } as const;

/** Slow alpha breathing, so the plate is never perfectly still. */
const GALAXY_BREATH = { depth: 0.1, speed: 0.00028, phase: 1.1 } as const;

/** Star side in px, from the dimmest to the brightest one. */
const STAR_SIZE = [2, 4] as const;
/** How far the cursor may push the picture, in px. */
const PARALLAX = 3;
/**
 * How far the plate may float, in cells. `cover` buys exactly this much
 * headroom on every side so that a float can never pull an edge into the pane.
 */
const DRIFT_MAX = Math.max(GALAXY_DRIFT.x, GALAXY_DRIFT.y);
/**
 * How the picture meets the pane, like `object-fit` on an `<img>`:
 * `cover` fills the pane and crops, `contain` keeps the whole picture and
 * leaves the paper showing around it.
 */
const FIT: "cover" | "contain" = "cover";
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

/** How far the plate has floated from home, in CSS px. */
export type GalaxyDrift = { x: number; y: number };

/** Everything a frame needs that was found in the artwork. */
export type GalaxyStamp = {
  stars: GalaxyStar[];
  /**
   * Whether the picture has room to float on each axis without pulling an edge
   * into the pane. In `contain` the picture is flush with the pane on one axis,
   * and floating along it would open a seam of bare paper at the pane's edge.
   */
  float: { x: boolean; y: boolean };
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

/** Where the picture landed on the grid, in cells of the plate canvas. */
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
 * Draw the sampled picture at grid resolution, once per size. `getImageData` is
 * the expensive part, so it is cached by grid size — and the grid is the plate
 * canvas, which is `padX`/`padY` cells wider than the pane on every side.
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
  padX: number,
  padY: number,
) {
  const plateCols = cols + padX * 2;
  const plateRows = rows + padY * 2;
  const key = `${cols}x${rows}+${padX}x${padY}:${imageWidth}x${imageHeight}:${fit}:${anchorX}:${anchorY}`;
  if (key === texelKey && texels.length === plateCols * plateRows) return { texels, rect };

  if (!sampler) {
    sampler = document.createElement("canvas");
    samplerCtx = sampler.getContext("2d", { willReadFrequently: true });
  }
  const ctx = samplerCtx;
  if (!sampler || !ctx) return { texels, rect };

  sampler.width = plateCols;
  sampler.height = plateRows;
  ctx.clearRect(0, 0, plateCols, plateRows);

  // Same maths as object-fit: cover fills and crops, contain leaves paper
  // around. `cover` is asked for the pane plus the drift headroom, so it crops
  // about two cells more than `object-fit: cover` would and is otherwise the
  // same thing. The pane is measured without the pad, then shifted into the
  // plate.
  const margin = DRIFT_MAX + 1;
  const ratio =
    fit === "cover"
      ? Math.max((cols + margin * 2) / imageWidth, (rows + margin * 2) / imageHeight)
      : Math.min(cols / imageWidth, rows / imageHeight);
  const w = imageWidth * ratio;
  const h = imageHeight * ratio;
  const dx = (cols - w) * anchorX + padX;
  const dy = (rows - h) * anchorY + padY;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, dx, dy, w, h);

  const data = ctx.getImageData(0, 0, plateCols, plateRows).data;
  const next: Texel[] = new Array(plateCols * plateRows);
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
  return `rgb(${clamp(l + (texel.r - l) * boost)}, ${clamp(l + (texel.g - l) * boost)}, ${clamp(l + (texel.b - l) * boost)})`;
}

/* --------------------------------------------------------------------------
 * Layers
 * ----------------------------------------------------------------------- */

/** Size the plate canvas must be for a pane, in CSS px. */
export function galaxyPlateSize(width: number, height: number) {
  return {
    width: (Math.max(1, Math.ceil(width / PITCH)) + PAD * 2) * PITCH,
    height: (Math.max(1, Math.ceil(height / PITCH)) + PAD * 2) * PITCH,
  };
}

let gridTile: HTMLCanvasElement | null = null;
let gridTileKey = "";

/**
 * The graph paper as one repeating 7×7 tile. A frame then costs a single
 * `fillRect` instead of one stroke per cell, and the tile stays sharp because
 * it is drawn with smoothing off, one pixel per CSS pixel.
 */
export function galaxyGridPattern(
  ctx: CanvasRenderingContext2D,
  rgb: string,
  ink: GalaxyInk,
): CanvasPattern | null {
  const key = `${rgb}|${ink.border}`;
  if (!gridTile || gridTileKey !== key) {
    const tile = document.createElement("canvas");
    tile.width = PITCH;
    tile.height = PITCH;
    const tileCtx = tile.getContext("2d");
    if (!tileCtx) return null;
    tileCtx.lineWidth = 1;
    tileCtx.strokeStyle = `rgba(${rgb}, ${ink.border})`;
    tileCtx.strokeRect(0.5, 0.5, CELL - 1, CELL - 1);
    gridTile = tile;
    gridTileKey = key;
  }
  return ctx.createPattern(gridTile, "repeat");
}

/**
/**
 * Stamp the plate — nebula squares only, no borders — and collect the stars the
 * caller should animate on top of it. The plate is drawn a `PAD` cells wider
 * than the pane on every side, so `drawGalaxyPlate` can slide it.
 */
export function paintGalaxy(
  ctx: CanvasRenderingContext2D,
  options: GalaxyPaintOptions,
  padX = PAD,
  padY = PAD,
): GalaxyStamp {
  const { image, imageWidth, imageHeight, width, height, rgb } = options;
  const ink = { ...GALAXY_INK, ...options.ink };
  const mode = options.mode ?? ink.mode;
  const fit = options.fit ?? FIT;
  const anchorX = options.anchorX ?? ANCHOR_X;
  const anchorY = options.anchorY ?? ANCHOR_Y;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const cols = Math.max(1, Math.ceil(width / PITCH));
  const rows = Math.max(1, Math.ceil(height / PITCH));
  const plateCols = cols + padX * 2;
  const plateRows = rows + padY * 2;
  const { texels: cells, rect: fitRect } = sample(
    image,
    imageWidth,
    imageHeight,
    cols,
    rows,
    fit,
    anchorX,
    anchorY,
    padX,
    padY,
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
  const mono = `rgb(${rgb})`;

  for (let y = 0; y < plateRows; y++) {
    const dissolve = edge(y);
    for (let x = 0; x < plateCols; x++) {
      const texel = cells[y * plateCols + x];
      if (!texel) continue;
      if (dissolve > 0 && isStar(cells, plateCols, plateRows, x, y, texel, ink)) {
        stars.push(star(x - padX, y - padY, texel, y * plateCols + x, ink, mode === "color"));
      }
      if (texel.lum <= ink.nebulaFloor || dissolve <= 0) continue;
      const lit = Math.min(1, (texel.lum - ink.nebulaFloor) / (1 - ink.nebulaFloor));
      const alpha = ink.nebulaPeak * lit ** ink.nebulaGamma * dissolve;
      if (alpha <= 0.012) continue;
      // A star keeps the square it would have had, so nothing punches a hole
      // that would then have to move with the plate.
      ctx.fillStyle = mode === "color" ? saturate(texel, ink.sat) : mono;
      ctx.fillRect(x * PITCH, y * PITCH, CELL, CELL);
    }
  }

  // The picture only has room to float on an axis if it hangs over the pane on
  // both of that axis's sides. In `contain` it is flush with one pair of edges,
  // and floating along it would drag a bare seam in from the pane's edge.
  const left = fitRect.x - padX;
  const top = fitRect.y - padY;
  const float = {
    x: left <= -DRIFT_MAX && cols - (left + fitRect.w) <= -DRIFT_MAX,
    y: top <= -DRIFT_MAX && rows - (top + fitRect.h) <= -DRIFT_MAX,
  };

  return { stars, float };
}

/** Where the plate has floated to, in CSS px. `time` is a millisecond clock. */
export function galaxyDrift(
  time: number,
  motion = true,
  float: { x: boolean; y: boolean } = { x: true, y: true },
  pointer: { x: number; y: number } | null = null,
): GalaxyDrift {
  if (!motion) return { x: 0, y: 0 };
  const x = float.x ? Math.sin(time * GALAXY_DRIFT.speed + GALAXY_DRIFT.phase) * GALAXY_DRIFT.x * PITCH : 0;
  const y = float.y
    ? Math.cos(time * GALAXY_DRIFT.speed * GALAXY_DRIFT.tilt + GALAXY_DRIFT.phase * 1.3) *
      GALAXY_DRIFT.y *
      PITCH
    : 0;
  if (!pointer) return { x, y };
  // A little give under the cursor, on the axes that have room for it.
  return {
    x: x + (float.x ? pointer.x * PARALLAX : 0),
    y: y + (float.y ? pointer.y * PARALLAX : 0),
  };
}

/** The plate's slow alpha breathing, as a multiplier around 1. */
export function galaxyBreath(time: number, motion = true) {
  if (!motion) return 1 + GALAXY_BREATH.depth * Math.sin(GALAXY_BREATH.phase);
  return Math.max(
    0,
    Math.min(1, 1 + GALAXY_BREATH.depth * Math.sin(time * GALAXY_BREATH.speed + GALAXY_BREATH.phase)),
  );
}

/**
 * Blit the plate at its drift, snapped to whole CSS pixels. Two copies a pixel
 * apart would close the 1px gap between squares and turn the dot matrix into a
 * woven wash, and rounding is what keeps every square exactly on the grid while
 * the galaxy still moves — a step is one pixel, so it reads as motion and never
 * as a jump.
 */
export function drawGalaxyPlate(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement | null,
  drift: GalaxyDrift,
  breath: number,
) {
  if (!canvas) return;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = breath;
  ctx.drawImage(canvas, Math.round(drift.x) - PAD * PITCH, Math.round(drift.y) - PAD * PITCH);
  ctx.globalAlpha = 1;
}

/** Redraw the stars, each on its own blink, riding the plate they sit on. */
export function paintGalaxyStars(
  ctx: CanvasRenderingContext2D,
  stars: GalaxyStar[],
  time: number,
  rgb: string,
  overrides?: Partial<GalaxyInk>,
  drift?: GalaxyDrift,
) {
  if (!stars.length) return;
  const ink = { ...GALAXY_INK, ...overrides };
  const ox = drift ? Math.round(drift.x) : 0;
  const oy = drift ? Math.round(drift.y) : 0;
  for (const star of stars) {
    const blink = 0.5 + 0.5 * Math.sin(time * star.speed + star.phase);
    const alpha = ink.starPeak * (0.3 + 0.7 * blink);
    if (alpha <= 0.02) continue;
    ctx.fillStyle = star.color ?? `rgb(${rgb})`;
    ctx.globalAlpha = alpha;
    ctx.fillRect(
      Math.round(star.x - star.size / 2) + ox,
      Math.round(star.y - star.size / 2) + oy,
      star.size,
      star.size,
    );
  }
  ctx.globalAlpha = 1;
}

/* --------------------------------------------------------------------------
 * Ambient
 *
 * Motes and meteors are not in the artwork: they are the two things a night sky
 * is allowed to do on its own, and they cost a few dozen squares a frame.
 * ----------------------------------------------------------------------- */

export type GalaxyMote = {
  /** Start, in CSS px. */
  x: number;
  y: number;
  /** Drift velocity, px per millisecond. */
  vx: number;
  vy: number;
  size: number;
  /** Radians per millisecond, and the offset that keeps them out of step. */
  speed: number;
  phase: number;
};

/** A dozen slow motes, wandering across the pane on their own clock. */
export function createMotes(width: number, height: number, count = 14): GalaxyMote[] {
  const motes: GalaxyMote[] = [];
  for (let i = 0; i < count; i++) {
    motes.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: 0.004 + Math.random() * 0.013,
      vy: -0.006 + Math.random() * 0.013,
      size: Math.random() < 0.3 ? 3 : 2,
      speed: 0.0006 + Math.random() * 0.0013,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return motes;
}

export function paintGalaxyMotes(
  ctx: CanvasRenderingContext2D,
  motes: GalaxyMote[],
  time: number,
  width: number,
  height: number,
  rgb: string,
  overrides?: Partial<GalaxyInk>,
) {
  if (!motes.length) return;
  const ink = { ...GALAXY_INK, ...overrides };
  const margin = 24;
  const spanX = width + margin * 2;
  const spanY = height + margin * 2;
  ctx.fillStyle = `rgb(${rgb})`;
  for (const mote of motes) {
    const glow = 0.5 + 0.5 * Math.sin(time * mote.speed + mote.phase);
    const alpha = ink.starPeak * glow * glow * 0.5;
    if (alpha <= 0.02) continue;
    const x = wrap(mote.x + mote.vx * time, spanX) - margin;
    const y = wrap(mote.y + mote.vy * time, spanY) - margin;
    ctx.globalAlpha = alpha;
    ctx.fillRect(Math.round(x), Math.round(y), mote.size, mote.size);
  }
  ctx.globalAlpha = 1;
}

function wrap(value: number, span: number) {
  const rest = value % span;
  return rest < 0 ? rest + span : rest;
}

export type GalaxyMeteor = {
  /** Where it started, in CSS px, and the unit direction it is heading. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** px per millisecond. */
  speed: number;
  born: number;
  life: number;
  /** Tail length in px. */
  length: number;
};

/** One heading, for a streak crossing on its own. */
export function meteorHeading() {
  const fromLeft = Math.random() < 0.5;
  const slope = 0.35 + Math.random() * 0.5;
  const run = Math.hypot(1, slope);
  return { dx: (fromLeft ? 1 : -1) / run, dy: slope / run };
}

/**
 * A burst's headings, and they have to read as different directions: the sides
 * alternate and no two slopes match, so three streaks arriving together look
 * like a shower rather than a stamp.
 */
export function meteorBurst(count: number) {
  const firstFromLeft = Math.random() < 0.5;
  return Array.from({ length: count }, (_, index) => {
    const fromLeft = index % 2 === 0 ? firstFromLeft : !firstFromLeft;
    const slope = 0.28 + ((index + Math.random()) / count) * 0.62;
    const run = Math.hypot(1, slope);
    return { dx: (fromLeft ? 1 : -1) / run, dy: slope / run };
  });
}

/** One streak, making a shallow diagonal pass across the pane. */
export function spawnMeteor(
  width: number,
  height: number,
  time: number,
  heading: { dx: number; dy: number } = meteorHeading(),
): GalaxyMeteor {
  const speed = 0.28 + Math.random() * 0.34;
  return {
    x: heading.dx > 0 ? -40 : width + 40,
    y: -20 + Math.random() * height * 0.7,
    dx: heading.dx,
    dy: heading.dy,
    speed,
    born: time,
    life: (Math.hypot(width, height) * 1.2) / speed,
    length: 90 + Math.random() * 130,
  };
}

/**
 * Draw the streaks as staircases of single squares, so a meteor is made of the
 * same 6px blocks as everything else. Dead meteors are dropped on the way.
 */
export function paintGalaxyMeteors(
  ctx: CanvasRenderingContext2D,
  meteors: GalaxyMeteor[],
  time: number,
  rgb: string,
  overrides?: Partial<GalaxyInk>,
) {
  if (!meteors.length) return;
  const ink = { ...GALAXY_INK, ...overrides };
  ctx.fillStyle = `rgb(${rgb})`;
  for (let i = meteors.length - 1; i >= 0; i--) {
    const meteor = meteors[i];
    const age = time - meteor.born;
    if (age < 0 || age > meteor.life) {
      meteors.splice(i, 1);
      continue;
    }
    const progress = age / meteor.life;
    const envelope = Math.min(1, progress / 0.12) * Math.min(1, (1 - progress) / 0.35);
    if (envelope <= 0.02) continue;
    const headX = meteor.x + meteor.dx * meteor.speed * age;
    const headY = meteor.y + meteor.dy * meteor.speed * age;
    const steps = Math.max(1, Math.floor(meteor.length / PITCH));
    for (let step = 0; step <= steps; step++) {
      const tail = 1 - step / (steps + 1);
      const alpha = ink.starPeak * envelope * tail * tail;
      if (alpha <= 0.02) continue;
      const x = Math.round((headX - meteor.dx * step * PITCH) / PITCH) * PITCH;
      const y = Math.round((headY - meteor.dy * step * PITCH) / PITCH) * PITCH;
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, CELL, CELL);
    }
  }
  ctx.globalAlpha = 1;
}

/* --------------------------------------------------------------------------
 * Light
 *
 * One thing a backdrop like this can do that reads as weather instead of as a
 * tick: a wide, soft band of brightness crossing the nebula, the way moonlight
 * crosses cloud. It is a single additive gradient per frame, and it never
 * touches the grid, so it cannot tear anything.
 * ----------------------------------------------------------------------- */

const GALAXY_SWEEP = { period: 34_000, width: 0.34, peak: 0.07 } as const;

/** A soft diagonal band of extra light, drifting across the pane. */
export function paintGalaxySweep(
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  height: number,
) {
  const cycle = (((time % GALAXY_SWEEP.period) + GALAXY_SWEEP.period) % GALAXY_SWEEP.period) / GALAXY_SWEEP.period;
  const band = GALAXY_SWEEP.width;
  // Runs from fully off one edge to fully off the other, so it never pops.
  const at = -band + cycle * (1 + band * 2);
  const gradient = ctx.createLinearGradient(0, 0, width, height * 0.45);
  gradient.addColorStop(Math.max(0, at - band), "rgba(186, 196, 255, 0)");
  gradient.addColorStop(Math.max(0, Math.min(1, at)), `rgba(198, 208, 255, ${GALAXY_SWEEP.peak})`);
  gradient.addColorStop(Math.min(1, at + band), "rgba(186, 196, 255, 0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
}


/* --------------------------------------------------------------------------
 * Ink
 * ----------------------------------------------------------------------- */

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
    color: color ? saturate(texel, ink.sat) : null,
  };
}
