// Papers named inline in a question: "compare @Title with …". The text keeps
// the name as typed; the paper it stands for is kept beside it, and a mention
// lives exactly as long as its "@Title" is still whole in the text. Pure, so
// the box, the sent message and the tests all read text the same way.

export type MentionRef = { id: string; name: string; zoteroKey?: string };
export type MentionRange = { start: number; end: number; ref: MentionRef };

// The longest a name being typed after @ is looked up for
const MAX_QUERY = 80;
const AT = /[@＠]/;

export const mentionTitle = (name: string) => name.replace(/\.pdf$/i, "").trim();
export const mentionToken = (ref: MentionRef) => `@${mentionTitle(ref.name)}`;

// A mention starts a word: at the start, or after a space or an opening mark
const startsWord = (text: string, at: number) => at === 0 || /[\s(（「“"'‘[{<]/.test(text[at - 1]);

/** Where each mention stands in the text, in order; longer names win a tie. */
export function mentionRanges(text: string, refs: MentionRef[]): MentionRange[] {
  const ranges: MentionRange[] = [];
  const byLength = [...refs].sort((a, b) => mentionToken(b).length - mentionToken(a).length);
  for (const ref of byLength) {
    const token = mentionToken(ref);
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
      const end = at + token.length;
      if (!startsWord(text, at)) continue;
      if (ranges.some((r) => at < r.end && end > r.start)) continue;
      ranges.push({ start: at, end, ref });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The mentions still whole in the text, each once. */
export function liveMentions(text: string, refs: MentionRef[]): MentionRef[] {
  const seen = new Set<string>();
  return mentionRanges(text, refs)
    .map((range) => range.ref)
    .filter((ref) => !seen.has(ref.id) && seen.add(ref.id));
}

/**
 * The name being typed after an @ at `anchor`, while the caret is still on it;
 * null once the @ is gone, the caret has left, or a line was broken.
 */
export function mentionQuery(text: string, anchor: number, caret: number): string | null {
  if (anchor < 0 || !AT.test(text[anchor] ?? "") || caret <= anchor) return null;
  const query = text.slice(anchor + 1, caret);
  if (query.length > MAX_QUERY || /\n/.test(query)) return null;
  return query;
}

/** Whether what was just typed is an @ that starts a word: a mention begins. */
export function typedMentionStart(before: string, after: string, caret: number): boolean {
  return after.length === before.length + 1 && AT.test(after[caret - 1] ?? "") && startsWord(after, caret - 1);
}

/** The @ and the name typed after it, replaced by the mention and a space. */
export function insertMention(text: string, anchor: number, caret: number, ref: MentionRef): { text: string; caret: number } {
  const token = mentionToken(ref);
  const rest = text.slice(caret);
  const spacer = rest.startsWith(" ") ? "" : " ";
  return { text: `${text.slice(0, anchor)}${token}${spacer}${rest}`, caret: anchor + token.length + 1 };
}

/**
 * A mention is taken out whole: Backspace with the caret just after or inside
 * it, Delete with the caret before or inside it. Null when the key is an
 * ordinary one here.
 */
export function deleteMention(text: string, caret: number, refs: MentionRef[], key: "Backspace" | "Delete"): { text: string; caret: number } | null {
  const hit = mentionRanges(text, refs).find((r) => (key === "Backspace" ? caret > r.start && caret <= r.end : caret >= r.start && caret < r.end));
  if (!hit) return null;
  return { text: text.slice(0, hit.start) + text.slice(hit.end), caret: hit.start };
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]*_`])/g, "\\$1");

/** The prefix of the links a sent message's mentions are drawn as. */
export const MENTION_HREF = "#paper-mention:";

/**
 * A sent message's text with each mention made a link the message view draws
 * as a mention: an in-page link, which the Markdown sanitiser lets through.
 */
export function withMentionLinks(text: string, refs: MentionRef[] | undefined): string {
  if (!refs?.length) return text;
  let out = "";
  let at = 0;
  for (const range of mentionRanges(text, refs)) {
    out += text.slice(at, range.start) + `[${escapeLinkText(mentionToken(range.ref))}](${MENTION_HREF}${encodeURIComponent(range.ref.id)})`;
    at = range.end;
  }
  return out + text.slice(at);
}
