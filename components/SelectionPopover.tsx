"use client";

type Props = {
  rect: DOMRect;
  onExplain: () => void;
  onDismiss: () => void;
};

export function SelectionPopover({ rect, onExplain, onDismiss }: Props) {
  return (
    <div
      style={{
        position: "fixed",
        top: rect.bottom + 8,
        left: rect.left + rect.width / 2,
        transform: "translateX(-50%)",
        zIndex: 50,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "5px 10px",
      }}
    >
      <button
        onClick={onExplain}
        className="text-sm font-medium transition-opacity hover:opacity-80"
        style={{ color: "var(--accent)", fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}
      >
        Explain this ↗
      </button>
      <span style={{ color: "var(--border)", margin: "0 4px" }}>|</span>
      <button
        onClick={onDismiss}
        className="text-xs transition-opacity hover:opacity-70"
        style={{ color: "var(--ink-faint)" }}
      >
        ✕
      </button>
    </div>
  );
}
