/**
 * 把 agent 的 markdown 变成「能念出口的话」，再切成句。
 *
 * 两件事分开是为了各自可测：
 *
 * * `speakable` 只做删减——代码块、表格、路径标记这些念出来是噪音的东西不进去。
 *   它**不**改写措辞，措辞是 prompt 的事，不是正则的事。
 * * `completeSentences` 只做切分，而且只返回**已经完整**的句子：半句拿去合成，
 *   后半句接不上，听起来像卡带。剩下的尾巴留到下一个 delta 再切。
 */

const CODE_FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`([^`]*)`/g
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g
const HEADING = /^#{1,6}\s+/gm
const LIST_MARKER = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm
const QUOTE_MARKER = /^\s{0,3}>\s?/gm
const EMPHASIS = /[*_~]{1,3}/g
const TABLE_ROW = /^\s*\|.*$/gm
const TABLE_RULE = /^\s*\|?[\s:-]*-[\s|:-]*$/gm
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/gm

/** markdown → 可以直接念的一段话。缩进和空行都会被压平。 */
export function speakable(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n")
  text = text.replace(CODE_FENCE, " ")
  text = text.replace(TABLE_RULE, " ")
  text = text.replace(TABLE_ROW, " ")
  text = text.replace(RULE, " ")
  text = text.replace(IMAGE, " ")
  text = text.replace(LINK, "$1")
  text = text.replace(HTML_TAG, " ")
  // 行内代码保留内容：`pnpm dev` 念出来是"pnpm dev"，删掉反而丢信息。
  text = text.replace(INLINE_CODE, "$1")
  text = text.replace(HEADING, "")
  text = text.replace(LIST_MARKER, "")
  text = text.replace(QUOTE_MARKER, "")
  text = text.replace(EMPHASIS, "")
  return text.replace(/\s+/g, " ").trim()
}

const BOUNDARY = /[.!?。！？…]/
const TERMINAL = /[.!?。！？…]$/
const SOFT_BOUNDARY = /\n/
/** 中日韩字符：这些语言句末没有空格，边界判定不能要求「后面跟空格」。 */
const CJK = /[\u3000-\u9fff\uff00-\uffef]/

/**
 * 单句太短会变成一串碎片（"对。"、"好的。"），TTS 每次调用都要一次往返，
 * 碎片既浪费延迟又难听。低于这个长度的句子并进上一句。
 */
const MIN_SENTENCE = 6

/**
 * 切出所有**完整**句子。返回值里不包含末尾那半句——除非 `final` 说明这一轮结束了。
 */
export function completeSentences(text: string, final = false): string[] {
  const out: string[] = []
  let buffer = ""
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    buffer += char
    if (!BOUNDARY.test(char)) {
      // 换行是个软边界：只在句子已经够长时才切，否则短句会被拆成一堆碎片。
      if (SOFT_BOUNDARY.test(char) && buffer.trim().length >= MIN_SENTENCE) {
        flush(out, buffer)
        buffer = ""
      }
      continue
    }
    const next = text[i + 1]
    if (next === undefined) {
      // 句子结束在字符串末尾：流式途中它是"还在长"，`final` 才是"就这样了"。
      // 这两个状态必须分开——否则最后一句永远等不到下一个字符，永远不念。
      if (!final) break
      flush(out, buffer)
      buffer = ""
      break
    }
    // 英文里 "e.g." 的句点后面直接跟字母，那不是句末；中文没有空格，所以中文直接切。
    if (next !== " " && next !== "\n" && !BOUNDARY.test(next) && !CJK.test(next)) continue
    flush(out, buffer)
    buffer = ""
  }
  // 这一轮结束了，剩下没有标点的尾巴也念掉：agent 最后一句常常没有句号。
  if (final) flush(out, buffer)
  return out
}

function flush(out: string[], buffer: string): void {
  const sentence = buffer.trim()
  if (!sentence) return
  const previous = out[out.length - 1]
  // 上一句没有结束标点（软换行切出来的），或者短得不像一句，就并进去。
  if (previous !== undefined && (!TERMINAL.test(previous) || previous.length < MIN_SENTENCE)) {
    out[out.length - 1] = `${previous} ${sentence}`.replace(/\s+/g, " ").trim()
    return
  }
  out.push(sentence)
}

/**
 * 边生成边念：只交出「新出现的、已经完整的」句子。
 *
 * `already` 是上一次返回的数组长度——因为文本只会往后长，用长度做游标就够，
 * 不必按内容比对。
 */
export function newSentences(
  text: string,
  already: number,
  final = false,
): { sentences: string[]; cursor: number } {
  const spoken = speakable(text)
  const sentences = completeSentences(spoken, final)
  if (sentences.length <= already) return { sentences: [], cursor: already }
  return { sentences: sentences.slice(already), cursor: sentences.length }
}
