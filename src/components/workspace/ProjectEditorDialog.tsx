import { useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import type { Project } from "../../lib/projects"
import { projectRoots } from "../../lib/projects"
import { desktopRuntime, report } from "../../lib/rpc"
import { shortenPath } from "../../lib/workspace-roots"
import { Icon } from "../Icon"
import { Button } from "../UI"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog"
import { Input } from "../ui/input"

type ProjectEditorDialogProps = {
  project: Project
  homeDir: string
  onClose: () => void
  onSave: (project: Project) => Promise<void>
}

export function ProjectEditorDialog({ project, homeDir, onClose, onSave }: ProjectEditorDialogProps) {
  const [name, setName] = useState(project.name)
  const [roots, setRoots] = useState<string[]>(() => projectRoots(project))
  const [saving, setSaving] = useState(false)

  async function addRoots() {
    if (!desktopRuntime()) return
    const selected = await open({ directory: true, multiple: true, title: "添加项目目录", defaultPath: project.path })
    if (!selected) return
    const next = (Array.isArray(selected) ? selected : [selected]).map(path => path.replace(/\/+$/, "") || "/")
    setRoots(current => [...new Set([...current, ...next])])
  }

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave({ ...project, name: name.trim(), roots })
      onClose()
    } catch (error) {
      report(error)
    } finally {
      setSaving(false)
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
    <DialogContent className="project-editor-dialog">
      <DialogHeader><DialogTitle>编辑项目</DialogTitle></DialogHeader>
      <div className="project-editor-body">
        <label className="project-editor-field">
          <span>项目名称</span>
          <Input value={name} onChange={event => setName(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <section className="project-editor-roots" aria-label="项目目录">
          <header><span>目录</span><small>{roots.length} 个 app root</small></header>
          <div className="project-editor-root-list">
            {roots.map((path, index) => {
              const rootName = path.split("/").filter(Boolean).at(-1) || path
              return <div className="project-editor-root" key={path}>
                <Icon name={index === 0 ? "folder-open" : "folder-simple"} />
                <span><strong>{rootName}</strong><small title={path}>{shortenPath(path, homeDir)}</small></span>
                {index === 0 ? <em>主目录</em> : <Button className="project-editor-remove" title={`移除 ${rootName}`} aria-label={`移除 ${rootName}`} onClick={() => setRoots(current => current.filter(root => root !== path))}><Icon name="x" /></Button>}
              </div>
            })}
          </div>
          <Button variant="outline" className="project-editor-add" disabled={!desktopRuntime()} onClick={() => void addRoots().catch(report)}><Icon name="folder-open" />添加目录</Button>
        </section>
      </div>
      <DialogFooter><Button variant="outline" disabled={saving} onClick={onClose}>取消</Button><Button disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? "保存中" : "保存"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
