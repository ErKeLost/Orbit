import { useSyncExternalStore } from "react";
import * as Glyphs from "../shared/ui/icons";
import type { IconComponent } from "../shared/ui/icons";
import { Icon as Iconify, addCollection, getIcon } from "@iconify/react";
import { FileTypeIcon } from "../features/shell/FileTypeIcon";

/** `ChevronDown` → `chevron-down`: an icon's name *is* its export, so the name a
 * call site asks for and the glyph it gets cannot drift apart. Adding a glyph
 * in `shared/ui/icons.tsx` is all it takes to make its name resolvable here. */
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter, offset) => `${offset ? "-" : ""}${letter.toLowerCase()}`);

/** Built once from the module's own exports — there is no second list to edit. */
const GLYPHS: Map<string, IconComponent> = new Map(
  Object.entries(Glyphs).map(([name, glyph]) => [kebab(name), glyph as IconComponent]),
);

/** Fluent Color is ~1.7 MB of JSON. Keep it out of the app chunk and load it
 * only when an agent avatar (or another coloured icon) is actually rendered. */
let fluentColorReady = false;
let fluentColorLoading: Promise<void> | null = null;
const fluentColorListeners = new Set<() => void>();

function loadFluentColor() {
  if (fluentColorReady || fluentColorLoading) return;
  fluentColorLoading = import("@iconify-json/fluent-color/icons.json").then(
    (module) => {
      addCollection((module.default ?? module) as never);
      fluentColorReady = true;
      for (const listener of fluentColorListeners) listener();
    },
    (error) => {
      // A later mount may retry. Until then the neutral glyph remains visible.
      fluentColorLoading = null;
      console.warn("[icons] Fluent Color 加载失败", error);
    },
  );
}

function subscribeFluentColor(onChange: () => void) {
  fluentColorListeners.add(onChange);
  loadFluentColor();
  return () => {
    fluentColorListeners.delete(onChange);
  };
}

const fluentColorSnapshot = () => fluentColorReady;

function ColoredIcon({ name, className }: { name: string; className: string }) {
  const ready = useSyncExternalStore(subscribeFluentColor, fluentColorSnapshot, fluentColorSnapshot);
  // Model-authored names are guesses: a missing collection entry must not leave
  // a hole in the row. The same neutral glyph also holds the slot while loading.
  if (!ready || !getIcon(name)) return <Glyphs.Sparkles className={className} strokeWidth={1.75} aria-hidden />;
  return <Iconify icon={name} className={className} aria-hidden />;
}

export function Icon({ name, className = "size-4" }: { name: string; className?: string }) {
  const key = name.replace(/^ph:/, "");
  // Legacy coloured file-type names map to the file-icon pipeline. Check these
  // before the generic prefixed-icon branch, otherwise they can never reach it.
  const fileType = /^(?:vscode-icons:file-type-|catppuccin:)(.+)$/.exec(key)?.[1];
  if (fileType) return <FileTypeIcon name={`file.${fileType.replace(/2$/, "")}`} isDir={false} size={16} />;
  if (key.includes(":")) return <ColoredIcon name={key} className={className} />;
  const Glyph = GLYPHS.get(key);
  if (Glyph) return <Glyph className={className} strokeWidth={1.75} aria-hidden />;
  return <Glyphs.Sparkles className={className} strokeWidth={1.75} aria-hidden />;
}
