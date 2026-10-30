"use client"

/**
 * 会话列表（ElevenLabs UI registry: `conversation`）。
 *
 * 只在这一页用，所以没有跟着 registry 去装 shadcn 的 `button`：滚动到底的按钮就是
 * 一个普通 `<button>`。真正有价值的是 `use-stick-to-bottom`——语音场景里消息是
 * **边生成边追加**的，自己写「跟到底部」的滚动会在用户往上翻时把他拽回来，或者在
 * 流式追加时抖。这个库把「贴底」和「用户已经离开底部」分开了。
 */

import type { ComponentProps } from "react"
import { useCallback } from "react"
import { ArrowDownIcon } from "lucide-react"
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom"

import { cn } from "@/lib/utils"

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-auto overscroll-none", className)}
    // `instant` 而不是 `smooth`：新消息进来时视口应该**整块跳**一格（一次追加通常就是
    // 「你一句 + 它一句」两条的高度），而不是滑过去。语音页看的是对话不丢字，滑动的
    // 那 300ms 只会让人以为消息在动。
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
)

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("p-4", className)} {...props} />
)

export type ConversationEmptyStateProps = Omit<ComponentProps<"div">, "title"> & {
  title?: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
}

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)} {...props}>
    {children ?? (
      <>
        {icon && <div className="opacity-60">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-[13px] font-medium text-content/70">{title}</h3>
          {description && <p className="text-[12px] text-content/40">{description}</p>}
        </div>
      </>
    )}
  </div>
)

export type ConversationScrollButtonProps = ComponentProps<"button">

export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  if (isAtBottom) return null
  return (
    <button
      type="button"
      onClick={handleScrollToBottom}
      aria-label="滚动到底部"
      className={cn(
        "absolute bottom-3 left-1/2 flex size-7 -translate-x-1/2 items-center justify-center rounded-full",
        "border border-stroke bg-background-base/90 text-content/70 shadow-md backdrop-blur",
        "transition-colors hover:text-content",
        className,
      )}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </button>
  )
}
