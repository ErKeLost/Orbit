import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ChevronRight, Folder, ImagePlus, Loader, RefreshCw } from "../../shared/ui/icons";
import { FileTypeIcon } from "../files/ui/FileTypeIcon";
import {
  DIR_ENTRY_LIMIT,
  directorySummary,
  entrySizeLabel,
  formatEntryDate,
  groupDirectory,
  isImageEntry,
  pathCrumbs,
  type DirectoryGroups,
} from "../../lib/directory";
import { listDir, type DirEntry } from "../../lib/git";
import { onFilesInvalidated } from "../files/model/fileWatch";
import "../../styles/directory-view.css";

/**
 * A folder, as a folder.
 *
 * This is presentational on purpose: it takes a listing and renders it, so the
 * container (`DirectoryView`) owns the I/O and this owns the pixels. Nothing
 * here knows how the entries were fetched, which is what lets the same markup
 * be rendered against fixtures.
 *
 * Thumbnails are `<img>` pointing at Tauri's asset protocol, not a canvas:
 * the WebView streams the file off disk, decodes it off the main thread and
 * lets the compositor hold it, so `loading="lazy"` is all a 900-photo folder
 * needs. The phone is the exception — the file is not on that machine and the
 * asset protocol has no meaning there, so it gets icons and keeps its bytes
 * (`lib/media-preview.ts`).
 */
export function DirectoryListing({
  path,
  cwd,
  entries,
  remote,
  isPending,
  isError,
  isFetching,
  error,
  truncated,
  resolveSrc,
  onOpen,
  onRefresh,
}: {
  path: string;
  cwd: string;
  entries: DirEntry[];
  remote: boolean;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error?: unknown;
  /** The backend stopped at its entry cap; say so instead of lying by omission. */
  truncated: boolean;
  /**
   * How a path becomes a URL. Defaults to Tauri's asset protocol; it is a prop
   * so this component stays a function of its inputs, with no environment baked
   * into it — the same reason nothing here fetches.
   */
  resolveSrc?: (path: string) => string;
  onOpen: (path: string, isDir: boolean) => void;
  onRefresh: () => void;
}) {
  const toSrc = resolveSrc ?? convertFileSrc;
  const groups = groupDirectory(entries);
  const crumbs = pathCrumbs(path, cwd);
  const isEmpty = !groups.folders.length && !groups.images.length && !groups.files.length;

  return (
    <div className="dir-view">
      <header className="dir-head">
        <nav className="dir-crumbs" aria-label="路径">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="dir-crumb">
              {index > 0 ? <ChevronRight aria-hidden className="dir-crumb-sep" strokeWidth={2} /> : null}
              <button
                type="button"
                className="dir-crumb-button"
                aria-current={index === crumbs.length - 1 ? "page" : undefined}
                onClick={() => onOpen(crumb.path, true)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <p className="dir-summary">
          {isPending ? "读取中…" : directorySummary(groups)}
          {truncated ? " · 已达上限，仅显示前 5000 项" : ""}
        </p>
        <button type="button" className="dir-refresh" title="重新读取" aria-label="重新读取" onClick={onRefresh}>
          <RefreshCw className={isFetching ? "animate-spin" : undefined} strokeWidth={1.75} />
        </button>
      </header>

      <div className="dir-body">
        {isPending ? (
          <div className="dir-center"><Loader className="size-4 animate-spin" /></div>
        ) : isError ? (
          <div className="dir-center dir-notice">
            <Folder className="size-8" strokeWidth={1.5} />
            <p>{String(error instanceof Error ? error.message : error)}</p>
            <p className="dir-notice-path">{path}</p>
          </div>
        ) : isEmpty ? (
          <div className="dir-center dir-notice">
            <Folder className="size-8" strokeWidth={1.5} />
            <p>这个文件夹是空的</p>
          </div>
        ) : (
          <>
            {groups.folders.length > 0 ? (
              <section className="dir-section">
                <h3 className="dir-section-head">文件夹<span>{groups.folders.length}</span></h3>
                <div className="dir-folder-grid">
                  {groups.folders.map((entry) => (
                    <button key={entry.path} type="button" className="dir-folder" onClick={() => onOpen(entry.path, true)}>
                      <FileTypeIcon name={entry.name} isDir />
                      <span className="dir-folder-name">{entry.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {groups.images.length > 0 ? (
              <section className="dir-section">
                <h3 className="dir-section-head">图片<span>{groups.images.length}</span></h3>
                <div className="dir-image-grid">
                  {groups.images.map((entry) => (
                    <button key={entry.path} type="button" className="dir-tile" onClick={() => onOpen(entry.path, false)} title={entry.name}>
                      <span className={`dir-tile-frame${remote ? " dir-tile-remote" : ""}`}>
                        {remote ? <ImagePlus strokeWidth={1.5} /> : <img src={toSrc(entry.path)} alt={entry.name} loading="lazy" decoding="async" draggable={false} />}
                      </span>
                      <span className="dir-tile-name">{entry.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {groups.files.length > 0 ? (
              <section className="dir-section">
                <h3 className="dir-section-head">文件<span>{groups.files.length}</span></h3>
                <ul className="dir-file-list">
                  {groups.files.map((entry) => (
                    <li key={entry.path}>
                      <button type="button" className="dir-file" onClick={() => onOpen(entry.path, false)}>
                        <FileTypeIcon name={entry.name} isDir={false} />
                        <span className="dir-file-name">{entry.name}</span>
                        <span className="dir-file-size">{entrySizeLabel(entry)}</span>
                        <span className="dir-file-date">{formatEntryDate(entry.mtimeMs)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Exported for the grouping test and for callers that want the buckets only. */
export type { DirectoryGroups };
export { isImageEntry };
/**
 * A folder tab: the listing, and nothing else.
 *
 * The I/O lives here so `DirectoryListing` can stay a function of its props.
 * `list_dir` is the same command the tree calls, so a folder opened from a
 * breadcrumb, a chat link or the tree all land on one cached answer.
 */
export function DirectoryView({
  path,
  cwd,
  remote,
  onOpen,
}: {
  path: string;
  cwd: string;
  remote: boolean;
  onOpen: (path: string, isDir: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const listing = useQuery({
    queryKey: ["dir", path],
    queryFn: () => listDir(path),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  // A save or a git operation announces itself on this bus; a folder on screen
  // should follow a write the same way an open file does.
  useEffect(
    () => onFilesInvalidated(() => void queryClient.invalidateQueries({ queryKey: ["dir", path] })),
    [path, queryClient],
  );
  const entries = listing.data ?? [];
  return (
    <DirectoryListing
      path={path}
      cwd={cwd}
      entries={entries}
      remote={remote}
      isPending={listing.isPending}
      isError={listing.isError}
      isFetching={listing.isFetching}
      error={listing.error}
      truncated={entries.length >= DIR_ENTRY_LIMIT}
      onOpen={onOpen}
      onRefresh={() => void listing.refetch()}
    />
  );
}
