/**
 * Drag a real file out of the webview into Finder.
 *
 * Chromium (the desktop shell is CEF) turns a `DownloadURL` payload into a
 * file promise the Finder accepts. A path chip that only sets `text/plain`
 * drops as text, which is why the pill has to name the file URL itself.
 */

export function fileUrl(path: string): string {
  const encoded = path
    .split(/[\\/]/)
    .map((part) => encodeURIComponent(part))
    .join("/");
  if (/^[A-Za-z]:/.test(path)) return `file:///${encoded}`;
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

export function downloadUrl(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) || "file";
  return `application/octet-stream:${encodeURIComponent(name)}:${fileUrl(path)}`;
}

/** Set the payloads a Finder drop reads. No-op when the event has no transfer. */
export function applyFileDrag(transfer: DataTransfer | null, path: string): void {
  if (!transfer || !path) return;
  const url = fileUrl(path);
  transfer.effectAllowed = "copy";
  transfer.setData("DownloadURL", downloadUrl(path));
  transfer.setData("text/uri-list", url);
  transfer.setData("text/plain", path);
}
