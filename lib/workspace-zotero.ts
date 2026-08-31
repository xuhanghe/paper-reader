import type { MaterialTab } from "@/components/MaterialTabs";

export type ZoteroPaper = { key: string; title: string; creators: string; year: string; itemType: string };
export type ZoteroCollection = { key: string; name: string; parentKey: string | null; numItems: number };

export function flattenZoteroCollections(collections: ZoteroCollection[]): Array<ZoteroCollection & { depth: number }> {
  const result: Array<ZoteroCollection & { depth: number }> = [];
  const visited = new Set<string>();
  const visit = (parentKey: string | null, depth: number) => {
    collections.filter((collection) => collection.parentKey === parentKey).sort((a, b) => a.name.localeCompare(b.name)).forEach((collection) => {
      if (visited.has(collection.key)) return;
      visited.add(collection.key);
      result.push({ ...collection, depth });
      visit(collection.key, depth + 1);
    });
  };
  visit(null, 0);
  collections.filter((collection) => !visited.has(collection.key)).forEach((collection) => result.push({ ...collection, depth: 0 }));
  return result;
}

export function zoteroCollectionBranch(collections: ZoteroCollection[], rootKey: string): string[] {
  const result: string[] = [];
  const pending = [rootKey];
  while (pending.length) {
    const key = pending.shift()!;
    if (result.includes(key)) continue;
    result.push(key);
    pending.push(...collections.filter((collection) => collection.parentKey === key).map((collection) => collection.key));
  }
  return result;
}

export function zoteroPaperTab(paper: ZoteroPaper): MaterialTab {
  return { id: paper.key, name: `${paper.title}.pdf`, docType: "pdf", zoteroKey: paper.key };
}
