import type { ReactNode } from "react";
import { Modal } from "../../shared/ui/Modal";
import { Loader } from "../../shared/ui/icons";

/** MonoCode's small confirmation dialog (DeleteWorktreeDialog's frame and buttons). */
export function ConfirmDialog({
  title,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal title={title} size="sm" onClose={() => { if (!busy) onCancel(); }}>
      <form
        className="flex flex-col gap-3.5 p-4 text-[13px] leading-[1.5]"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        {children ? <div className="text-content/75">{children}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]">
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium active:scale-[0.97] disabled:opacity-40 ${
              danger
                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:hover:bg-red-500/20"
                : "bg-content text-background-base hover:bg-content/80"
            }`}
          >
            {busy ? <Loader className="size-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
