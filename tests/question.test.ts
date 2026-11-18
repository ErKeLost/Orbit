import { describe, expect, test } from "bun:test";
import { emptyTranscript, reduceEvent } from "../src/lib/protocol";
import {
  answersFromValue,
  formatQuestionAnswers,
  nextQuestionDraft,
  parseQuestions,
  questionAnswer,
  questionPayload,
  questionSummary,
  questionsFromPayload,
} from "../src-tauri/resources/question";

const questions = parseQuestions({
  questions: [
    {
      question: "What should happen?",
      header: "Action",
      options: [{ label: "Build", description: "Build it" }],
    },
    {
      question: "Which environment?",
      header: "Environment",
      options: [{ label: "Dev", description: "Development" }],
      multiple: true,
    },
    { question: "Anything else?", header: "Optional", options: [] },
  ],
});

describe("question", () => {
  test("rejects an empty list and keeps a custom-only prompt", () => {
    expect(() => parseQuestions({ questions: [] })).toThrow("至少一道题");
    expect(questions[2]).toEqual({ question: "Anything else?", header: "Optional", options: [], multiple: false });
  });

  test("round-trips the card payload and formats answers like OpenCode", () => {
    expect(questionsFromPayload(questionPayload(questions))?.map((item) => item.header)).toEqual(["Action", "Environment", "Optional"]);
    const answers = [
      questionAnswer(questions[0], { selected: ["Build"], customText: "", customOn: false }),
      questionAnswer(questions[1], { selected: ["Dev"], customText: "Staging", customOn: true }),
      questionAnswer(questions[2], { selected: [], customText: "  ", customOn: true }),
    ];
    expect(answers).toEqual([["Build"], ["Dev", "Staging"], []]);
    expect(formatQuestionAnswers(questions, answers)).toBe(
      'User has answered your questions: "What should happen?"="Build", "Which environment?"="Dev, Staging", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.',
    );
  });

  test("a typed reply that is not the card payload answers the first question", () => {
    expect(answersFromValue("用现有的", questions)).toEqual([["用现有的"], [], []]);
  });

  test("keeps a picked option apart from a custom answer that happens to use its label", () => {
    const picked = nextQuestionDraft(
      { selected: ["files"], customText: "", customOn: false },
      { type: "custom-input", text: "files", multiple: true },
    );
    expect(questionAnswer({ multiple: true }, picked)).toEqual(["files"]);
    const edited = nextQuestionDraft(picked, { type: "custom-input", text: "files2", multiple: true });
    expect(questionAnswer({ multiple: true }, edited)).toEqual(["files", "files2"]);
    const single = nextQuestionDraft(
      { selected: ["wide"], customText: "", customOn: false },
      { type: "custom-input", text: "  Split view ", multiple: false },
    );
    expect(single.selected).toEqual([]);
    expect(questionAnswer({ multiple: false }, single)).toEqual(["Split view"]);
    expect(questionSummary(0, 1)).toBe("Question");
    expect(questionSummary(1, 3)).toBe("2 of 3 questions");
  });

  test("keeps question answers on the tool result the transcript reads", () => {
    const state = reduceEvent(emptyTranscript(), {
      type: "tool_execution_end",
      toolCallId: "q1",
      toolName: "question",
      result: { content: [{ type: "text", text: "answered" }], details: { answers: [["Build"], []] } },
      isError: false,
    });
    expect(state.tools.q1?.details?.answers).toEqual([["Build"], []]);
  });
});
