export const runtime = "nodejs";

const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";

type ZoteroCollection = {
  key: string;
  meta?: { numItems?: number };
  data: { name?: string; parentCollection?: string | false };
};

export async function GET() {
  try {
    // Zotero caps responses at 100 — paginate until exhausted
    const all: ZoteroCollection[] = [];
    for (let start = 0; start < 1000; start += 100) {
      const res = await fetch(`${ZOTERO_BASE}/collections?limit=100&start=${start}`, {
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      });
      if (!res.ok) {
        return Response.json(
          { error: `Zotero responded with ${res.status}. Is the local API enabled?` },
          { status: 502 }
        );
      }
      const page = (await res.json()) as ZoteroCollection[];
      all.push(...page);
      if (page.length < 100) break;
    }

    const collections = all
      .filter((c) => c.data?.name)
      .map((c) => ({
        key: c.key,
        name: c.data.name!,
        parentKey: c.data.parentCollection || null,
        numItems: c.meta?.numItems ?? 0,
      }));
    return Response.json({ collections });
  } catch {
    return Response.json(
      {
        error:
          "Could not reach Zotero. Make sure Zotero is running and “Allow other applications on this computer to communicate with Zotero” is enabled in Settings → Advanced.",
      },
      { status: 502 }
    );
  }
}
