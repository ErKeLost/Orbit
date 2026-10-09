import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/Dialog"
import { Button, Input } from "../../components/UI"
import { Icon } from "../../components/Icon"
import { listDir, type DirEntry } from "../../lib/git"
import { useProjects } from "../../lib/projects"
import { runRemoteHostOperation } from "../../lib/remote-runtime"
import { report } from "../../lib/rpc"
import { Folder, Loader } from "../../shared/ui/icons"

/**
 * Add a project to the desktop from the phone.
 *
 * The desktop's own flow opens a native folder panel, which a phone cannot see
 * or click; this is the same question asked in the app — a listing of the Mac's
 * directories, one level at a time, answered by `list_dir` on the desktop over
 * `host.invoke`. `~` is expanded on the desktop, so a path typed here means the
 * Mac's home directory and not the phone's.
 *
 * Selecting a folder that is already a project offers to forget it instead: the
 * picker is also the only place a phone can manage the list it renders.
 */
export function ProjectDirectoryPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = useProjects((state) => state.projects)
  const [path, setPath] = useState("~")
  // The listing carries the folder it belongs to, so a slow answer for a folder
  // the user already left cannot replace the one on screen, and "still loading"
  // is a comparison rather than a second piece of state.
  const [listing, setListing] = useState<{ path: string; entries: DirEntry[] } | null>(null)
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null)
  const [busy, setBusy] = useState<"add" | "forget" | null>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    void listDir(path)
      .then((found) => {
        if (current) setListing({ path, entries: found.filter((entry) => entry.isDir) })
      })
      .catch((error) => {
        if (current) setFailure({ path, message: String(error instanceof Error ? error.message : error) })
      })
    return () => { current = false }
  }, [open, path])

  const entries = listing?.path === path ? listing.entries : null
  const error = failure?.path === path ? failure.message : ""

  const parent = path === "~" || path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/"
  const registered = projects.find((project) => project.path === path)

  async function add() {
    setBusy("add")
    try {
      await runRemoteHostOperation({ name: "project.add", path })
      onClose()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  async function forget() {
    setBusy("forget")
    try {
      await runRemoteHostOperation({ name: "project.forget", path })
      onClose()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>在电脑上添加项目</DialogTitle>
          <DialogDescription>浏览这台电脑的文件夹；添加后 Pi 会在电脑上打开它。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" disabled={!parent} onClick={() => parent && setPath(parent)}>上一级</Button>
          <Input
            aria-label="当前文件夹"
            value={path}
            onChange={(event) => setPath(event.target.value.trim() || "~")}
            className="min-w-0 flex-1 font-mono text-[12px]"
          />
          <Button variant="ghost" onClick={() => setPath("~")}>主目录</Button>
        </div>
        <div className="max-h-[46vh] min-h-[180px] overflow-y-auto rounded-lg border border-content/10">
          {error ? <p className="p-3 text-[12px] text-content/60">{error}</p> : null}
          {!error && entries === null ? (
            <p className="flex items-center gap-2 p-3 text-[12px] text-content/50"><Loader className="size-3.5 animate-spin" />读取中…</p>
          ) : null}
          {!error && entries?.length === 0 ? <p className="p-3 text-[12px] text-content/50">没有子文件夹</p> : null}
          {entries?.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => setPath(entry.path)}
              className="flex w-full items-center gap-2 border-b border-content/5 px-3 py-2 text-left last:border-b-0 hover:bg-content/5"
            >
              <Folder className="size-4 shrink-0 opacity-60" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
              {projects.some((project) => project.path === entry.path) ? <Icon name="check" className="size-3.5 text-accent" /> : null}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          {registered ? (
            <Button variant="destructive" disabled={busy !== null} onClick={() => void forget()}>移除这个项目</Button>
          ) : (
            <Button variant="default" disabled={busy !== null || Boolean(error)} onClick={() => void add()}>添加为项目</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
