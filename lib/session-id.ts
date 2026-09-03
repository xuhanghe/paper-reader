// The identity of a material that does not live in Zotero.
//
// Zotero papers are keyed by their item key. Everything else — an uploaded
// PDF, a page opened from a URL — is keyed by its name, and the key has to be
// stable (the same material opens into the same conversation) and distinct
// (two materials never share one).
//
// The old scheme kept only ASCII letters and digits. A Chinese title such as
// "笔记：量化那些事之 MoE 混合精度量化 - 知乎" collapsed to "moe" — every
// Chinese article that mentioned MoE shared one id, one tab and one cached
// document, and a wholly Chinese title became "untitled". Opening one such
// page then showed another's document in its tab. Letters and digits of any
// script are kept now; only punctuation and whitespace become separators.

const MAX_LENGTH = 120;

export function sessionIdFor(name: string, zoteroKey?: string): string {
  if (zoteroKey) return zoteroKey;
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

// What the same name mapped to before scripts other than Latin counted. A
// session saved under the old id is found through this and migrated, so a
// paper opened before the change keeps its conversation.
export function legacySessionIdFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_LENGTH) || "untitled";
}
