"use client";

// Fetches a Zotero item's attachment and extracts plain text from it in the
// browser — used to include a referenced paper as context in a question.
export async function extractZoteroItemText(
  key: string,
  maxChars = 20000
): Promise<{ text: string } | { error: string }> {
  try {
    const res = await fetch(`/api/zotero/file?key=${encodeURIComponent(key)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return { error: data?.error || "Could not fetch the referenced paper" };
    }

    const contentType = res.headers.get("Content-Type") || "";
    if (contentType.includes("text/html")) {
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const text = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
      return { text: text.slice(0, maxChars) };
    }

    const buffer = await res.arrayBuffer();
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
    }
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    let text = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\u0000/g, " ")
        .replace(/\s+/g, " ");
      text += `\n[page ${p}] ${pageText}`;
      if (text.length >= maxChars) break;
    }
    doc.destroy();
    return { text: text.slice(0, maxChars) };
  } catch {
    return { error: "Could not read the referenced paper" };
  }
}
