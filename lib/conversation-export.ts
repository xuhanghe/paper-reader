// A workspace conversation written out as Markdown, to carry to another
// agent or another machine: what the user wants the reader to know first,
// then the papers it concerned, then every turn as it was said.

export type ExportTool = { name: string; detail: string; status?: string };
export type ExportMessage = { role: "user" | "assistant"; content: string; tools?: ExportTool[]; hasImage?: boolean };
export type ExportPaper = { name: string; zoteroKey?: string; sessionDir?: string };
export type ExportInput = {
  workspace: { name: string; root: string };
  exportedAt: Date;
  notes?: string;
  model?: string;
  papers?: ExportPaper[];
  messages: ExportMessage[];
};

const pad = (n: number) => String(n).padStart(2, "0");
export const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Where an export goes unless the user chooses: a notes file named by the day
export function defaultExportPath(now: Date): string {
  return `notes/conversation-${stamp(now).replace(" ", "-").replace(":", "")}.md`;
}

export function buildConversationExport(input: ExportInput): string {
  const out: string[] = [];
  out.push(`# Conversation: ${input.workspace.name}`, "");
  out.push(`Exported from Paper Reader on ${stamp(input.exportedAt)}.`);
  out.push(`Workspace directory: ${input.workspace.root}`);
  if (input.model) out.push(`Model: ${input.model}`);
  out.push("");

  const notes = input.notes?.trim();
  if (notes) out.push("## Notes from the user", "", notes, "");

  if (input.papers?.length) {
    out.push("## Papers in the workspace", "");
    for (const paper of input.papers) {
      const title = paper.name.replace(/\.pdf$/i, "");
      const bits = [paper.zoteroKey ? `Zotero key ${paper.zoteroKey}` : null, paper.sessionDir ? `Reader session: ${paper.sessionDir}` : null].filter(Boolean);
      out.push(`- ${title}${bits.length ? ` — ${bits.join(" · ")}` : ""}`);
    }
    out.push("");
  }

  const turns = input.messages.filter((m) => m.role === "user").length;
  out.push(`## Conversation (${turns} ${turns === 1 ? "turn" : "turns"})`, "");
  let turn = 0;
  for (const message of input.messages) {
    if (message.role === "user") turn += 1;
    out.push(`### ${turn} · ${message.role === "user" ? "You" : "Agent"}`, "");
    if (message.hasImage) out.push("_(a figure was attached)_", "");
    out.push(message.content.trim() || "_(no text)_", "");
    if (message.tools?.length) {
      out.push(`_Tools used: ${message.tools.map((t) => (t.detail ? `${t.name} (${t.detail})` : t.name)).join("; ")}_`, "");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
