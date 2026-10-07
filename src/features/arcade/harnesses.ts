/**
 * The arcade background borrows MonoCode's sprite set. Orbit only drives Pi,
 * so every pickup is the Pi mark (drawn white and tinted to the theme).
 */
const pi = "/pi.svg";

export const HARNESSES = ["pi"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const HARNESS_ICONS: Record<HarnessId, string> = { pi };
export const MONOCHROME_HARNESSES = new Set<HarnessId>(["pi"]);
