// What the Workspace agent is told about the papers attached to a workspace.
//
// A paper read in the Reader has a session folder holding everything done
// there: its text, the fused conversation, the conversation cards and the
// concepts drawn from them. An agent with file tools gets the folder and the
// shape of each file, and reads what a question needs; one without gets a
// digest inline, within a budget, so a long reading history cannot crowd the
// question out.
import { countAsks, countPageImages, dirFor, hasPaperText, readMindmapFile, readPaperText, readState, readThread } from "@/lib/session-store";
import type { Annotation, ConceptEntry } from "@/types/session";

export type WorkspacePaperRef = { id: string; name: string; zoteroKey?: string };

const MAX_PAPERS = 40;
// Papers one message refers to, and how much of their text goes inline to an
// agent that cannot open the files
const MAX_REFERENCES = 6;
const REFERENCE_TEXT_CHARS = 24000;
const MAX_TAKEAWAYS = 6;
const MAX_TAKEAWAY_CHARS = 180;
const INLINE_CHARS_PER_PAPER = 2800;
const INLINE_CHARS_TOTAL = 14000;

export function parsePaperRefs(value: unknown, max = MAX_PAPERS): WorkspacePaperRef[] {
  if (!Array.isArray(value)) return [];
  const refs: WorkspacePaperRef[] = [];
  for (const item of value as Array<Record<string, unknown>>) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    refs.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name : id,
      zoteroKey: typeof item.zoteroKey === "string" && item.zoteroKey ? item.zoteroKey : undefined,
    });
    if (refs.length >= max) break;
  }
  return refs;
}

const titleOf = (ref: WorkspacePaperRef) => ref.name.replace(/\.pdf$/i, "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type PaperRecord = {
  ref: WorkspacePaperRef;
  dir: string;
  hasText: boolean;
  asks: number;
  cards: number;
  concepts: ConceptEntry[];
  pages: number;
  mindmap: boolean;
  // Anything at all recorded about it
  opened: boolean;
};

async function recordFor(ref: WorkspacePaperRef): Promise<PaperRecord> {
  const [hasText, asks, state, pages, mindmap] = await Promise.all([
    hasPaperText(ref.id),
    countAsks(ref.id),
    readState(ref.id),
    countPageImages(ref.id),
    readMindmapFile(ref.id),
  ]);
  const annotations = Array.isArray(state?.annotations) ? (state.annotations as Annotation[]) : [];
  const concepts = Array.isArray(state?.concepts) ? (state.concepts as ConceptEntry[]) : [];
  return { ref, dir: dirFor(ref.id), hasText, asks, cards: annotations.length, concepts, pages, mindmap: !!mindmap, opened: hasText || asks > 0 || !!state };
}

// The few lines of what each conversation established, as the Concepts tab
// shows them: the quickest sense of what I already know about the paper
function takeaways(concepts: ConceptEntry[]): string[] {
  const lines: string[] = [];
  for (const concept of concepts) {
    for (const line of concept.takeaways ?? []) {
      const text = line.replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push(text.length > MAX_TAKEAWAY_CHARS ? `${text.slice(0, MAX_TAKEAWAY_CHARS - 1)}…` : text);
      if (lines.length >= MAX_TAKEAWAYS) return lines;
    }
  }
  return lines;
}

const indent = (text: string) => text.split("\n").map((line) => `      ${line}`).join("\n");

