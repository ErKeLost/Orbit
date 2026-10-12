import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Session } from "../../lib/protocol";
import { report, retireSession } from "../../lib/rpc";
import { sessionTitle } from "../../lib/session-visual";
import { MenuItem, MenuSeparator, PointMenu } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";
import { Copy, MessageSquare, Trash2 as Trash } from "../../shared/ui/icons";
import { ConfirmDialog } from "./ConfirmDialog";

type SessionMenuState = { session: Session; x: number; y: number };

/**
 * 会话列表共用的右键菜单：会话侧栏和项目栏的会话卡片都从这里出，
 * 「打开 / 复制 / 删除」只有一份实现。
 */
export function useSessionContextMenu({
  onOpen,
  canDelete,
  onDeleted,
}: {
  onOpen: (session: Session) => void;
  /** 有些条目（还没落盘的活跃会话）删不了。 */
  canDelete?: (session: Session) => boolean;
  onDeleted?: (session: Session) => void;
}) {
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  const openMenu = (session: Session, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ session, x: event.clientX, y: event.clientY });
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);

  const remove = async () => {
    if (!deleting || busy) return;
    const target = deleting;
    setBusy(true);
    try {
      await retireSession(target.path);
      setDeleting(null);
      onDeleted?.(target);
      toast.success("会话已删除");
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const menuNode = (
    <>
      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="会话操作" onClose={() => setMenu(null)}>
          <MenuItem icon={<MessageSquare strokeWidth={1.75} />} onClick={() => { onOpen(menu.session); setMenu(null); }}>打开会话</MenuItem>
          <MenuItem icon={<Copy strokeWidth={1.75} />} onClick={() => { copy(sessionTitle(menu.session)); setMenu(null); }}>复制标题</MenuItem>
          <MenuItem icon={<Copy strokeWidth={1.75} />} onClick={() => { copy(menu.session.path); setMenu(null); }}>复制路径</MenuItem>
          {canDelete?.(menu.session) === false ? null : (
            <>
              <MenuSeparator />
              <MenuItem danger icon={<Trash strokeWidth={1.75} />} onClick={() => { setDeleting(menu.session); setMenu(null); }}>删除会话</MenuItem>
            </>
          )}
        </PointMenu>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="删除会话"
          confirmLabel="删除"
          danger
          busy={busy}
          onCancel={() => { if (!busy) setDeleting(null); }}
          onConfirm={() => void remove()}
        >
          <div className="flex gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-red-500/12 text-red-400">
              <Trash className="size-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-3 break-words text-[13px] font-medium leading-snug text-content" title={sessionTitle(deleting)}>
                {sessionTitle(deleting)}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-content/55">会话文件会从 Pi 的会话目录中永久删除，无法恢复。</p>
              {deleting.path ? (
                <p className="mt-1.5 truncate font-mono text-[11px] leading-tight text-content/35" title={deleting.path}>
                  {deleting.path}
                </p>
              ) : null}
            </div>
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );

  return { openMenu, menuNode };
}
