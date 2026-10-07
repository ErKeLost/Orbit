import { runGuiTaskEngine as runEngine } from "../../src-tauri/resources/computer-use/gui-task-engine";

// Unit tests inject decisions and observations; risk assessment must also be
// local so results never depend on a developer's API key or network access.
export const runGuiTaskEngine = (options: Parameters<typeof runEngine>[0]) => runEngine({
  decide: async () => { throw new Error("Unit tests must provide a local decision"); },
  assessRisk: async () => ({
    probability: 0,
    model: "test-risk",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
  ...options,
});
