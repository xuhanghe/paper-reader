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
  // null = checking; false = not in library; {title} = probable existing match
  const [inLibrary, setInLibrary] = useState<null | false | { title: string }>(null);

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
            setInLibrary({ title: found.items[0].title });
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
                ⚠ Probably already in your library as “{inLibrary.title.length > 48 ? inLibrary.title.slice(0, 48) + "…" : inLibrary.title}”
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

          <p className="text-[10px] leading-relaxed" style={{ color: "var(--ink-faint)" }}>
            {docType === "html"
              ? "Saved as a web page snapshot — the library updates automatically."
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
              <button onClick={handleSave} disabled={saving || loading || !!(!targets.length && !loading)} className="btn-primary text-xs px-4 py-1.5">
                {saving ? status || "Saving…" : "Save to Zotero"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
