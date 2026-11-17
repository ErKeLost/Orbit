/**
 * A quote is structured context, not a markdown block the bubble has to render.
 *
 * Pi only accepts text, so the quote rides in the prompt behind a marker the
 * transcript strips before markdown. The model still sees the words; the
 * reader sees a card.
 */

export type Quote = { role: "user" | "assistant"; text: string };

const OPEN = "<<<orbit-quote ";
const CLOSE = "<<<end-orbit-quote>>>";
const MAX_QUOTE = 4_000;

export function quoteExcerpt(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function encodeQuote(quote: Quote, body: string): string {
  const text = quote.text.replace(/\r\n/g, "\n").trim().slice(0, MAX_QUOTE);
  if (!text) return body;
  const role = quote.role === "assistant" ? "assistant" : "user";
  const block = `${OPEN}role="${role}">>>\n${text}\n${CLOSE}`;
  const rest = body.trim();
  return rest ? `${block}\n\n${rest}` : block;
}

export function splitQuote(text: string): { quote: Quote | null; body: string } {
  if (!text.startsWith(OPEN)) return { quote: null, body: text };
  const headerEnd = text.indexOf(">>>\n");
  if (headerEnd < 0) return { quote: null, body: text };
  const header = text.slice(OPEN.length, headerEnd);
  const role = /role="assistant"/.test(header) ? "assistant" : "user";
  const rest = text.slice(headerEnd + 4);
  const closeAt = rest.indexOf(`\n${CLOSE}`);
  if (closeAt < 0) return { quote: null, body: text };
  const quoted = rest.slice(0, closeAt).trim();
  if (!quoted) return { quote: null, body: text };
  const body = rest.slice(closeAt + CLOSE.length + 1).replace(/^\n+/, "");
  return { quote: { role, text: quoted }, body };
}
