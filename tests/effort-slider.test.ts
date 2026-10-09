import { describe, expect, test } from "bun:test";
import {
  effortColorsForLevels,
  effortFieldMode,
  effortIsGalaxy,
  effortIsRecommended,
  effortVisualPosition,
  effortVisualSlot,
} from "../src/components/chat/effort-slider-model";

describe("effort slider visual semantics", () => {
  test("does not treat the final available level as Max", () => {
    expect(effortVisualSlot("low")).toBe(1);
    expect(effortFieldMode("low")).toBe("low");
  });

  test("maps Pi thinking levels onto the original six visual stages", () => {
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => effortVisualSlot(level))).toEqual([0, 1, 1, 2, 3, 4, 5]);
    expect(effortFieldMode("high")).toBe("high");
    expect(effortFieldMode("xhigh")).toBe("extra");
    expect(effortFieldMode("max")).toBe("max");
  });

  test("keeps the original semantic positions while rendering every Pi stage", () => {
    expect(effortVisualPosition("off")).toBe(0);
    expect(effortVisualPosition("minimal")).toBe(1);
    expect(effortVisualPosition("low")).toBe(1);
    expect(effortFieldMode("minimal")).toBe("minimal");
    expect(effortFieldMode("medium")).toBe("medium");
  });

  test("keeps a distinct colour for every stage", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const colors = levels.map((level) => effortColorsForLevels(levels, levels.indexOf(level)).base);
    expect(new Set(colors).size).toBe(levels.length);
  });

  test("treats the top available level as Galaxy", () => {
    const five = ["off", "minimal", "low", "medium", "high"];
    expect(effortIsGalaxy("high", five)).toBe(true);
    expect(effortIsGalaxy("medium", five)).toBe(false);
    const seven = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(effortIsGalaxy("high", seven)).toBe(false);
    expect(effortIsGalaxy("max", seven)).toBe(true);
  });

  test("marks medium as the recommended stage", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(levels.filter(effortIsRecommended)).toEqual(["medium"]);
    expect(effortIsRecommended("max")).toBe(false);
  });
});
