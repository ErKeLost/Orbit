import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

/**
 * 开关只有两种状态，视觉上只靠轨道颜色区分：旋钮永远是白的。
 *
 * 几何放在 CSS 变量里，旋钮位置由它们算出来，避免"改了尺寸却忘了同步位移"：
 *   --switch-pad        轨道内边距
 *   --switch-thumb-size 旋钮直径
 * 尺寸就是 shadcn 默认的 w-11 h-6（44 × 24）；旋钮在包含块（内框 = h − 边框 2 = 22px）
 * 里居中，18px 直径上下各留 2px；水平位移取内框宽度的百分比，不用手写 px。
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch relative inline-flex h-6 w-11 shrink-0 items-center justify-start overflow-hidden rounded-full border border-transparent p-[var(--switch-pad)] transition-colors outline-none",
        "[--switch-pad:1px] [--switch-thumb-size:18px]",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        "data-unchecked:bg-[var(--switch-track)] data-checked:bg-[var(--success)]",
        "data-disabled:cursor-not-allowed data-disabled:opacity-60",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none absolute top-1/2 left-0 size-[var(--switch-thumb-size)] -translate-y-1/2 rounded-full bg-[var(--switch-thumb-color)] shadow-[0_1px_2px_rgb(0_0_0/0.35)] transition-[left] group-data-[checked]/switch:left-[calc(100%-var(--switch-thumb-size))]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
