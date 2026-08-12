export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

// CLI args for the effort level; empty when absent/invalid so callers can spread it
export function effortArgs(effort: unknown): string[] {
  return typeof effort === "string" && (EFFORT_LEVELS as readonly string[]).includes(effort)
    ? ["--effort", effort]
    : [];
}

// spawn() rejects arguments containing null bytes, which PDF-extracted text
// can contain — strip them before passing anything as a CLI argument
export function sanitizeSpawnArg(s: string): string {
  return s.replace(/\u0000/g, "");
}
