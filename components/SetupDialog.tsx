"use client";
import { useCallback, useEffect, useState } from "react";

type CliReport = {
  id: string;
  label: string;
  found: boolean;
  path: string;
  version: string | null;
  source: "env" | "path" | "probed" | null;
  envVar: string;
  install: string;
  note: string | null;
};

type Report = {
  zoteroLocal: { reachable: boolean; runningButApiOff: boolean; url: string };
  zoteroKey: { configured: boolean; valid: boolean; canWrite: boolean; username: string | null; problem: string | null };
  clis: CliReport[];
  anyProvider: boolean;
};

type Props = { onClose: () => void };

const KEYS_URL = "https://www.zotero.org/settings/keys/new";

export function SetupDialog({ onClose }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/setup", { cache: "no-store" });
      setReport(await res.json());
    } catch {
      setMessage({ tone: "bad", text: "Couldn't run the checks — is the dev server still up?" });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  // Saving rewrites .env.local, which restarts the dev server — the first
  // re-check can land mid-restart, so give it a moment and one retry.
  const save = async (setting: string, value: string, label: string) => {
    setBusy(setting);
    setMessage(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setting, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "bad", text: data.error || "That didn't save." });
        return;
      }
      setMessage({
        tone: data.warning ? "bad" : "ok",
        text: data.warning || `${label} saved to .env.local.`,
      });
      if (setting === "ZOTERO_API_KEY") setKeyInput("");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await check();
    } catch {
      setMessage({ tone: "bad", text: "The server didn't respond — it may be reloading. Re-check in a moment." });
    } finally {
      setBusy(null);
    }
  };

  const dot = (state: "ok" | "warn" | "bad") => (
    <span
      aria-hidden
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
      style={{ background: `var(--status-${state === "ok" ? "ok" : state === "warn" ? "warn" : "bad"})` }}
    />
  );

  const Row = ({ state, title, children }: { state: "ok" | "warn" | "bad"; title: string; children?: React.ReactNode }) => (
    <div className="flex gap-2.5">
      <span className="mt-[7px]">{dot(state)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium" style={{ color: "var(--ink)" }}>{title}</p>
        {children}
      </div>
    </div>
  );

  const hint = (text: React.ReactNode) => (
    <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--ink-faint)" }}>{text}</p>
  );

  const code = (text: string) => (
    <code
      className="text-[10px] px-1.5 py-0.5 rounded break-all"
      style={{ background: "var(--paper)", border: "1px solid var(--border-light)", color: "var(--ink-muted)" }}
    >
      {text}
    </code>
  );

  const local = report?.zoteroLocal;
  const key = report?.zoteroKey;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] backdrop-blur-sm pr-backdrop"
      style={{ background: "rgba(1,4,9,0.6)" }}
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[78vh] flex flex-col rounded-xl overflow-hidden pr-modal-pop"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-modal)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 flex items-start justify-between gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
              Setup
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--ink-faint)" }}>
              What this reader can reach on your machine right now.
            </p>
          </div>
          <button onClick={() => void check()} disabled={checking} className="btn-ghost text-xs px-2.5 py-1 shrink-0">
            {checking ? "Checking…" : "Re-check"}
          </button>
        </div>

        <div className="px-4 py-3 space-y-4 overflow-y-auto">
          {!report && checking && (
            <p className="text-xs" style={{ color: "var(--ink-faint)" }}>Looking around…</p>
          )}

          {report && (
            <>
              <section className="space-y-3">
                <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>Zotero</p>

                <Row
                  state={local?.reachable ? "ok" : "bad"}
                  title={local?.reachable ? "Local library connected" : local?.runningButApiOff ? "Zotero is running, but its local API is off" : "Zotero isn't answering"}
                >
                  {!local?.reachable && hint(
                    <>
                      In Zotero, open <strong>Settings → Advanced</strong> and tick{" "}
                      <strong>Allow other applications on this computer to communicate with Zotero</strong>.
                      {!local?.runningButApiOff && <> If Zotero isn&apos;t open, start it first.</>}{" "}
                      Then re-check. Reading your library is read-only.
                    </>
                  )}
                  {local?.reachable && hint(<>Listening on {code(local.url)}</>)}
                </Row>

                <Row
                  state={key?.canWrite ? "ok" : key?.configured ? "warn" : "warn"}
                  title={
                    key?.canWrite ? `Highlight sync enabled${key.username ? ` — ${key.username}` : ""}`
                    : key?.configured ? "The saved Zotero key has a problem"
                    : "No Zotero key — highlights stay in the session"
                  }
                >
                  {key?.problem && hint(key.problem)}
                  {!key?.canWrite && (
                    <>
                      {hint(
                        <>
                          The local API can&apos;t write, so annotations travel through zotero.org.{" "}
                          <a href={KEYS_URL} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>
                            Create a key
                          </a>{" "}
                          with <strong>Allow library access</strong> and <strong>Allow write access</strong> ticked, then paste it here.
                        </>
                      )}
                      <div className="flex gap-1.5 mt-2">
                        <input
                          value={keyInput}
                          onChange={(e) => setKeyInput(e.target.value)}
                          placeholder="Paste the key from zotero.org"
                          spellCheck={false}
                          className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded focus:outline-none"
                          style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
                        />
                        <button
                          onClick={() => void save("ZOTERO_API_KEY", keyInput.trim(), "Zotero key")}
                          disabled={!keyInput.trim() || busy === "ZOTERO_API_KEY"}
                          className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40 shrink-0"
                        >
                          {busy === "ZOTERO_API_KEY" ? "Checking…" : "Save"}
                        </button>
                      </div>
                    </>
                  )}
                </Row>
              </section>

              <section className="space-y-3">
                <p className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-faint)" }}>
                  Providers
                </p>
                {!report.anyProvider && hint(
                  <span style={{ color: "var(--status-warn)" }}>
                    None of the CLIs were found. Install one below, or use Custom API from the model dropdown to point at
                    any OpenAI- or Anthropic-compatible endpoint.
                  </span>
                )}

                {report.clis.map((cli) => (
                  <Row
                    key={cli.id}
                    state={cli.found ? (cli.source === "probed" ? "warn" : "ok") : "bad"}
                    title={`${cli.label}${cli.version ? ` — ${cli.version}` : ""}`}
                  >
                    {cli.found && cli.source !== "probed" && hint(code(cli.path))}
                    {cli.found && cli.source === "probed" && (
                      <>
                        {hint(
                          <>
                            {cli.note} Found at {code(cli.path)} — until it is saved, this provider never appears as an
                            option.
                          </>
                        )}
                        <button
                          onClick={() => void save(cli.envVar, cli.path, cli.label)}
                          disabled={busy === cli.envVar}
                          className="btn-primary text-xs px-3 py-1 mt-1.5 disabled:opacity-40"
                        >
                          {busy === cli.envVar ? "Saving…" : `Use this path`}
                        </button>
                      </>
                    )}
                    {!cli.found && hint(
                      <>
                        {cli.note ? `${cli.note} ` : "Not installed. "}
                        Install with {code(cli.install)}
                        {cli.id === "zotero-mcp" && <> — optional; it lets the model search your library while answering.</>}
                      </>
                    )}
                  </Row>
                ))}
              </section>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border-light)" }}>
          {message && (
            <p className="text-[11px] flex-1 min-w-0" style={{ color: message.tone === "ok" ? "var(--status-ok)" : "var(--status-warn)" }}>
              {message.text}
            </p>
          )}
          <button onClick={onClose} className="btn-ghost text-xs px-3 py-1.5 ml-auto shrink-0">Close</button>
        </div>
      </div>
    </div>
  );
}
