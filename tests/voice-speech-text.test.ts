/**
 * 语音 Agent 的文本层：markdown → 能念的话，再切成完整的句子。
 *
 * 这一层的 bug 不会报错，只会让人听到「三体表」「井号井号」或者被半句话噎住，
 * 所以用例都写成"念出来是什么"而不是"字符串等于什么"。
 */
import { describe, expect, test } from "bun:test"
import { completeSentences, newSentences, speakable } from "../src/features/voice/model/speechText"

describe("speakable", () => {
  test("代码块整个不念", () => {
    const text = "先跑这个：\n```bash\npnpm dev\n```\n然后看控制台。"
    expect(speakable(text)).toBe("先跑这个： 然后看控制台。")
  })

  test("行内代码保留内容，只去掉反引号", () => {
    expect(speakable("改 `src/main.ts` 就行。")).toBe("改 src/main.ts 就行。")
  })

  test("表格和分隔线不念", () => {
    const text = "| 项 | 值 |\n| --- | --- |\n| a | 1 |\n结论是好的。"
    expect(speakable(text)).toBe("结论是好的。")
  })

  test("链接念文字，不念地址", () => {
    expect(speakable("见 [Rime 文档](https://docs.rime.ai/) 的延迟页。")).toBe("见 Rime 文档 的延迟页。")
  })

  test("标题、列表、引用、强调都退化成平句", () => {
    const text = "## 结论\n- **第一**条\n- 第二条\n> 引用\n"
    expect(speakable(text)).toBe("结论 第一条 第二条 引用")
  })
})

describe("completeSentences", () => {
  test("末尾没说完的半句不交出去", () => {
    const sentences = completeSentences("第一句已经完整了。第二句还在生")
    expect(sentences).toEqual(["第一句已经完整了。"])
  })

  test("短句不会单独占一次 TTS 往返，会被并到相邻那句里", () => {
    const sentences = completeSentences("这个改动很小。对。但它改的是启动路径。", true)
    expect(sentences).toHaveLength(2)
    expect(sentences[1]).toContain("对。")
  })

  test("问号和感叹号同样算边界", () => {
    const sentences = completeSentences("为什么失败？因为端口被占用了！", true)
    expect(sentences).toHaveLength(2)
  })

  test("没有边界的整段文本一句都不给", () => {
    expect(completeSentences("这句话还没有结束")).toEqual([])
  })

  test("这一轮结束时，末尾那句才交付（流式时它在等下一个字符）", () => {
    expect(completeSentences("它读完了代码。接下来是结论。")).toHaveLength(1)
    expect(completeSentences("它读完了代码。接下来是结论。", true)).toHaveLength(2)
  })

  test("结束时连没有标点的尾巴也念掉", () => {
    expect(completeSentences("没有句号的结尾", true)).toEqual(["没有句号的结尾"])
  })
})

describe("newSentences", () => {
  test("只交出新增的完整句子，并推进游标", () => {
    const first = newSentences("它读完了两个文件。", 0, true)
    expect(first.sentences).toEqual(["它读完了两个文件。"])
    const second = newSentences("它读完了两个文件。接着跑了一次测试。第三个", first.cursor, false)
    expect(second.sentences).toEqual(["接着跑了一次测试。"])
    expect(second.cursor).toBe(2)
  })

  test("文本没长（或者只多了半句）时不重复念", () => {
    const first = newSentences("结论是这样。", 0, true)
    const again = newSentences("结论是这样。还有", first.cursor, false)
    expect(again.sentences).toEqual([])
  })
})
