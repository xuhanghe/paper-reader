"use client";
import { useState, useEffect } from "react";

type Target = { id: string; name: string; level: number; recent?: boolean };

type Props = {
  fileName: string;
  dataUrl: string; // PDF data URL, or raw HTML when docType is "html"
  docType?: "pdf" | "html";
  sourceUrl?: string;
  onDone: () => void;
  onSaved?: () => void; // fired after a successful save (refreshes the library)
};

export function SaveToZoteroModal({ fileName, dataUrl, docType = "pdf", sourceUrl, onDone, onSaved }: Props) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("L1");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState(sourceUrl || "");
  // null = checking; false = not in library; otherwise the entry that has it.
  // A match by URL is exact and names the entry; a match by title is a guess.
  type LibraryMatch = { title: string; key?: string; itemType?: string; byUrl?: boolean };
  const [inLibrary, setInLibrary] = useState<null | false | LibraryMatch>(null);
  // URL-matched entries that are not webpage items: each was made from this
  // very page but mis-recognised as a paper (see lib/zotero-webpage.ts).
  // Saving files the page correctly; ticking the box moves these to the trash.
  const [misfiled, setMisfiled] = useState<{ key: string; title: string; itemType: string }[]>([]);
  const [replaceOld, setReplaceOld] = useState(true);
  // Already filed correctly: saving again would only make a second copy
  const alreadySaved = !!inLibrary && !!inLibrary.byUrl && inLibrary.itemType === "webpage";

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        // A page fetched from the web is identified by its URL, which is
        // exact; a title match is the fallback for everything else
        if (sourceUrl) {
          const byUrl = await fetch(`/api/zotero/by-url?url=${encodeURIComponent(sourceUrl)}`);
          const found = await byUrl.json();
          if (stale) return;
          if (byUrl.ok && Array.isArray(found.items) && found.items.length > 0) {
            const hits = found.items as { key: string; title: string; itemType: string }[];
            // The entry the reader should see is the page filed as a page,
            // when there is one; the rest are mis-recognised copies of it
            const page = hits.find((h) => h.itemType === "webpage") ?? hits[0];
            setInLibrary({ title: page.title, key: page.key, itemType: page.itemType, byUrl: true });
            setMisfiled(hits.filter((h) => h.itemType !== "webpage"));
            return;
          }
        }
        const q = fileName.replace(/\.pdf$/i, "").slice(0, 80);
        const res = await fetch(`/api/zotero/items?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (stale) return;
        if (res.ok && Array.isArray(data.items)) {
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const target = norm(fileName.replace(/\.pdf$/i, ""));
          const hit = data.items.find((i: { title: string }) => {
            const t = norm(i.title || "");
            return t.length > 8 && (t === target || target.includes(t) || t.includes(target));
          });
          setInLibrary(hit ? { title: hit.title } : false);
        } else {
          setInLibrary(false);
        }
      } catch {
        if (!stale) setInLibrary(false);
      }
    })();
    return () => { stale = true; };
  }, [fileName, sourceUrl]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/zotero/targets");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load Zotero collections");
        setTargets(data.targets);
        if (data.current) setTarget(data.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load Zotero collections");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDone]);

  // The page is already filed correctly and only the mis-recognised copies
  // remain: clean up without making a second copy of the page.
  const handleTrashOnly = async () => {
    setSaving(true);
    setError(null);
    setStatus(misfiled.length === 1 ? "Moving the old entry to the trash…" : "Moving the old entries to the trash…");
    const failed: string[] = [];
    for (const entry of misfiled) {
      const trashed = await fetch(`/api/zotero/items?key=${encodeURIComponent(entry.key)}`, { method: "DELETE" }).catch(() => null);
      if (!trashed?.ok) failed.push(entry.title.slice(0, 40));
    }
    setSaving(false);
    setStatus(null);
    if (failed.length) {
      setError(`Could not move to the trash: ${failed.map((t) => `“${t}”`).join(", ")} — remove in Zotero.`);
      return;
    }
    onSaved?.();
    setNotice(misfiled.length === 1 ? "The mis-filed entry is in Zotero's trash. The page stays saved as a web page." : "The mis-filed entries are in Zotero's trash. The page stays saved as a web page.");
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      let resolvedTarget: string | undefined = target;
      let warning: string | undefined;

      if (target === "__new__") {
        if (!newCollectionName.trim()) throw new Error("Give the new collection a name.");
        setStatus("Creating collection… (waits for Zotero to sync)");
        const res = await fetch("/api/zotero/create-collection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newCollectionName.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not create the collection");
        resolvedTarget = data.target;
        warning = data.warning;
      }

      setStatus("Saving to Zotero…");
      const res =
        docType === "html"
          ? await fetch("/api/zotero/save-page", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: pageUrl.trim() || `https://paper-reader.local/${encodeURIComponent(fileName)}`,
                html: dataUrl,
                title: fileName,
                target: resolvedTarget,
              }),
            })
          : await fetch("/api/zotero/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: fileName,
                data_base64: dataUrl,
                target: resolvedTarget,
                // A page rendered to PDF is saved as a webpage item with the
                // PDF attached; a paper from disk goes to Zotero's recogniser
                ...(pageUrl.trim() ? { source_url: pageUrl.trim(), as: "webpage" } : {}),
              }),
            });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");

      // The page is now filed correctly; the mis-recognised entries can go
      if (replaceOld && misfiled.length > 0) {
        setStatus(misfiled.length === 1 ? "Moving the old entry to the trash…" : "Moving the old entries to the trash…");
        for (const entry of misfiled) {
          const trashed = await fetch(`/api/zotero/items?key=${encodeURIComponent(entry.key)}`, { method: "DELETE" });
          if (!trashed.ok) {
            warning = warning ?? `Saved, but “${entry.title.slice(0, 40)}” could not be moved to the trash — remove it in Zotero.`;
          }
        }
      }

      onSaved?.();
      const finalNotice = warning || data.warning;
      if (finalNotice) {
        setNotice(finalNotice);
        setSaving(false);
        setStatus(null);
      } else {
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
      setStatus(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] backdrop-blur-sm pr-backdrop"
      style={{ background: "rgba(1,4,9,0.6)" }}
      onClick={onDone}
    >
      <div
        className="w-[420px] max-w-[90vw] rounded-xl overflow-hidden pr-modal-pop"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-modal)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
            Save to Zotero?
          </p>
          <p className="text-xs mt-1 truncate" style={{ color: "var(--ink-faint)" }} title={fileName}>
            {fileName}
          </p>
          <p className="text-[11px] mt-1.5 flex items-center gap-1.5">
            {inLibrary === null ? (
              <span style={{ color: "var(--ink-faint)" }}>Checking your library…</span>
            ) : inLibrary ? (
              <span style={{ color: "var(--badge-text-fg)" }} title={inLibrary.title}>
                ⚠ {inLibrary.byUrl ? "This page is already in your library, filed as" : "Probably already in your library as"}{" "}
                “{inLibrary.title.length > 48 ? inLibrary.title.slice(0, 48) + "…" : inLibrary.title}”
                {inLibrary.byUrl && inLibrary.itemType ? ` (${inLibrary.itemType})` : ""}
              </span>
            ) : (
              <span style={{ color: "var(--ink-muted)" }}>
                <span style={{ color: "var(--accent)" }}>•</span> Not in your Zotero library yet
              </span>
            )}
          </p>
        </div>

        <div className="px-4 py-3 space-y-2">
          <label className="block text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>
            Collection
          </label>
          {loading ? (
            <p className="text-xs py-1.5" style={{ color: "var(--ink-faint)" }}>Loading collections…</p>
          ) : (
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full text-xs px-2 py-2 rounded focus:outline-none cursor-pointer"
              style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {" ".repeat(t.level * 3)}{t.level > 0 ? "📁 " : "🏛 "}{t.name}
                </option>
              ))}
              <option value="__new__">＋ New collection…</option>
            </select>
          )}

          {!loading && target === "__new__" && (
            <input
              type="text"
              autoFocus
              value={newCollectionName}
              placeholder="New collection name…"
              onChange={(e) => setNewCollectionName(e.target.value)}
              className="w-full text-xs px-2.5 py-2 rounded focus:outline-none"
              style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
            />
          )}

          {docType === "html" && (
            <>
              <label className="block text-[10px] uppercase tracking-widest pt-1" style={{ color: "var(--ink-faint)" }}>
                Source URL
              </label>
              <input
                type="url"
                value={pageUrl}
                placeholder="https://… (the page's original address)"
                onChange={(e) => setPageUrl(e.target.value)}
                className="w-full text-xs px-2.5 py-2 rounded-md focus:outline-none"
                style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              />
              {!pageUrl.trim() && (
                <p className="text-[10px]" style={{ color: "var(--badge-text-fg)" }}>
                  Without a URL, the Zotero item will link to a placeholder address.
                </p>
              )}
            </>
          )}

          {status && <p className="text-xs" style={{ color: "var(--accent)" }}>{status}</p>}
          {notice && <p className="text-[11px] leading-relaxed" style={{ color: "var(--badge-text-fg)" }}>{notice}</p>}
          {error && (
            <p className="text-[11px] leading-relaxed" style={{ color: "#F87171" }}>{error}</p>
          )}

          {misfiled.length > 0 && (
            <div className="rounded-md px-2.5 py-2 space-y-1.5" style={{ border: "1px solid var(--border)", background: "var(--paper)" }}>
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                {misfiled.length === 1 ? "This entry was" : "These entries were"} made from this page but mis-recognised as a
                paper — the only attachment is this page&apos;s PDF:
              </p>
              <ul className="text-[11px] leading-relaxed pl-3 list-disc" style={{ color: "var(--ink)" }}>
                {misfiled.map((entry) => (
                  <li key={entry.key} title={entry.title}>
                    “{entry.title.length > 56 ? entry.title.slice(0, 56) + "…" : entry.title}” <span style={{ color: "var(--ink-faint)" }}>({entry.itemType})</span>
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2 text-[11px] cursor-pointer" style={{ color: "var(--ink)" }}>
                <input type="checkbox" className="mt-0.5" checked={replaceOld} onChange={(e) => setReplaceOld(e.target.checked)} />
                <span>Move {misfiled.length === 1 ? "it" : "them"} to Zotero&apos;s trash after saving</span>
              </label>
            </div>
          )}

          <p className="text-[10px] leading-relaxed" style={{ color: "var(--ink-faint)" }}>
            {alreadySaved
              ? "Already in your library as a web page — saving again makes a second copy."
              : docType === "html"
                ? "Saved as a web page snapshot — the library updates automatically."
                : pageUrl.trim()
                  ? "Saved as a web page, with the rendered PDF attached — the library updates automatically."
                  : "Zotero runs metadata recognition on the PDF — the library updates automatically."}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border-light)" }}>
          {notice ? (
            <button onClick={onDone} className="btn-primary text-xs px-4 py-1.5">
              Close
            </button>
          ) : (
            <>
              <button onClick={onDone} disabled={saving} className="btn-ghost text-xs px-3 py-1.5">
                Don&apos;t save
              </button>
              {/* Already filed as a page: cleaning up the mis-recognised copies is
                  the likely intent, and saving again is a second copy */}
              {alreadySaved && misfiled.length > 0 ? (
                <>
                  <button onClick={handleSave} disabled={saving || loading} className="btn-ghost text-xs px-3 py-1.5">
                    Save another copy
                  </button>
                  <button onClick={handleTrashOnly} disabled={saving} className="btn-primary text-xs px-4 py-1.5">
                    {saving ? status || "Working…" : misfiled.length === 1 ? "Trash the mis-filed entry" : "Trash the mis-filed entries"}
                  </button>
                </>
              ) : (
                <button onClick={handleSave} disabled={saving || loading || !!(!targets.length && !loading)} className="btn-primary text-xs px-4 py-1.5">
                  {saving ? status || "Saving…" : alreadySaved ? "Save another copy" : "Save to Zotero"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
