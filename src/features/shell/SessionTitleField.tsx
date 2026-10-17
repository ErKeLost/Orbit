import { useRef, useState } from "react";

/**
 * 会话标题的行内编辑器。
 *
 * 双击标题进入，Enter / 失焦提交，Esc 取消。提交只做一次：Enter 之后输入框会被
 * 卸载，浏览器随后一定会补一个 blur，如果不挡住就会提交两遍（第二次用的是空值）。
 */
export function SessionTitleField({
  value,
  onCommit,
  onCancel,
  className = "",
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(false);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    onCommit(draft);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <input
      value={draft}
      autoFocus
      maxLength={80}
      aria-label="会话标题"
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className={`min-w-0 flex-1 rounded-[4px] border border-accent/70 bg-background-base px-1 py-[1px] text-[13px] font-semibold leading-snug text-content outline-none ${className}`.trim()}
    />
  );
}
