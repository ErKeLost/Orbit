/*
 * 侧栏 / 面板标题上的“正在运行”指示器：一个转动的圆环。
 *
 * 原来用的是盲文点阵（⠋⠙⠹…），每帧的笔画密度都不一样，缩小到 12px 更像乱码而不是
 * 加载；圆环在任何尺寸下都是同一个形状，只用旋转表达“还在动”。
 */
export function TerminalSpinner({
  className = "text-accent",
}: {
  className?: string;
}) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center ${className}`}>
      <svg viewBox="0 0 16 16" className="size-3 animate-spin" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity={0.22} strokeWidth={2} />
        <path
          d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
