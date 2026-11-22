import { useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppearance } from "../../lib/appearance";

/** The configured picture, once, behind the whole window — rail, title, home and chat. */
export function WindowWallpaper() {
  const path = useAppearance((state) => state.chatBackground);
  const opacity = useAppearance((state) => state.chatBackgroundOpacity);
  useEffect(() => {
    document.documentElement.classList.toggle("has-window-wallpaper", Boolean(path));
    return () => document.documentElement.classList.remove("has-window-wallpaper");
  }, [path]);
  if (!path) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      <img src={convertFileSrc(path)} alt="" className="h-full w-full object-cover" style={{ opacity }} />
    </div>
  );
}
