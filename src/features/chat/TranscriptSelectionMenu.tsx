import { useEffect, useRef } from "react";
import { Copy } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import type { TranscriptSelection } from "./useTranscriptSelection";

type Props = {
  selection: TranscriptSelection | null;
  onDismiss: () => void;
};

/** 选中回答文字后的浮动操作条：复制到剪贴板（Orbit `TranscriptSelectionMenu`）。 */
export function TranscriptSelectionMenu({ selection, onDismiss }: Props) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // 滚动或改变窗口大小后，文字已经从菜单底下移走，选区随之失效；直接收起。
  useEffect(() => {
    if (!selection) return;
    const dismiss = () => onDismissRef.current();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [selection]);

  if (!selection) return null;

  return (
    <Popover
      anchor={selection.rect}
      side="top"
      align="center"
      onDismiss={(reason) => {
        if (reason === "escape") window.getSelection()?.removeAllRanges();
        onDismiss();
      }}
      role="toolbar"
      aria-label="选中文字操作"
      className="p-1"
    >
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          void navigator.clipboard.writeText(selection.text).catch(() => undefined);
          window.getSelection()?.removeAllRanges();
          onDismiss();
        }}
        className="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 font-sans text-[13px] leading-none text-content outline-none ring-accent/40 hover:bg-content/5 focus-visible:ring-2"
      >
        <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
        复制
      </button>
    </Popover>
  );
}
