// Bringing a model's maths into the form the markdown renderer reads.
//
// remark-math recognises `$…$` and `$$…$$`, which is what the renderer is
// wired for. Models trained on LaTeX just as often write `\(…\)` and `\[…\]`,
// and an answer in that form showed its formulas as raw source. The
// delimiters are rewritten here, and nothing inside code is touched — a
// fenced block or an inline span is where a backslash means itself.

const SEGMENTS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  return markdown
    .split(SEGMENTS)
    .map((part, index) => (index % 2 === 1 ? part : rewrite(part)))
    .join("");
}

function rewrite(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
}
