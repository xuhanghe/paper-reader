import { Model, Effort } from "@/types/session";

export const MODELS: { id: Model; label: string }[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku — fast" },
  { id: "claude-sonnet-4-6", label: "Sonnet — balanced" },
  { id: "claude-opus-4-7", label: "Opus — thorough" },
  { id: "claude-fable-5", label: "Fable — most capable" },
  { id: "codex", label: "Codex — OpenAI" },
  { id: "opencode", label: "OpenCode" },
  { id: "custom", label: "Custom API…" },
];

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
  { id: "max", label: "Max" },
];
