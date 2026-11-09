// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PerfHud } from "./PerfHud";
import { togglePerfHud } from "../lib/perf-monitor";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  try {
    localStorage.removeItem("orbit.perfHud");
  } catch {
    // storage unavailable
  }
});

describe("PerfHud", () => {
  it("stays out of the way while disabled", async () => {
    await act(async () => root.render(createElement(PerfHud)));
    expect(document.querySelector("[data-perf-hud]")).toBeNull();
  });

  it("shows the frame rate, stalls and heap once enabled", async () => {
    try {
      localStorage.setItem("orbit.perfHud", "1");
    } catch {
      return;
    }
    await act(async () => root.render(createElement(PerfHud)));
    const hud = document.querySelector("[data-perf-hud]");
    expect(hud).not.toBeNull();
    const text = hud?.textContent ?? "";
    expect(text).toContain("fps");
    expect(text).toContain("jank");
    expect(text).toContain("堆");
  });

  it("toggles through the shared event so the shortcut and HUD agree", async () => {
    await act(async () => root.render(createElement(PerfHud)));
    expect(document.querySelector("[data-perf-hud]")).toBeNull();
    await act(async () => {
      togglePerfHud(true);
    });
    expect(document.querySelector("[data-perf-hud]")).not.toBeNull();
    await act(async () => {
      togglePerfHud(false);
    });
    expect(document.querySelector("[data-perf-hud]")).toBeNull();
  });
});