export async function describeWorkspacePapers(refs: WorkspacePaperRef[], opts: { agentic: boolean }): Promise<string> {
  if (!refs.length) return "";
  const records = await Promise.all(refs.slice(0, MAX_PAPERS).map(recordFor));
  const lines: string[] = [];
  let budget = INLINE_CHARS_TOTAL;
  for (const record of records) {
    const head = `- "${titleOf(record.ref)}"${record.ref.zoteroKey ? ` (Zotero key ${record.ref.zoteroKey})` : ""}`;
    if (!record.opened) {
      lines.push(`${head}: not opened in the Reader yet, so nothing is recorded about it${record.ref.zoteroKey ? "; its Zotero record is reachable through Zotero MCP" : ""}.`);
      continue;
    }
    if (opts.agentic) {
      const files: string[] = [];
      if (record.hasText) files.push("paper.md — the full text, with [page N] markers");
      if (record.asks) files.push(`thread.jsonl — my ${plural(record.asks, "question")} there and the answers, one JSON object per line ({ts, role, text, kind, annotationId})`);
      if (record.cards) files.push(`state.json — the ${plural(record.cards, "conversation card")} (annotations: selectedText, pageNumber, messages) and the concepts drawn from them (concepts: label, takeaways)`);
      if (record.pages) files.push(`pages/page-N.jpg — each page as an image (1–${record.pages})`);
      if (record.mindmap) files.push("mindmap.json — a structure map of the paper");
      lines.push(`${head}: ${record.dir}\n    ${files.join(" · ")}`);
    } else {
      lines.push(`${head}: ${plural(record.asks, "question")} asked in the Reader`);
    }
    const learned = takeaways(record.concepts);
    if (learned.length) lines.push(`    What I worked out there: ${learned.map((line) => `• ${line}`).join(" ")}`);
    if (!opts.agentic && record.asks) {
      const share = Math.min(INLINE_CHARS_PER_PAPER, budget);
      if (share < 400) continue;
      const entries = await readThread(record.ref.id, 12, share);
      const text = entries
        .map((entry) => `${entry.role === "user" ? "Me" : "Assistant"}: ${entry.text.replace(/\s+/g, " ").trim().slice(0, entry.role === "user" ? 300 : 700)}`)
        .join("\n");
      if (!text) continue;
      lines.push(`    From that conversation, most recent last:\n${indent(text)}`);
      budget -= text.length;
    }
  }
  const intro = opts.agentic
    ? "Papers attached to this workspace. Each one I have read in the Reader has a folder with everything I did there. Read those files with your file tools whenever a question touches a paper or what we worked out about it, and say when you are drawing on an earlier conversation:"
    : "Papers attached to this workspace, with what I worked out about each in the Reader:";
  return `${intro}\n${lines.join("\n")}`;
}

/**
 * The papers I name inline in one message, "@Title": what each @name stands
 * for — where its files are for an agent that opens them, its text inline for
 * one that cannot, within a budget. Placed by the question, apart from the
 * workspace's papers.
 */
export async function describeReferencedPapers(value: unknown, opts: { agentic: boolean }): Promise<string> {
  const refs = parsePaperRefs(value, MAX_REFERENCES);
  if (!refs.length) return "";
  const records = await Promise.all(refs.map(recordFor));
  const lines: string[] = [];
  let budget = REFERENCE_TEXT_CHARS;
  for (const record of records) {
    const head = `- @${titleOf(record.ref)}${record.ref.zoteroKey ? ` (Zotero key ${record.ref.zoteroKey})` : ""}`;
    if (opts.agentic) {
      const files: string[] = [];
      if (record.hasText) files.push("paper.md — the full text, with [page N] markers");
      if (record.asks) files.push(`thread.jsonl — my ${plural(record.asks, "question")} about it in the Reader and the answers`);
      if (record.cards) files.push(`state.json — the ${plural(record.cards, "conversation card")} and the concepts drawn from them`);
      if (record.mindmap) files.push("mindmap.json — a structure map of the paper");
      lines.push(files.length
        ? `${head}: ${record.dir}\n    ${files.join(" · ")}`
        : `${head}: its text could not be read here${record.ref.zoteroKey ? "; reach it through Zotero MCP" : ""}.`);
    } else {
      const text = budget >= 1000 ? (await readPaperText(record.ref.id))?.trim() : undefined;
      if (text) {
        const share = Math.min(budget, Math.floor(REFERENCE_TEXT_CHARS / refs.length));
        const excerpt = text.length > share ? `${text.slice(0, share)}\n[… the rest of the paper is not included]` : text;
        lines.push(`${head}:\n${indent(excerpt)}`);
        budget -= excerpt.length;
      } else {
        lines.push(`${head}: its text is not available here.`);
      }
    }
    const learned = takeaways(record.concepts);
    if (learned.length) lines.push(`    What I worked out about it in the Reader: ${learned.map((line) => `• ${line}`).join(" ")}`);
  }
  const intro = opts.agentic
    ? "My message names papers inline as @Title. Each stands for the paper below: read what the question needs from its files before answering, and cite it by title:"
    : "My message names papers inline as @Title. Each stands for the paper below:";
  return `${intro}\n${lines.join("\n")}`;
}
