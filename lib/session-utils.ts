export function makeLabel(text: string, type: "text" | "image"): string {
  if (type === "image") return "Figure region";
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length < text.trim().length ? words + "…" : words;
}
