import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import { Message, MessageContent } from "@/components/ui/message";
import { Response } from "@/components/ui/response";
import type { VoiceLogItem } from "../model/voice-controller";

/** Keep the latest user message outside the reply's independently scrolling area. */
export function VoiceExchange({ log, error }: { log: VoiceLogItem[]; error: string | null }) {
  const userIndex = log.findLastIndex(item => item.kind === "user");
  const user = log[userIndex];
  const replies = log.slice(userIndex + 1).filter(item => item.kind === "agent");
  const notices = log.slice(userIndex + 1).filter(item => item.kind === "system" && item.text !== error);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-none flex-col gap-1 px-4 pb-2">
      {user ? (
        <Message from="user" aria-label="你的消息" className="shrink-0">
          <MessageContent><Response>{user.text}</Response></MessageContent>
        </Message>
      ) : null}
      {replies.length ? (
        <Conversation key={user?.id ?? "announcements"} aria-label="AI 回复" className="voice-log w-full flex-none">
          <ConversationContent scrollClassName="voice-reply-scroll" className="p-0 pb-1">
            <Message from="assistant" className="items-start">
              <MessageContent className="gap-4">
                {replies.map(item => <Response key={item.id} className="h-auto">{item.text}</Response>)}
              </MessageContent>
            </Message>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      ) : null}
      {notices.map(item => (
        <p key={item.id} className="py-1 text-center text-[11px] leading-relaxed text-content/35">{item.text}</p>
      ))}
    </div>
  );
}
