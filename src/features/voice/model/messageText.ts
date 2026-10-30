/**
 * 一条 Pi 消息里"能念出来的文字"。
 *
 * 坑在这里：`PiMessage.content` 是 `string | Part[]`，而实际会话文件里几乎永远是
 * `Part[]`（`[{type:"text",text:"…"}]`，还常常带一个 `thinking` part）。只判断
 * `typeof content === "string"` 会拿到空字符串——表现就是"agent 明明回了，页面一片空白"。
 */
import type { PiMessage } from "@/lib/protocol";

export function messageText(message: PiMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
}
