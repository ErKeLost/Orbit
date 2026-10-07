import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { Modal } from "../shared/ui/Modal";

/**
 * Same call shape as the old shadcn dialog, rendered through MonoCode's
 * Modal. The title/description children are lifted into the Modal header.
 */
export function Dialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  if (!open) return null;
  const content = Children.toArray(children).find(isValidElement) as ReactElement<{ children?: ReactNode; className?: string }> | undefined;
  const parts = Children.toArray(content?.props.children);
  const header = parts.find((child) => isValidElement(child) && child.type === DialogHeader) as ReactElement<{ children?: ReactNode }> | undefined;
  const headerParts = Children.toArray(header?.props.children);
  const title = headerParts.find((child) => isValidElement(child) && child.type === DialogTitle) as ReactElement<{ children?: ReactNode }> | undefined;
  const description = headerParts.find((child) => isValidElement(child) && child.type === DialogDescription) as ReactElement<{ children?: ReactNode }> | undefined;
  const body = parts.filter((child) => child !== header);
  return (
    <Modal
      title={typeof title?.props.children === "string" ? title.props.children : "对话框"}
      description={typeof description?.props.children === "string" ? description.props.children : undefined}
      size="md"
      fitViewport
      onClose={() => onOpenChange(false)}
    >
      <div className={`flex flex-col gap-3.5 p-4 text-[13px] ${content?.props.className ?? ""}`}>{body}</div>
    </Modal>
  );
}

export function DialogContent({ children }: { children?: ReactNode; className?: string; showCloseButton?: boolean }) {
  return <>{children}</>;
}

export function DialogHeader({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function DialogTitle({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function DialogDescription({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function DialogFooter({ children }: { children?: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 pt-1">{children}</div>;
}
