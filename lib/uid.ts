// A fresh id. randomUUID needs a secure context — localhost is one, and the
// desktop app loads from it — so there is a fallback for anything else.
export function uid(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
