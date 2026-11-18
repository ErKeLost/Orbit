/** OpenCode `question`: one or more prompts, answered in the composer card. */

export const QUESTION_TITLE = "orbit:question"

/** Dismissal is not model-facing: the turn ends, and the transcript says the questions were dismissed. */
export const QUESTION_DISMISSED = "The user dismissed this question"

export type QuestionOption = { label: string; description: string }

export type QuestionPrompt = {
  question: string
  header: string
  options: QuestionOption[]
  multiple: boolean
}

export type QuestionDraft = { selected: string[]; customText: string; customOn: boolean }

export const QUESTION_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export function parseQuestions(params: unknown): QuestionPrompt[] {
  const questions = (params as { questions?: unknown } | null)?.questions
  if (!Array.isArray(questions) || questions.length === 0) throw new Error("question 需要至少一道题")
  return questions.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 题格式不对`)
    const record = item as { question?: unknown; header?: unknown; options?: unknown; multiple?: unknown }
    const question = typeof record.question === "string" ? record.question.trim() : ""
    const header = typeof record.header === "string" ? record.header.trim() : ""
    if (!question || !header) throw new Error(`第 ${index + 1} 题需要 question 和 header`)
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== "object") return []
          const row = option as { label?: unknown; description?: unknown }
          const label = typeof row.label === "string" ? row.label.trim() : ""
          if (!label) return []
          return [{ label, description: typeof row.description === "string" ? row.description.trim() : "" }]
        })
      : []
    return { question, header, options, multiple: record.multiple === true }
  })
}

export function questionPayload(questions: readonly QuestionPrompt[]) {
  return JSON.stringify({ questions })
}

export function questionsFromPayload(raw: string): QuestionPrompt[] | null {
  try {
    return parseQuestions(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Picked options, then the typed answer when it is on and not already one of them. */
export function questionAnswer(question: Pick<QuestionPrompt, "multiple">, draft: QuestionDraft): string[] {
  const custom = draft.customOn ? draft.customText.trim() : ""
  if (!question.multiple) {
    if (draft.customOn) return custom ? [custom] : []
    return draft.selected.slice(0, 1)
  }
  if (!custom || draft.selected.includes(custom)) return [...draft.selected]
  return [...draft.selected, custom]
}

export function formatQuestionAnswers(questions: readonly QuestionPrompt[], answers: readonly (readonly string[])[]) {
  const formatted = questions
    .map((question, index) => `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`)
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export function encodeAnswers(answers: readonly (readonly string[])[]) {
  return JSON.stringify({ answers })
}

export function questionsFromArguments(value: unknown): QuestionPrompt[] | null {
  try {
    return parseQuestions(value)
  } catch {
    return null
  }
}

/** OpenCode dock title: one question is "Question"; a set is "1 of 3 questions". */
export function questionSummary(index: number, total: number) {
  if (total <= 1) return "Question"
  const current = Math.min(index + 1, Math.max(total, 1))
  return `${current} of ${total} questions`
}

export type QuestionDraftEvent =
  | { type: "pick"; value: string; multiple: boolean }
  | { type: "custom-input"; text: string; multiple: boolean }
  | { type: "custom-select"; multiple: boolean }
  | { type: "custom-deselect" }

/**
 * OpenCode `nextDraft`: a typed answer and a picked option stay apart, so typing an option's
 * label never picks or unpicks it.
 */
export function nextQuestionDraft(draft: QuestionDraft, event: QuestionDraftEvent): QuestionDraft {
  if (event.type === "pick") {
    if (!event.multiple) {
      if (draft.selected.length === 1 && draft.selected[0] === event.value && !draft.customOn) return draft
      return { selected: [event.value], customText: draft.customText, customOn: false }
    }
    return {
      selected: draft.selected.includes(event.value)
        ? draft.selected.filter((value) => value !== event.value)
        : [...draft.selected, event.value],
      customText: draft.customText,
      customOn: draft.customOn,
    }
  }
  if (event.type === "custom-deselect") {
    if (!draft.customOn) return draft
    return { selected: draft.selected, customText: draft.customText, customOn: false }
  }
  const text = event.type === "custom-input" ? event.text : draft.customText
  const selected = event.multiple ? draft.selected : []
  if (draft.customOn && text === draft.customText && selected.length === draft.selected.length) return draft
  return { selected, customText: text, customOn: true }
}

/** Card reply, or a spoken/plain string used as the first question's own answer. */
export function answersFromValue(raw: string, questions: readonly QuestionPrompt[]): string[][] {
  try {
    const parsed = JSON.parse(raw) as { answers?: unknown }
    const answers = parsed?.answers
    if (Array.isArray(answers)) {
      return questions.map((_, index) => {
        const value = answers[index]
        if (Array.isArray(value)) return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
        if (typeof value === "string" && value.trim()) return [value.trim()]
        return []
      })
    }
  } catch {
    /* not the card payload */
  }
  const text = raw.trim()
  return questions.map((_, index) => (index === 0 && text ? [text] : []))
}
