"use client";
import { useState, useEffect } from "react";
import { isSubmitKey } from "@/lib/keys";

type Target = { id: string; name: string; level: number };

type Props = {
  onOpen: (title: string, data: string, finalUrl: string | undefined, docType: "pdf" | "html") => void;
  onClose: () => void;
  onSaved?: () => void; // fired after a successful Zotero save
};

export function OpenUrlModal({ onOpen, onClose, onSaved }: Props) {
  const [url, setUrl] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("L1");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [saveToZotero, setSaveToZotero] = useState(true);
  const [asPdf, setAsPdf] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/zotero/targets");
        const data = await res.json();
        if (res.ok) {
          setTargets(data.targets);
          if (data.current) setTarget(data.current);
        }
      } catch {
        // Zotero unreachable — reading still works, saving just won't
      }
    })();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, busy]);

  const handleGo = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(asPdf ? "Rendering page to PDF…" : "Fetching page…");
      const res = await fetch("/api/fetch-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), format: asPdf ? "pdf" : "html" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not fetch the page");

      const content = asPdf ? data.pdf_base64 : data.html;
      const openName = asPdf ? `${data.title}.pdf` : data.title;
      onOpen(openName, content, data.finalUrl, asPdf ? "pdf" : "html");

      if (saveToZotero && targets.length > 0) {
        let resolvedTarget: string | undefined = target;
        if (target === "__new__") {
          if (!newCollectionName.trim()) throw new Error("Give the new collection a name.");
          setStatus("Creating collection… (waits for Zotero to sync)");
          const createRes = await fetch("/api/zotero/create-collection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newCollectionName.trim() }),
          });
          const createData = await createRes.json();
          if (!createRes.ok) throw new Error(createData.error || "Could not create the collection");
          resolvedTarget = createData.target;
        }

        setStatus("Saving to Zotero…");
        const saveRes = asPdf
          ? await fetch("/api/zotero/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: openName,
                data_base64: content,
                target: resolvedTarget,
                source_url: data.finalUrl,
                // A rendered page is saved as a webpage item with the PDF
                // attached — never as a bare PDF for Zotero to "recognise"
                as: "webpage",
              }),
            })
          : await fetch("/api/zotero/save-page", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: data.finalUrl, html: content, title: data.title, target: resolvedTarget }),
            });
        const saveData = await saveRes.json();
        if (!saveRes.ok) {
          setError(`Page opened, but saving to Zotero failed: ${saveData.error || saveRes.status}`);
          setBusy(false);
          setStatus(null);
          return;
        }
        onSaved?.();
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] backdrop-blur-sm pr-backdrop"
      style={{ background: "rgba(1,4,9,0.6)" }}
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-xl overflow-hidden pr-modal-pop"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-modal)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
            Open a web page
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--ink-faint)" }}>
            Read a blog post (Zhihu, Medium, …) and optionally snapshot it into Zotero
          </p>
        </div>

        <div className="px-4 py-3 space-y-3">
          <input
            type="url"
            autoFocus
            value={url}
            placeholder="https://zhuanlan.zhihu.com/p/…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (isSubmitKey(e)) handleGo(); }}
            className="w-full text-sm px-3 py-2 rounded focus:outline-none"
            style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
          />

          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--ink-muted)" }}>
            <input type="checkbox" checked={asPdf} onChange={(e) => setAsPdf(e.target.checked)} />
            Convert to PDF — renders math, code, and figures properly (recommended)
          </label>

          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--ink-muted)" }}>
            <input
              type="checkbox"
              checked={saveToZotero}
              onChange={(e) => setSaveToZotero(e.target.checked)}
              disabled={targets.length === 0}
            />
            Save to Zotero{targets.length === 0 ? " (Zotero not reachable)" : ""}
          </label>

          {saveToZotero && targets.length > 0 && (
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full text-xs px-2 py-2 rounded focus:outline-none cursor-pointer"
              style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {" ".repeat(t.level * 3)}{t.level > 0 ? "📁 " : "🏛 "}{t.name}
                </option>
              ))}
              <option value="__new__">＋ New collection…</option>
            </select>
          )}

          {saveToZotero && target === "__new__" && (
            <input
              type="text"
              value={newCollectionName}
              placeholder="New collection name…"
              onChange={(e) => setNewCollectionName(e.target.value)}
              className="w-full text-xs px-2.5 py-2 rounded focus:outline-none"
              style={{ border: "1px solid var(--accent)", background: "var(--paper)", color: "var(--ink)" }}
            />
          )}

          {status && <p className="text-xs" style={{ color: "var(--accent)" }}>{status}</p>}
          {error && <p className="text-[11px] leading-relaxed" style={{ color: "#F87171" }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border-light)" }}>
          <button onClick={onClose} disabled={busy} className="btn-ghost text-xs px-3 py-1.5">
            Cancel
          </button>
          <button onClick={handleGo} disabled={busy || !url.trim()} className="btn-primary text-xs px-4 py-1.5">
            {busy ? status || "Working…" : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
