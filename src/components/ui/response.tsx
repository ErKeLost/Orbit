/**
 * 一段回答（ElevenLabs UI registry: `response`）。
 *
 * registry 版本包 `streamdown`（连带 react-markdown + shiki + katex）来渲染 markdown。
 * 语音页不装它，两个原因：
 *
 * * **内容本来就是纯文本。** 独立语音对话模型输出可直接朗读的短句，
 *   旁白更是我们自己拼的短句，渲染器只会是空转。
 * * **这一页对首字延迟最敏感。** 多拉一个带着 shiki 的 chunk 换不来任何可见差别。
 *
 * 保留下来的只有 registry 的语义：`whitespace-pre-wrap` 保住它自己的换行，
 * 并且去掉首尾多余边距，好让连续几段贴在一起。
 */

import { memo, type ComponentProps } from "react"

import { cn } from "@/lib/utils"

type ResponseProps = ComponentProps<"div">

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <div
      className={cn(
        "size-full whitespace-pre-wrap break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
)

Response.displayName = "Response"
