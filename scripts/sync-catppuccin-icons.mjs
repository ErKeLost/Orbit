import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Regenerate the Catppuccin filename→icon table from the icon theme's own
 * associations. The glyphs come from `@iconify-json/catppuccin`; this only
 * vendors the mapping (extension / file name / folder name → icon name) so the
 * renderer does not have to guess or ship the whole theme.
 *
 * Pinned to a tag: the upstream `main` branch renames icons between releases.
 */
const TAG = "v1.26.0";
const RAW = `https://raw.githubusercontent.com/catppuccin/vscode-icons/${TAG}/src/defaults`;

/** Strip the top-level `type X = ...` block and the `: X` annotation, then import. */
async function loadModule(url, typeName, constName) {
  const source = await (await fetch(url)).text();
  const js = source
    .replace(new RegExp(`^type ${typeName}[\\s\\S]*?^\\}>`, "m"), "")
    .replace(`const ${constName}: ${typeName} =`, `const ${constName} =`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const files = await loadModule(`${RAW}/fileIcons.ts`, "FileIcons", "fileIcons");
const folders = await loadModule(`${RAW}/folderIcons.ts`, "FolderIcons", "folderIcons");

// The theme names folders `folder_src`; the icon set publishes `folder-src`, and
// every closed folder has a matching `-open` glyph.
const folderNames = Object.fromEntries(
  Object.entries(folders.folderNames).map(([name, icon]) => [name, icon.replace(/^folder_/, "folder-")]),
);
// One icon name in the table uses an underscore (`deno_lock` → `deno-lock`).
const normalize = (map) => Object.fromEntries(
  Object.entries(map).map(([key, icon]) => [key, icon.replace(/_/g, "-")]),
);

const data = {
  source: `catppuccin/vscode-icons ${TAG}`,
  fileNames: normalize(files.fileNames),
  fileExtensions: normalize(files.fileExtensions),
  languageIds: normalize(files.languageIds),
  folderNames,
};

const target = resolve(import.meta.dirname, "../src/features/files/model/catppuccinIconAssociations.json");
await writeFile(target, `${JSON.stringify(data)}\n`);
console.log(`wrote ${target} (${Object.keys(data.fileNames).length} names, ${Object.keys(data.fileExtensions).length} extensions, ${Object.keys(data.folderNames).length} folders)`);
