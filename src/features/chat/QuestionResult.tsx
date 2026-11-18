import type { Part, Tool } from "../../lib/protocol";
import { QUESTION_DISMISSED, questionsFromArguments } from "../../../src-tauri/resources/question";

/**
 * Answered questions, the way OpenCode leaves them in the transcript: the prompt,
 * then the answer, or a quiet note when the dock was dismissed.
 */
export function QuestionResult({ part, tool }: { part: Part; tool?: Tool }) {
  if (!tool || tool.running) return null;
  const text = typeof tool.result === "string" ? tool.result : "";
  if (tool.isError) {
    if (!text.includes(QUESTION_DISMISSED) && !text.includes("dismissed this question")) return null;
    return (
      <div className="flex justify-end py-1">
        <span className="cursor-default text-2xs text-ink-3">Questions dismissed</span>
      </div>
    );
  }
  const questions = questionsFromArguments(part.arguments);
  const answers = tool.details?.answers;
  if (!questions?.length) return null;
  const answered = Array.isArray(answers) && answers.length > 0;
  return (
    <div className="py-1" data-component="question-answers">
      <p className="text-2xs text-ink-3">
        Questions
        {answered ? <span className="text-ink-2"> · {questions.length} answered</span> : null}
      </p>
      {answered ? (
        <div className="mt-1.5 flex flex-col gap-2">
          {questions.map((item, index) => (
            <div key={`${item.header}-${index}`}>
              <p className="text-2xs text-ink-3">{item.question}</p>
              <p className="text-ui text-ink-1">{answers[index]?.length ? answers[index].join(", ") : "(no answer)"}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
