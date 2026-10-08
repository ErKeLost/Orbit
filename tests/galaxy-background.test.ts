import { describe, expect, test } from "bun:test";
import {
  CELL,
  PAD,
  PITCH,
  galaxyBreath,
  galaxyDrift,
  galaxyPlateSize,
  spawnMeteor,
} from "../src/features/background/galaxyDots";

/**
 * The backdrop stamps the nebula into a canvas that is `PAD` cells wider than
 * the pane on every side, then blits it at whole-pixel offsets. If the plate
 * ever floated further than the pad, the blit would expose the pane's own edge
 * and the galaxy would end on a straight line. These tests hold that invariant,
 * because it is invisible until it breaks.
 */
const SAMPLES = Array.from({ length: 512 }, (_, i) => (i / 512) * 260_000);

describe("galaxy background geometry", () => {
  test("pads the plate past the pane on every side", () => {
    for (const width of [320, 768, 1440, 2050, 3840]) {
      for (const height of [240, 700, 1300, 2160]) {
        const size = galaxyPlateSize(width, height);
        expect(size.width).toBeGreaterThanOrEqual(width + PAD * PITCH * 2);
        expect(size.height).toBeGreaterThanOrEqual(height + PAD * PITCH * 2);
      }
    }
  });

  test("never floats further than the pad can cover", () => {
    for (const time of SAMPLES) {
      const drift = galaxyDrift(time);
      // Whole-pixel blits, so the pad has to cover the rounded offset.
      expect(Math.abs(Math.round(drift.x))).toBeLessThan(PAD * PITCH);
      expect(Math.abs(Math.round(drift.y))).toBeLessThan(PAD * PITCH);
    }
  });

  test("always blits the plate across the whole pane", () => {
    for (const width of [600, 1440, 2050, 3200]) {
      for (const height of [400, 900, 1300]) {
        const size = galaxyPlateSize(width, height);
        for (const time of SAMPLES) {
          const drift = galaxyDrift(time);
          const x = Math.round(drift.x) - PAD * PITCH;
          const y = Math.round(drift.y) - PAD * PITCH;
          expect(x).toBeLessThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(0);
          expect(x + size.width).toBeGreaterThanOrEqual(width);
          expect(y + size.height).toBeGreaterThanOrEqual(height);
        }
      }
    }
  });

  test("holds the plate at home when motion is off", () => {
    for (const time of SAMPLES) {
      expect(galaxyDrift(time, false)).toEqual({ x: 0, y: 0 });
    }
  });

  test("keeps the breathing multiplier inside the ink's own range", () => {
    for (const time of SAMPLES) {
      const breath = galaxyBreath(time);
      expect(breath).toBeGreaterThan(0.7);
      expect(breath).toBeLessThanOrEqual(1);
    }
  });

  test("sends a meteor across the pane and lets it die", () => {
    for (let i = 0; i < 200; i++) {
      const meteor = spawnMeteor(1440, 900, 1000);
      expect(Math.hypot(meteor.dx, meteor.dy)).toBeCloseTo(1, 6);
      expect(meteor.speed).toBeGreaterThan(0);
      expect(meteor.length).toBeGreaterThan(PITCH);
      expect(meteor.speed * meteor.life).toBeGreaterThan(Math.hypot(1440, 900));
      expect(meteor.born).toBe(1000);
    }
  });

  test("keeps the squares on the terminal grid", () => {
    expect(CELL).toBe(6);
    expect(PITCH).toBe(CELL + 1);
  });
});
