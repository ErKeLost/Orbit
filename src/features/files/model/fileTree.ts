/** Directory-change notifications for the file-status cache (Orbit: quiet). */
export function subscribeDirsChanged(_listener: () => void): () => void {
  return () => undefined;
}
