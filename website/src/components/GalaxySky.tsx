import { useEffect, useRef } from 'react'

import galaxyUrl from '../assets/orbit-galaxy.png'
import {
  createMotes,
  drawGalaxyPlate,
  galaxyBreath,
  galaxyDrift,
  galaxyGridPattern,
  galaxyPlateSize,
  GALAXY_INK,
  paintGalaxy,
  paintGalaxyMotes,
  paintGalaxyStars,
  paintGalaxySweep,
  type GalaxyDrift,
  type GalaxyMote,
  type GalaxyStar,
} from '../lib/galaxy-dots'

/**
 * The app's new-session backdrop, pixel for pixel.
 *
 * `lib/galaxy-dots.ts` is the app's own module (copied, not reimplemented): the
 * artwork sampled onto the 6px terminal grid, the plate drifting and breathing as
 * one piece, the paper's graph grid underneath, the sweep, the twinkling stars,
 * the motes, and a meteor burst every few seconds. What you see in Orbit's empty
 * session is what this draws — same pitch, same timings, same ink budget.
 *
 * The app's version reacts to the theme; the site is dark only, so the ink is read
 * once from the page's own `--ink` and the plate is stamped at that colour.
 */

const SOURCE = galaxyUrl
/** The app's own cadence: one blink every 40ms is not 60fps. */
const FRAME_MS = 40
/**
 * The landing page runs a faster sky than the app's empty session: five streaks
 * per burst instead of three, every few seconds instead of every ten to sixteen.
 * A backdrop someone looks at for a minute should feel alive; a backdrop someone
 * works in front of all day should not.
 */
/**
 * How many streaks are in the sky at once, and how the trail is drawn.
 *
 * The app's empty session fires three and then waits; a landing page is looked at
 * for a minute, so this keeps a handful alive all the time — a sky that is
 * obviously moving, without turning into a screensaver.
 */
const STREAKS = 5
/** Speed range, px per millisecond. */
const SPEED = { min: 0.16, max: 0.34 }
/** Trail length, px. */
const TRAIL = { min: 120, max: 260 }
const PITCH = 7
const CELL = 6

type Streak = {
  x: number
  y: number
  dx: number
  dy: number
  speed: number
  born: number
  life: number
  length: number
}

/** A fresh streak entering from one edge, crossing most of the viewport. */
function spawnStreak(width: number, height: number, now: number, age = 0): Streak {
  const fromLeft = Math.random() < 0.5
  const slope = 0.22 + Math.random() * 0.5
  const run = Math.hypot(1, slope)
  const speed = SPEED.min + Math.random() * (SPEED.max - SPEED.min)
  const length = TRAIL.min + Math.random() * (TRAIL.max - TRAIL.min)
  const distance = Math.hypot(width, height) * 1.15
  const dx = (fromLeft ? 1 : -1) / run
  return {
    x: fromLeft ? -30 : width + 30,
    y: -30 + Math.random() * height * 0.85,
    dx,
    dy: (fromLeft ? slope : slope) / run,
    speed,
    born: now - age,
    life: distance / speed,
    length,
  }
}

/**
 * One streak: a staircase of the same 6px squares as the grid, a bright head, and
 * a soft bloom behind it. Drawn with `lighter` so it adds light to the nebula
 * instead of covering it.
 */
function paintStreaks(ctx: CanvasRenderingContext2D, streaks: Streak[], now: number, width: number, height: number) {
  ctx.globalCompositeOperation = 'lighter'
  for (let index = 0; index < streaks.length; index += 1) {
    const streak = streaks[index]!
    const age = now - streak.born
    if (age < 0) continue
    if (age > streak.life) {
      // Recycle in place: a sky with a constant streak count never feels empty.
      streaks[index] = spawnStreak(width, height, now, Math.random() * 400)
      continue
    }
    const progress = age / streak.life
    const envelope = Math.min(1, progress / 0.08) * Math.min(1, (1 - progress) / 0.22)
    if (envelope <= 0.02) continue

    const headX = streak.x + streak.dx * streak.speed * age
    const headY = streak.y + streak.dy * streak.speed * age

    // Trail: squares on the grid pitch, fading with the square of the distance.
    const steps = Math.max(1, Math.floor(streak.length / PITCH))
    for (let step = 0; step <= steps; step += 1) {
      // Cubic falloff: the head is a bead of light, the far end is a suggestion.
      const tail = 1 - step / (steps + 1)
      const alpha = envelope * tail ** 3 * 1.05
      if (alpha <= 0.02) continue
      const x = Math.round((headX - streak.dx * step * PITCH) / PITCH) * PITCH
      const y = Math.round((headY - streak.dy * step * PITCH) / PITCH) * PITCH
      if (x < -PITCH || x > width + PITCH || y < -PITCH || y > height + PITCH) continue
      ctx.fillStyle = `rgba(238, 232, 255, ${alpha.toFixed(3)})`
      ctx.fillRect(x, y, CELL, CELL)
    }

    // Bloom: one tight core at the head, one weaker halo a third of the way back.
    const core = ctx.createRadialGradient(headX, headY, 0, headX, headY, 42)
    core.addColorStop(0, `rgba(244, 238, 255, ${(0.62 * envelope).toFixed(3)})`)
    core.addColorStop(0.3, `rgba(198, 178, 255, ${(0.26 * envelope).toFixed(3)})`)
    core.addColorStop(1, 'rgba(143, 128, 255, 0)')
    ctx.fillStyle = core
    ctx.fillRect(headX - 42, headY - 42, 84, 84)

    const tailX = headX - streak.dx * streak.length * 0.4
    const tailY = headY - streak.dy * streak.length * 0.4
    const halo = ctx.createRadialGradient(tailX, tailY, 0, tailX, tailY, 30)
    halo.addColorStop(0, `rgba(198, 182, 255, ${(0.16 * envelope).toFixed(3)})`)
    halo.addColorStop(1, 'rgba(143, 128, 255, 0)')
    ctx.fillStyle = halo
    ctx.fillRect(tailX - 30, tailY - 30, 60, 60)
  }
  ctx.globalCompositeOperation = 'source-over'
}

