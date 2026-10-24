// How the workspace agent is run: as a partner in a discussion, or as a hand
// that implements. The mode shapes the prompt and the power the CLI is run
// with; both may write files, the discussion only lightly.
export type AgentMode = "discussion" | "auto";

export function parseAgentMode(value: unknown): AgentMode {
  return value === "auto" ? "auto" : "discussion";
}

export function modeDirective(mode: AgentMode): string {
  if (mode === "auto") {
    return "Auto mode: you are here to implement. Work on your own with the tools you have — read, write and edit files, run commands and tests — inside the working directory, and carry the task through to a result you have checked. Report what you did and what you verified, briefly. Ask only when a decision is genuinely the user's to make.";
  }
  return "Discussion mode: we are thinking together, as in a chat. Keep the focus on the conversation — question the premise, propose directions, weigh trade-offs, and say what you would do and why. What is already implemented, and implementing anything now, is beside the point. You may read files to ground what you say, and you may write notes (a file under notes/, say), but do not start building, refactoring or running experiments: when something should be built, say so and leave it for auto mode.";
}

// What the claude CLI is allowed: edits without asking in a discussion, the
// classifier-gated auto mode when implementing
export function claudePermissionMode(mode: AgentMode): "acceptEdits" | "auto" {
  return mode === "auto" ? "auto" : "acceptEdits";
}
