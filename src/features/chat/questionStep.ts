import type { Tool } from "../../lib/protocol";
import { toolName, type TurnStep } from "./turnModel";

export function isQuestionStep(step: TurnStep, tools: Record<string, Tool>) {
  return step.kind === "tool" && step.part != null && toolName(step.part, tools) === "question";
}

/** OpenCode hides a question while it is being asked; the dock is the interface. */
export function isPendingQuestion(step: TurnStep, tools: Record<string, Tool>) {
  if (!isQuestionStep(step, tools) || !step.part) return false;
  const tool = step.part.id ? tools[step.part.id] : undefined;
  return !tool || tool.running;
}
