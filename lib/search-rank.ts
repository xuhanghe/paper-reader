// Ranking the library for a search typed as it is remembered: words in any
// order, part of a word still being typed, Chinese with no spaces to split on.
// Pure — the index is built and searched in memory, a few thousand entries.
//
// Latin text is split into words; Chinese, Japanese and Korean into
// overlapping pairs of characters, so "检索增强" matches inside "基于检索增强的
// 方法" without a dictionary. A word matched in the title counts for more
// than one in the text, and a rare word for more than a common one.

export type RankDoc = { title: string; text: string };

const CJK_CLASS = "[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff]";
const CJK = new RegExp(CJK_CLASS, "u");
// A word of any other script, which ends where Chinese begins: "check是干啥的"
// is "check" and then Chinese, never one word
const WORD = `(?:(?!${CJK_CLASS})[\\p{L}\\p{N}])+`;
const TOKEN = new RegExp(`${CJK_CLASS}+|${WORD}`, "gu");
const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "was", "it", "that", "this", "with", "as", "by", "at", "be", "i", "my", "me", "about"]);

// A hyphenated word, also taken whole: "multi-chaining" is found by
// "multichaining", "all-reduce" by "allreduce"
const COMPOUND = new RegExp(`${WORD}(?:-${WORD})+`, "gu");

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.normalize("NFKC").toLowerCase();
  for (const [compound] of lower.matchAll(COMPOUND)) out.push(compound.replace(/-/g, ""));
  for (const [run] of lower.matchAll(TOKEN)) {
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
  // The words not in Chinese, Japanese or Korean, for matching one misspelt
  latin: string[];
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
  const vocabulary = [...postings.keys()];
  return { docs, postings, vocabulary, latin: vocabulary.filter((w) => w.length >= 3 && !CJK.test(w)) };
}

// Edit distance, given up on once it is past `max`
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// How many near words one may stand for
const MAX_FUZZY = 12;

/**
 * The words a query word may have meant, with how much each counts: a word
 * spelt a letter or two differently ("multichaing", "bandwith"), and a longer
 * word holding it ("chaining" in "multichaining"). Chinese has its pairs of
 * characters for that already.
 */
export function nearWords(index: Pick<RankIndex<RankDoc>, "latin">, term: string): { word: string; weight: number }[] {
  if (term.length < 4 || CJK.test(term)) return [];
  const max = term.length >= 8 ? 2 : 1;
  const near: { word: string; weight: number; rank: number }[] = [];
  for (const word of index.latin) {
    if (word === term) continue;
    if (term.length >= 5 && word.includes(term)) {
      near.push({ word, weight: 0.55, rank: word.length - term.length });
      continue;
    }
    const d = editDistance(term, word, max);
    if (d <= max) near.push({ word, weight: d === 1 ? 0.65 : 0.45, rank: d * 10 });
  }
  return near.sort((a, b) => a.rank - b.rank).slice(0, MAX_FUZZY).map(({ word, weight }) => ({ word, weight }));
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
  // Each word asked for, and what it may stand for: the word itself in full,
  // near spellings and longer words holding it for less, and the words begun
  // by the one still being typed
  const groups: Map<string, number>[] = terms.map((term) => {
    const group = new Map([[term, 1]]);
    for (const { word, weight } of nearWords(index, term)) if (!group.has(word)) group.set(word, weight);
    return group;
  });
  if (typing) {
    const group = groups[groups.length - 1];
    for (const word of index.vocabulary.filter((w) => w !== last && w.startsWith(last)).slice(0, MAX_COMPLETIONS)) group.set(word, Math.max(group.get(word) ?? 0, 0.7));
  }

  const n = index.docs.length;
  const scores = new Map<number, { score: number; matched: Set<string> }>();
  groups.forEach((group, g) => {
    // A group counts once per document: its best word
    const best = new Map<number, number>();
    for (const [word, factor] of group) {
      const byDoc = index.postings.get(word);
      if (!byDoc) continue;
      const idf = Math.log(1 + n / byDoc.size);
      for (const [doc, { title, body }] of byDoc) {
        const weight = idf * (3 * Math.log1p(title) + Math.log1p(body)) * factor;
        if (weight > (best.get(doc) ?? 0)) best.set(doc, weight);
      }
    }
    for (const [doc, weight] of best) {
      const entry = scores.get(doc) ?? { score: 0, matched: new Set<string>() };
      entry.score += weight;
      entry.matched.add(terms[g]);
      scores.set(doc, entry);
    }
  });

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
