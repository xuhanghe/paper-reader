// Ranking the library for a search typed as it is remembered: words in any
// order, part of a word still being typed, Chinese with no spaces to split on.
// Pure — the index is built and searched in memory, a few thousand entries.
//
// Latin text is split into words; Chinese, Japanese and Korean into
// overlapping pairs of characters, so "检索增强" matches inside "基于检索增强的
// 方法" without a dictionary. A word matched in the title counts for more
// than one in the text, and a rare word for more than a common one.

export type RankDoc = { title: string; text: string };

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const TOKEN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+|[\p{L}\p{N}]+/gu;
const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "was", "it", "that", "this", "with", "as", "by", "at", "be", "i", "my", "me", "about"]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const [run] of text.normalize("NFKC").toLowerCase().matchAll(TOKEN)) {
    if (CJK.test(run[0])) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    } else if (!STOP.has(run)) {
      out.push(run);
    }
  }
  return out;
}

type Posting = { title: number; body: number };
export type RankIndex<D extends RankDoc> = {
  docs: D[];
  postings: Map<string, Map<number, Posting>>;
  // Each word once, for completing the one still being typed
  vocabulary: string[];
};

export function buildRankIndex<D extends RankDoc>(docs: D[]): RankIndex<D> {
  const postings = new Map<string, Map<number, Posting>>();
  const add = (token: string, doc: number, field: keyof Posting) => {
    let byDoc = postings.get(token);
    if (!byDoc) postings.set(token, (byDoc = new Map()));
    const entry = byDoc.get(doc) ?? { title: 0, body: 0 };
    entry[field] += 1;
    byDoc.set(doc, entry);
  };
  docs.forEach((doc, i) => {
    for (const token of tokenize(doc.title)) add(token, i, "title");
    for (const token of tokenize(doc.text)) add(token, i, "body");
  });
  return { docs, postings, vocabulary: [...postings.keys()] };
}

export type Ranked<D> = { doc: D; score: number; matched: string[] };

// How many words a half-typed one may stand for
const MAX_COMPLETIONS = 12;

export function rankSearch<D extends RankDoc>(index: RankIndex<D>, query: string, limit = 20): Ranked<D>[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  // The last Latin word may still be being typed: it also stands for the
  // words it begins
  const last = terms[terms.length - 1];
  const typing = !CJK.test(last) && last.length >= 2 && /[\p{L}\p{N}]$/u.test(query.trimEnd()) && query.trimEnd() === query;
  const groups: string[][] = terms.map((term) => [term]);
  if (typing) {
    const completions = index.vocabulary.filter((word) => word !== last && word.startsWith(last)).slice(0, MAX_COMPLETIONS);
    groups[groups.length - 1] = [last, ...completions];
  }

  const n = index.docs.length;
  const scores = new Map<number, { score: number; matched: Set<string> }>();
  for (const group of groups) {
    // A group counts once per document: its best word
    const best = new Map<number, number>();
    for (const word of group) {
      const byDoc = index.postings.get(word);
      if (!byDoc) continue;
      const idf = Math.log(1 + n / byDoc.size);
      for (const [doc, { title, body }] of byDoc) {
        const weight = idf * (3 * Math.log1p(title) + Math.log1p(body)) * (word === group[0] ? 1 : 0.7);
        if (weight > (best.get(doc) ?? 0)) best.set(doc, weight);
      }
    }
    for (const [doc, weight] of best) {
      const entry = scores.get(doc) ?? { score: 0, matched: new Set<string>() };
      entry.score += weight;
      entry.matched.add(group[0]);
      scores.set(doc, entry);
    }
  }

  // A document holding every word asked for is worth more than one holding
  // the rarest word many times
  const ranked: Ranked<D>[] = [];
  for (const [doc, { score, matched }] of scores) {
    const coverage = matched.size / groups.length;
    ranked.push({ doc: index.docs[doc], score: score * (0.35 + 0.65 * coverage * coverage), matched: [...matched] });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A window of the text around the first word that matched, for showing why. */
export function snippet(text: string, query: string, width = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of tokenize(query)) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return `${flat.slice(0, width - 1)}…`;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Which of several texts matches the query best — the exchange of a
 * conversation a search should land on. -1 when none shares a word with it.
 */
export function bestMatch(texts: string[], query: string): number {
  const terms = new Set(tokenize(query));
  if (!terms.size) return -1;
  let best = -1;
  let bestScore = 0;
  texts.forEach((text, i) => {
    const words = tokenize(text);
    const seen = new Set(words.filter((w) => terms.has(w)));
    // Words matched, then how often: a pair holding every word beats one
    // repeating a single word
    const score = seen.size * 10 + Math.min(words.filter((w) => terms.has(w)).length, 9);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}
