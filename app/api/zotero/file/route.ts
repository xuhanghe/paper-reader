import type { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";

const ZOTERO_BASE = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api/users/0";

type ZoteroChild = {
  key: string;
  data: { itemType?: string; contentType?: string; filename?: string; title?: string; url?: string };
};

// Attachment formats the reader can display, in order of preference
const SUPPORTED_TYPES = ["application/pdf", "text/html"];

function pickAttachment(children: ZoteroChild[]): ZoteroChild | null {
  for (const type of SUPPORTED_TYPES) {
    const match = children.find((c) => c.data?.contentType === type);
    if (match) return match;
  }
  return null;
}

// Resolve an item key to its best readable attachment and stream the file back
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key")?.trim();
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  try {
    // The key may itself be an attachment, or a parent item with attachments
    const itemRes = await fetch(`${ZOTERO_BASE}/items/${key}`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!itemRes.ok) {
      return Response.json({ error: `Zotero item not found (${itemRes.status})` }, { status: 502 });
    }
    const item = (await itemRes.json()) as ZoteroChild;

    let attachment: ZoteroChild | null = null;
    let allTypes: string[] = [];

    if (item.data?.contentType) {
      attachment = SUPPORTED_TYPES.includes(item.data.contentType) ? item : null;
      allTypes = [item.data.contentType];
    } else {
      const childrenRes = await fetch(`${ZOTERO_BASE}/items/${key}/children`, {
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      });
      if (childrenRes.ok) {
        const children = (await childrenRes.json()) as ZoteroChild[];
        const attachments = children.filter((c) => c.data?.contentType);
        allTypes = attachments.map((c) => c.data.contentType!);
        attachment = pickAttachment(attachments);
      }
    }

    if (!attachment) {
      const found = allTypes.length ? ` Found: ${[...new Set(allTypes)].join(", ")}.` : "";
      return Response.json(
        { error: `This item has no readable attachment (PDF or HTML snapshot) in Zotero.${found}` },
        { status: 415 }
      );
    }

    const contentType = attachment.data.contentType!;
    const filename = attachment.data.filename || attachment.data.title || "document";

    // Zotero's local API answers /file with a 302 redirect to a file:// URL,
    // which fetch cannot follow — resolve it manually and read from disk.
    const fileRes = await fetch(`${ZOTERO_BASE}/items/${attachment.key}/file`, {
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
      redirect: "manual",
    });

    let body: BodyInit;
    if (fileRes.status >= 300 && fileRes.status < 400) {
      const location = fileRes.headers.get("location");
      if (!location?.startsWith("file://")) {
        return Response.json({ error: "Zotero returned an unexpected file location." }, { status: 502 });
      }
      body = new Uint8Array(await readFile(fileURLToPath(location)));
    } else if (fileRes.ok && fileRes.body) {
      body = fileRes.body;
    } else {
      return Response.json({ error: `Could not fetch the file (${fileRes.status})` }, { status: 502 });
    }

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "X-Filename": encodeURIComponent(filename),
        // Needed to write annotations back onto this attachment
        "X-Attachment-Key": attachment.key,
        // Original page URL for snapshots — kept so re-saves don't lose it
        ...(attachment.data.url ? { "X-Source-Url": encodeURIComponent(attachment.data.url) } : {}),
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return Response.json(
      { error: "Could not reach Zotero. Make sure Zotero is running with the local API enabled." },
      { status: 502 }
    );
  }
}