function inkRgb(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
  const match = value.match(/\d+/g)
  if (!match || match.length < 3) return '245, 242, 255'
  return `${match[0]}, ${match[1]}, ${match[2]}`
}

export function GalaxySky() {
  const root = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = root.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!host || !canvas || !ctx) return

    let raf = 0
    let lastFrame = 0
    let rgb = inkRgb()
    let pattern: CanvasPattern | null = null
    let stars: GalaxyStar[] = []
    let drift: GalaxyDrift = { x: 0, y: 0 }
    let float = { x: true, y: true }
    let pointer: { x: number; y: number } | null = null
    let motes: GalaxyMote[] = []
    let width = 0
    let height = 0
    let ready = false

    const plate = document.createElement('canvas')
    const plateCtx = plate.getContext('2d')
    let streaks: Streak[] = []
    const image = new Image()
    const still = window.matchMedia('(prefers-reduced-motion: reduce)')

    const layout = () => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      width = rect.width
      height = rect.height
      // One CSS pixel per pixel, like the app: the plate only lands on whole
      // pixels, and nearest-neighbour keeps every square square.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = false

      motes = createMotes(width, height)
      streaks = Array.from({ length: STREAKS }, () => spawnStreak(width, height, performance.now(), Math.random() * 5_000))
      if (!ready) return

      const size = galaxyPlateSize(width, height)
      plate.width = size.width
      plate.height = size.height
      plateCtx?.setTransform(1, 0, 0, 1, 0, 0)

      if (plateCtx) {
        const stamp = paintGalaxy(plateCtx, {
          image,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          width,
          height,
          rgb,
          ink: GALAXY_INK,
        })
        stars = stamp.stars
        float = stamp.float
      }
      pattern = galaxyGridPattern(ctx, rgb, GALAXY_INK)
    }

    const draw = (time: number) => {
      if (document.hidden) {
        raf = 0
        return
      }
      raf = requestAnimationFrame(draw)
      if (time - lastFrame < FRAME_MS) return
      lastFrame = time

      const motion = !still.matches
      const clock = motion ? time : 0

      drift = galaxyDrift(clock, motion, float, pointer)
      ctx.clearRect(0, 0, width, height)
      ctx.imageSmoothingEnabled = false
      if (pattern) {
        ctx.globalAlpha = 1
        ctx.fillStyle = pattern
        ctx.fillRect(0, 0, width, height)
      }
      drawGalaxyPlate(ctx, plate, drift, galaxyBreath(clock, motion))
      paintGalaxySweep(ctx, clock, width, height)
      paintGalaxyStars(ctx, stars, motion ? time : 180, rgb, GALAXY_INK, drift)
      if (!motion) return

      paintStreaks(ctx, streaks, time, width, height)
      paintGalaxyMotes(ctx, motes, time, width, height, rgb, GALAXY_INK)
    }

    const start = () => {
      if (raf) return
      lastFrame = 0
      raf = requestAnimationFrame(draw)
    }

    image.onload = () => {
      ready = true
      layout()
      start()
    }
    image.src = SOURCE
    layout()

    const onVisible = () => {
      if (!document.hidden) start()
    }
    document.addEventListener('visibilitychange', onVisible)
    still.addEventListener('change', onVisible)

    // A few pixels of give under the cursor, exactly as in the app.
    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      pointer = {
        x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
        y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)),
      }
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    const resize = new ResizeObserver(() => {
      layout()
      onVisible()
    })
    resize.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      image.onload = null
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisible)
      still.removeEventListener('change', onVisible)
      resize.disconnect()
    }
  }, [])

  return (
    <div ref={root} aria-hidden className="galaxy-sky">
      <canvas ref={canvasRef} />
    </div>
  )
}
