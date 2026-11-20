import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ setTheme: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

localStorage.removeItem("orbit.bodyGlass");

const { BODY_GLASS_DEFAULT, bodyGlassFromStorage, useAppearance, windowGlassOn } = await import("./appearance");

describe("window glass default", () => {
  test("unset means off, and only an explicit true turns it on", () => {
    expect(BODY_GLASS_DEFAULT).toBe(false);
    expect(bodyGlassFromStorage(null)).toBe(false);
    expect(bodyGlassFromStorage("false")).toBe(false);
    expect(bodyGlassFromStorage("true")).toBe(true);
  });

  test("a fresh store and restore-defaults both stay opaque", () => {
    expect(useAppearance.getState().bodyGlass).toBe(false);
    useAppearance.getState().setBodyGlass(true);
    expect(localStorage.getItem("orbit.bodyGlass")).toBe("true");
    useAppearance.getState().restoreDefaults();
    expect(useAppearance.getState().bodyGlass).toBe(false);
    expect(localStorage.getItem("orbit.bodyGlass")).toBeNull();
  });

  test("the home page only drops its plate while glass can actually show the desktop", () => {
    expect(windowGlassOn({ scheme: "light", bodyGlass: true })).toBe(false);
    expect(windowGlassOn({ scheme: "dark", bodyGlass: false })).toBe(false);
    const can = /Mac|iPhone|iPad|Win/i.test(navigator.platform);
    expect(windowGlassOn({ scheme: "dark", bodyGlass: true })).toBe(can);
  });
});
