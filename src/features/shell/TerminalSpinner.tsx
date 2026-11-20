import { CircleDashed } from "../../shared/ui/icons";

/*
 * 侧栏 / 面板标题上的“正在运行”指示器。
 *
 * 实心缺口环缩到 12px 会糊成一个点。虚线圆每一帧都还是圆，旋转只表示还在动。
 */
export function TerminalSpinner({
  className = "text-accent",
}: {
  className?: string;
}) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center ${className}`}>
      <CircleDashed className="size-3.5 animate-spin" strokeWidth={1.5} />
    </span>
  );
}
