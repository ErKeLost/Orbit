import { useAppearance } from "../../../lib/appearance";

// Keep the voice identity consistent across accent colors; deepen it on light surfaces.
const ORB_COLORS: Record<"dark" | "light", [string, string]> = {
  dark: ["#A78BFA", "#67E8F9"],
  light: ["#8B5CF6", "#06B6D4"],
};

export function useOrbColors(): [string, string] {
  const scheme = useAppearance((state) => state.scheme);
  return ORB_COLORS[scheme];
}
