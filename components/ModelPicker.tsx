"use client";
import { Model, Effort } from "@/types/session";
import { MODELS, EFFORTS } from "@/lib/model-options";

type Props = {
  model: Model;
  effort: Effort;
  onModelChange: (model: Model) => void;
  onEffortChange: (effort: Effort) => void;
  onConfigureCustom: () => void;
};

// Compact model + effort selector embedded in panel toolbars
export function ModelPicker({ model, effort, onModelChange, onEffortChange, onConfigureCustom }: Props) {
  const selectStyle = {
    border: "1px solid var(--border)",
    background: "var(--paper)",
    color: "var(--ink-muted)",
  } as const;

  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={model}
        onChange={(e) => onModelChange(e.target.value as Model)}
        className="text-[10px] px-1 py-1 rounded focus:outline-none cursor-pointer max-w-[110px]"
        style={selectStyle}
        title="Model"
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <select
        value={effort}
        onChange={(e) => onEffortChange(e.target.value as Effort)}
        className="text-[10px] px-1 py-1 rounded focus:outline-none cursor-pointer"
        style={selectStyle}
        title="Effort level (Claude, Codex and OpenCode)"
        disabled={model === "custom"}
      >
        {EFFORTS.map((ef) => (
          <option key={ef.id} value={ef.id}>{ef.label}</option>
        ))}
      </select>
      {model === "custom" && (
        <button onClick={onConfigureCustom} className="btn-icon w-5 h-5 text-xs" title="Configure custom API">
          ⚙
        </button>
      )}
    </span>
  );
}
