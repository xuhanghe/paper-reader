// The language a document is written in, inferred from its script.
//
// This exists for the paper map, which has to be written in the paper's own
// language. A model reading the text can usually tell, but not always: a
// Chinese article about GPU kernels is half English identifiers and code, and
// asking for "the paper's main language" invites it to answer in English. Where
// the script settles the question, we say so outright.
//
// Only scripts that map to a single language are reported. Latin-script
// documents return null and the decision is left to the model, which is reading
// the text anyway — guessing French from an alphabet would be worse than not
// guessing.

export type DocumentLanguage = "Chinese" | "Japanese" | "Korean" | null;

// A share small enough that a code-heavy Chinese article still counts, and
// large enough that a Chinese name in an English paper's references does not.
const MIN_SHARE = 0.05;
const MIN_LENGTH = 40;

// Kana settles Japanese against Chinese: Japanese also uses Han characters, but
// Chinese never uses kana. So it has to be tested first.
function classify(dense: string, minShare: number): DocumentLanguage {
  const share = (re: RegExp) => (dense.match(re)?.length ?? 0) / dense.length;
  if (share(/[぀-ヿ]/g) >= minShare) return "Japanese";
  if (share(/[가-힣]/g) >= minShare) return "Korean";
  if (share(/[㐀-鿿]/g) >= minShare) return "Chinese";
  return null;
}

export function dominantLanguage(text: string): DocumentLanguage {
  const dense = text.replace(/\s/g, "");
  if (dense.length < MIN_LENGTH) return null;
  return classify(dense, MIN_SHARE);
}

// The language of something the user typed — a question in the ask box.
//
// Separate from dominantLanguage because the inputs are nothing alike. A
// question is a handful of characters, so there is no length floor; but the bar
// per character is much higher, because an English question may well name a
// Chinese term ("what does 优化 mean here?") without being a Chinese question.
const INPUT_MIN_SHARE = 0.2;

export function inputLanguage(text: string): DocumentLanguage {
  const dense = text.replace(/\s/g, "");
  if (!dense) return null;
  return classify(dense, INPUT_MIN_SHARE);
}
