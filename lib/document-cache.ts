// Document bytes, held across surface switches.
//
// Reader and Workspace are separate routes: crossing between them unmounts one
// and mounts the other, and any cache living in component state goes with it.
// The Reader kept its documents in a ref and the Workspace kept none, so every
// crossing refetched the whole PDF from Zotero and re-encoded it as a data URL
// before pdf.js could even start. On a real paper that is the difference
// between a switch you notice and one you don't.
//
// Module scope survives client-side navigation — the JS heap is not torn down
// between routes — so this outlives both components without any provider.

const cache = new Map<string, string>();

// Data URLs of whole PDFs are large. This is a working set for the papers in
// play, not a library: oldest out first, and a hard byte ceiling so a session
// spent opening big papers can't grow the heap without bound.
const MAX_ENTRIES = 12;
const MAX_BYTES = 220 * 1024 * 1024;

function totalBytes(): number {
  let total = 0;
  for (const value of cache.values()) total += value.length;
  return total;
}

export function getCachedDocument(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const hit = cache.get(id);
  // Re-insert so the most recently used entry is last, making the first key
  // the oldest when we evict
  if (hit !== undefined) {
    cache.delete(id);
    cache.set(id, hit);
  }
  return hit;
}

export function cacheDocument(id: string | undefined, dataUrl: string): void {
  if (!id || !dataUrl) return;
  cache.delete(id);
  cache.set(id, dataUrl);
  while (cache.size > MAX_ENTRIES || (cache.size > 1 && totalBytes() > MAX_BYTES)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function forgetDocument(id: string | undefined): void {
  if (id) cache.delete(id);
}

// Test seam — the cache is module state by design.
export function resetDocumentCache(): void {
  cache.clear();
}

export function cachedDocumentIds(): string[] {
  return [...cache.keys()];
}
