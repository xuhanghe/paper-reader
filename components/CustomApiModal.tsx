"use client";
import { useState } from "react";
import { CustomApiConfig } from "@/types/session";

type Props = {
  initial: CustomApiConfig | null;
  onSave: (cfg: CustomApiConfig) => void;
  onClose: () => void;
};

export function CustomApiModal({ initial, onSave, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || "");
  const [apiKey, setApiKey] = useState(initial?.apiKey || "");
  const [model, setModel] = useState(initial?.model || "");
  const [vision, setVision] = useState(initial?.vision ?? false);
  const [format, setFormat] = useState<"openai" | "anthropic">(initial?.format ?? "openai");
  const [maxTokens, setMaxTokens] = useState(String(initial?.maxTokens ?? ""));

  const canSave = baseUrl.trim() && model.trim();

  const field = (label: string, value: string, set: (v: string) => void, placeholder: string, type = "text") => (
    <div>
      <label className="block text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ink-faint)" }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        className="w-full text-xs px-2.5 py-2 rounded focus:outline-none"
        style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
        onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
        onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
      />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] backdrop-blur-sm pr-backdrop"
      style={{ background: "rgba(1,4,9,0.6)" }}
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-xl overflow-hidden pr-modal-pop"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-modal)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
            Custom API
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--ink-faint)" }}>
            An OpenAI-compatible endpoint (vLLM, Ollama, OpenRouter, …) or an
            Anthropic Messages endpoint. Stored locally in your browser.
          </p>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ink-faint)" }}>
              API format
            </label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as "openai" | "anthropic")}
              className="w-full text-xs px-2.5 py-2 rounded focus:outline-none"
              style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
            >
              <option value="openai">OpenAI-compatible — /chat/completions</option>
              <option value="anthropic">Anthropic — /v1/messages</option>
            </select>
          </div>
          {field("Base URL", baseUrl, setBaseUrl, format === "anthropic" ? "https://api.anthropic.com" : "https://api.example.com/v1")}
          {field("API key (optional for local servers)", apiKey, setApiKey, "sk-…", "password")}
          {field("Model", model, setModel, format === "anthropic" ? "e.g. claude-sonnet-4-6" : "e.g. gpt-5.2, qwen3-coder, llama-4-70b")}
          {format === "anthropic" &&
            field("Max tokens (Anthropic requires one; blank = 8192)", maxTokens, setMaxTokens, "8192")}
          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--ink-muted)" }}>
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
            Model supports images (vision) — figures and page snapshots will be sent; leave off for text-only models
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border-light)" }}>
          <button onClick={onClose} className="btn-ghost text-xs px-3 py-1.5">Cancel</button>
          <button
            onClick={() =>
              canSave &&
              onSave({
                baseUrl: baseUrl.trim().replace(/\/+$/, ""),
                apiKey: apiKey.trim(),
                model: model.trim(),
                vision,
                format,
                ...(Number(maxTokens) > 0 ? { maxTokens: Number(maxTokens) } : {}),
              })
            }
            disabled={!canSave}
            className="btn-primary text-xs px-4 py-1.5 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
