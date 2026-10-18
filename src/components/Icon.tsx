import * as Glyphs from "../shared/ui/icons";
import type { IconComponent } from "../shared/ui/icons";
import { Icon as Iconify, addCollection, getIcon } from "@iconify/react";
import fluentColor from "@iconify-json/fluent-color/icons.json";
import { FileTypeIcon } from "../features/shell/FileTypeIcon";

// Bundled locally so rendering never hits the network.
addCollection(fluentColor as never);

/** `ChevronDown` → `chevron-down`: an icon's name *is* its export, so the name a
 *  call site asks for and the glyph it gets cannot drift apart. Adding a glyph
 *  in `shared/ui/icons.tsx` is all it takes to make its name resolvable here. */
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter, offset) => `${offset ? "-" : ""}${letter.toLowerCase()}`);

/** Built once from the module's own exports — there is no second list to edit. */
const GLYPHS: Map<string, IconComponent> = new Map(
  Object.entries(Glyphs).map(([name, glyph]) => [kebab(name), glyph as IconComponent]),
);

export function Icon({ name, className = "size-4" }: { name: string; className?: string }) {
  const key = name.replace(/^ph:/, "");
  // Prefixed names are coloured collections (fluent-color for agent avatars,
  // devicon for links); the monochrome chrome set below is Hugeicons.
  //
  // An unknown name renders *nothing* in Iconify, which in a row of workers is
  // a hole. Icon names written by a model are guesses, so an unknown one has to
  // land on the neutral glyph like any other miss.
  if (key.includes(":")) {
    return getIcon(key) ? <Iconify icon={key} className={className} aria-hidden /> : <Glyphs.Sparkles className={className} strokeWidth={1.75} aria-hidden />;
  }
  const Glyph = GLYPHS.get(key);
  if (Glyph) return <Glyph className={className} strokeWidth={1.75} aria-hidden />;
  // Old colored file-type names (vscode-icons:/catppuccin:) map to Material icons.
  const fileType = /^(?:vscode-icons:file-type-|catppuccin:)(.+)$/.exec(key)?.[1];
  if (fileType) return <FileTypeIcon name={`file.${fileType.replace(/2$/, "")}`} isDir={false} size={16} />;
  return <Glyphs.Sparkles className={className} strokeWidth={1.75} aria-hidden />;
}

export function FileIcon({ path, className: _className }: { path: string; className?: string }) {
  const name = path.trim().split(/[\\/]/).at(-1) ?? path;
  return <FileTypeIcon name={name} isDir={false} size={14} />;
}
