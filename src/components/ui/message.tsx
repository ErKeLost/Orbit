/**
 * 消息行（ElevenLabs UI registry: `message`）。
 *
 * registry 版本依赖 `class-variance-authority` 和 shadcn 的 `avatar`，这里都没带：
 * 这一页只有两种气泡（我说的 / 它说的），变体系统不会用到；头像位直接由调用方塞
 * 进来（我们塞的是那颗球）。class 名保留 `is-user` / `is-assistant`，方便用 `group-`
 * 选择器写样式。
 */

import type { ComponentProps, HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant"
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full items-end gap-2 py-2",
      from === "user" ? "is-user justify-end" : "is-assistant justify-start",
      className,
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({ className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex min-w-0 max-w-[min(100%,34rem)] flex-col gap-1 text-[13px] leading-6",
      "group-[.is-user]:rounded-xl group-[.is-user]:bg-content/10 group-[.is-user]:px-3 group-[.is-user]:py-1.5 group-[.is-user]:text-content",
      "group-[.is-assistant]:text-content/90",
      className,
    )}
    {...props}
  />
)

export type MessageAvatarProps = ComponentProps<"div">

export const MessageAvatar = ({ className, ...props }: MessageAvatarProps) => (
  <div className={cn("size-8 shrink-0 overflow-hidden rounded-full", className)} {...props} />
)
