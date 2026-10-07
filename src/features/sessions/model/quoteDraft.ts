export const ADD_TO_CHAT_EVENT = "monocode:add-to-chat";

export type AddToChatMode = "quote" | "plain";

export type AddToChatRequest = {
  text: string;
  mode: AddToChatMode;
};

export function requestAddToChat(text: string, mode: AddToChatMode = "quote") {
  if (typeof window === "undefined") return;
  const value = text.replace(/\r\n?/g, "\n").trim();
  if (!value) return;
  window.dispatchEvent(
    new CustomEvent<AddToChatRequest>(ADD_TO_CHAT_EVENT, {
      detail: { text: value, mode },
    }),
  );
}
