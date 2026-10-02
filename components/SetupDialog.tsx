"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// The setup assistant: four steps from nothing to a working reader, each one
// checked by the server and fixed by it where a local app can. It watches
// for the things it can't do itself — a download, a sign-in in the browser —
// and moves on by itself when they are done.

type CliReport = {
  id: "claude" | "codex" | "opencode" | "zotero-mcp";
  label: string;
  found: boolean;
  path: string;
  version: string | null;
  source: "env" | "path" | "probed" | null;
  envVar: string;
  install: string;
  note: string | null;
  auth: { loggedIn: boolean | null; account: string | null };
  loginCommand: string | null;
  installer: string;
};

type Report = {
  platform: "mac" | "linux" | "windows" | "other";
  zoteroApp: { installed: boolean | null; path: string | null; version: string | null; running: boolean; downloadUrl: string };
  zoteroLocal: { reachable: boolean; runningButApiOff: boolean; url: string };
  zoteroPrefs: { profileFound: boolean; localApiEnabled: boolean | null; syncUsername: string | null };
  zoteroKey: { configured: boolean; valid: boolean; canWrite: boolean; username: string | null; problem: string | null };
  newKeyUrl: string;
  clis: CliReport[];
  anyProvider: boolean;
  installers: { npm: boolean; uv: boolean; brew: boolean };
};

type StepId = "app" | "api" | "key" | "agent" | "done";
const STEPS: { id: StepId; label: string }[] = [
  { id: "app", label: "Zotero" },
  { id: "api", label: "Library" },
  { id: "key", label: "Sync" },
  { id: "agent", label: "Agent" },
  { id: "done", label: "Ready" },
];

type Props = { onClose: () => void; firstRun?: boolean };

const PROVIDERS: CliReport["id"][] = ["claude", "codex", "opencode"];

export function SetupDialog({ onClose, firstRun = false }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [skippedKey, setSkippedKey] = useState(false);
  // The step shown. null means "the first one not yet done"
  const [chosen, setChosen] = useState<StepId | null>(null);
  // What the assistant is waiting for the person (or Zotero) to finish
  const [waiting, setWaiting] = useState<"app" | "api" | "login" | null>(null);

  const check = useCallback(async (scope?: "zotero") => {
    setChecking(true);
    try {
      const res = await fetch(scope ? "/api/setup?fresh=1&scope=zotero" : "/api/setup?fresh=1", { cache: "no-store" });
      const data = await res.json();
      setReport((prev) => (scope && prev ? { ...prev, ...data } : data));
    } catch {
      setMessage({ tone: "bad", text: "Couldn't run the checks — is the dev server still up?" });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const done = useMemo(() => {
    const r = report;
    const providers = r?.clis.filter((c) => PROVIDERS.includes(c.id)) ?? [];
    const agentReady = providers.some((c) => c.found && c.source !== "probed" && c.auth.loggedIn !== false);
    return {
      app: !!r && (r.zoteroApp.installed !== false || r.zoteroLocal.reachable),
      api: !!r?.zoteroLocal.reachable,
      key: !!r?.zoteroKey.canWrite || skippedKey,
      agent: agentReady,
      done: false,
    } as Record<StepId, boolean>;
  }, [report, skippedKey]);

  const firstUndone: StepId = STEPS.find((s) => s.id !== "done" && !done[s.id])?.id ?? "done";
  const step: StepId = chosen ?? firstUndone;

  // Watching: a download finishing, Zotero coming up, a sign-in completing
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void check(waiting === "login" ? undefined : "zotero"); }, 3000);
    return () => clearInterval(timer);
  }, [waiting, check]);
  useEffect(() => {
    if (!waiting || !report) return;
    const arrived =
      waiting === "app" ? report.zoteroApp.installed !== false
      : waiting === "api" ? report.zoteroLocal.reachable
      : done.agent;
    if (arrived) { setWaiting(null); setChosen(null); setMessage({ tone: "ok", text: waiting === "login" ? "Signed in." : waiting === "api" ? "Zotero's library is connected." : "Zotero is installed." }); }
  }, [waiting, report, done.agent]);

  const post = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data } as { ok: boolean; data: Record<string, unknown> };
    } catch {
      return { ok: false, data: { error: "The server didn't respond — it may be reloading. Try again in a moment." } };
    } finally {
      setBusy(null);
    }
  };

  // Saving rewrites .env.local, which restarts the dev server — the first
  // re-check can land mid-restart, so give it a moment.
  const save = async (setting: string, value: string, label: string) => {
    const { ok, data } = await post({ setting, value }, setting);
    if (!ok) { setMessage({ tone: "bad", text: String(data.error || "That didn't save.") }); return; }
    setMessage({ tone: data.warning ? "bad" : "ok", text: String(data.warning || `${label} saved.`) });
    if (setting === "ZOTERO_API_KEY") setKeyInput("");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await check();
  };

  const launchZotero = async () => {
    const { ok, data } = await post({ action: "launch-zotero" }, "launch");
    if (!ok) { setMessage({ tone: "bad", text: String(data.error) }); return; }
    setMessage({ tone: "ok", text: "Zotero is starting…" });
    setWaiting("api");
  };

  const enableApi = async () => {
    setLog([]);
    const { ok, data } = await post({ action: "enable-local-api" }, "enable");
    setLog((data.steps as string[]) ?? []);
    if (!ok) { setMessage({ tone: "bad", text: String(data.problem || data.error) }); await check("zotero"); return; }
    setMessage({ tone: "ok", text: "Zotero's library is connected." });
    await check("zotero");
  };

  const install = async (cli: CliReport) => {
    setLog([]);
    const { ok, data } = await post({ action: "install", cli: cli.id }, `install:${cli.id}`);
    const output = String(data.output || "").split("\n").filter(Boolean);
    setLog(output.slice(-6));
    if (!ok) { setMessage({ tone: "bad", text: String(data.problem || data.error) }); return; }
    // Installed, but likely somewhere the server's PATH doesn't reach
    await post({ action: "adopt-paths" }, "adopt");
    setMessage({ tone: "ok", text: `${cli.label} installed.` });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await check();
  };

  const signIn = async (cli: CliReport) => {
    const { ok, data } = await post({ action: "login", cli: cli.id }, `login:${cli.id}`);
    if (!ok) { setMessage({ tone: "bad", text: String(data.error) }); return; }
    setMessage({
      tone: "ok",
      text: data.opened
        ? "A terminal opened with the sign-in. Finish it in the browser it opens; this page will notice."
        : `Run this in a terminal, then come back: ${String(data.command)}`,
    });
    setWaiting("login");
  };

  const adoptPaths = async () => {
    const { ok, data } = await post({ action: "adopt-paths" }, "adopt");
    if (!ok) { setMessage({ tone: "bad", text: String(data.error) }); return; }
    const adopted = (data.adopted as string[]) ?? [];
    setMessage({ tone: "ok", text: adopted.length ? `Using ${adopted.join(", ")} from where they are installed.` : "Nothing to adopt." });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await check();
  };

  const openUrl = (url: string) => { window.open(url, "_blank", "noopener,noreferrer"); };

  // ── pieces ──
  const dot = (state: "ok" | "warn" | "bad") => (
    <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: `var(--status-${state})` }} />
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
  const hint = (text: React.ReactNode) => <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--ink-faint)" }}>{text}</p>;
  const code = (text: string) => (
    <code className="text-[10px] px-1.5 py-0.5 rounded break-all" style={{ background: "var(--paper)", border: "1px solid var(--border-light)", color: "var(--ink-muted)" }}>{text}</code>
  );
  const Primary = ({ id, onClick, children }: { id: string; onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick} disabled={busy !== null} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40 shrink-0">
      {busy === id ? "Working…" : children}
    </button>
  );
  const Ghost = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick} disabled={busy !== null} className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-40 shrink-0">{children}</button>
  );
  const Steps = () => (
    <ol className="flex items-center gap-1.5 flex-wrap">
      {STEPS.map((s, i) => {
        const state = s.id === step ? "current" : done[s.id] || (s.id === "done" && firstUndone === "done") ? "done" : "todo";
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            <button
              onClick={() => setChosen(s.id)}
              className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded"
              style={{
                color: state === "current" ? "var(--ink)" : state === "done" ? "var(--status-ok)" : "var(--ink-faint)",
                background: state === "current" ? "rgba(230,237,243,0.08)" : "transparent",
              }}
            >
              {state === "done" ? "✓ " : `${i + 1} `}{s.label}
            </button>
            {i < STEPS.length - 1 && <span aria-hidden style={{ color: "var(--ink-faint)" }}>›</span>}
          </li>
        );
      })}
    </ol>
  );
  const Log = () => (log.length > 0 ? (
    <ul className="mt-2 space-y-0.5">
      {log.map((line, i) => <li key={i} className="text-[10px] font-mono break-all" style={{ color: "var(--ink-muted)" }}>{line}</li>)}
    </ul>
  ) : null);

  const r = report;
  const app = r?.zoteroApp;
  const local = r?.zoteroLocal;
  const key = r?.zoteroKey;
  const providers = r?.clis.filter((c) => PROVIDERS.includes(c.id)) ?? [];
  const mcp = r?.clis.find((c) => c.id === "zotero-mcp");
  const probed = r?.clis.filter((c) => c.found && c.source === "probed") ?? [];

  const body = !r ? (
    <p className="text-xs" style={{ color: "var(--ink-faint)" }}>Looking around…</p>
  ) : step === "app" ? (
    <section className="space-y-3">
      <Row state={done.app ? "ok" : "bad"} title={done.app ? `Zotero is installed${app?.version ? ` — ${app.version}` : ""}` : app?.installed === null ? "Couldn't look for Zotero on this system" : "Zotero isn't installed"}>
        {done.app && app?.path && hint(code(app.path))}
        {!done.app && hint(<>The reader reads papers out of your Zotero library. Install Zotero, then come back here — this page notices when it&apos;s there.</>)}
      </Row>
      {!done.app && (
        <div className="flex gap-2 items-center">
          <Primary id="download" onClick={() => { openUrl(app?.downloadUrl ?? "https://www.zotero.org/download/"); setWaiting("app"); setMessage({ tone: "ok", text: "Waiting for the install to finish…" }); }}>Download Zotero</Primary>
          {waiting === "app" && <span className="text-[11px]" style={{ color: "var(--ink-faint)" }}>Watching for it…</span>}
        </div>
      )}
    </section>
  ) : step === "api" ? (
    <section className="space-y-3">
      <Row
        state={local?.reachable ? "ok" : "bad"}
        title={local?.reachable ? "Library connected" : app?.running || local?.runningButApiOff ? "Zotero is running, but its local API is switched off" : "Zotero isn't running"}
      >
        {local?.reachable && hint(<>Listening on {code(local.url)}. Reading the library is read-only.</>)}
        {!local?.reachable && (app?.running || local?.runningButApiOff) && hint(
          <>The reader talks to Zotero through a setting Zotero ships switched off. It can be switched on for you: Zotero quits, the setting is saved in its profile, Zotero starts again. Or do it by hand in Zotero: <strong>Settings → Advanced → Allow other applications on this computer to communicate with Zotero</strong>.</>
        )}
        {!local?.reachable && !app?.running && !local?.runningButApiOff && hint(<>Start Zotero and this page will connect to it.</>)}
      </Row>
      {!local?.reachable && (
        <div className="flex gap-2 items-center flex-wrap">
          {!app?.running && !local?.runningButApiOff && <Primary id="launch" onClick={launchZotero}>Start Zotero</Primary>}
          {(app?.running || local?.runningButApiOff) && <Primary id="enable" onClick={enableApi}>Switch it on for me (restarts Zotero)</Primary>}
          <Ghost onClick={() => { setWaiting("api"); setMessage({ tone: "ok", text: "Watching for Zotero…" }); }}>I&apos;ll do it myself</Ghost>
          {waiting === "api" && <span className="text-[11px]" style={{ color: "var(--ink-faint)" }}>Watching…</span>}
        </div>
      )}
      <Log />
    </section>
  ) : step === "key" ? (
    <section className="space-y-3">
      <Row
        state={key?.canWrite ? "ok" : "warn"}
        title={key?.canWrite ? `Highlights sync to zotero.org${key.username ? ` as ${key.username}` : ""}` : key?.configured ? "The saved zotero.org key has a problem" : "Highlight sync — optional"}
      >
        {key?.problem && hint(key.problem)}
        {!key?.canWrite && hint(
          <>
            Zotero&apos;s local API can read but not write, so highlights you make here reach Zotero through zotero.org. That needs a key from your account
            {r.zoteroPrefs.syncUsername ? <> (Zotero on this machine syncs as <strong>{r.zoteroPrefs.syncUsername}</strong>)</> : null}.
            Create one with <strong>Allow library access</strong> and <strong>Allow write access</strong> ticked, then paste it here. Without it, highlights stay in the session.
          </>
        )}
      </Row>
      {!key?.canWrite && (
        <>
          <div className="flex gap-1.5">
            <input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste the key from zotero.org"
              spellCheck={false}
              className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded focus:outline-none"
              style={{ border: "1px solid var(--border)", background: "var(--paper)", color: "var(--ink)" }}
            />
            <Primary id="ZOTERO_API_KEY" onClick={() => void save("ZOTERO_API_KEY", keyInput.trim(), "Zotero key")}>Save</Primary>
          </div>
          <div className="flex gap-2">
            <Ghost onClick={() => openUrl(r.newKeyUrl)}>Create a key on zotero.org</Ghost>
            <Ghost onClick={() => { setSkippedKey(true); setChosen(null); }}>Skip for now</Ghost>
          </div>
        </>
      )}
    </section>
  ) : step === "agent" ? (
    <section className="space-y-3">
      {hint(<>Answers come from a coding agent already on your machine, signed in to its own account. One is enough.</>)}
      {providers.map((cli) => {
        const signedIn = cli.found && cli.source !== "probed" && cli.auth.loggedIn !== false;
        const state = signedIn ? "ok" : cli.found ? "warn" : "bad";
        const title = !cli.found ? `${cli.label} — not installed`
          : cli.source === "probed" ? `${cli.label} — installed, but the server can't see it`
          : cli.auth.loggedIn === false ? `${cli.label} — installed, not signed in`
          : `${cli.label}${cli.version ? ` — ${cli.version}` : ""}${cli.auth.account ? ` · ${cli.auth.account}` : ""}`;
        return (
          <Row key={cli.id} state={state} title={title}>
            {!cli.found && (
              <div className="flex gap-2 items-center mt-1.5 flex-wrap">
                <Primary id={`install:${cli.id}`} onClick={() => void install(cli)}>Install</Primary>
                {hint(<>runs {code(cli.installer)}</>)}
              </div>
            )}
            {cli.found && cli.source === "probed" && (
              <div className="flex gap-2 items-center mt-1.5 flex-wrap">
                <Primary id="adopt" onClick={adoptPaths}>Use it from {cli.path}</Primary>
              </div>
            )}
            {cli.found && cli.source !== "probed" && cli.auth.loggedIn === false && (
              <div className="flex gap-2 items-center mt-1.5 flex-wrap">
                <Primary id={`login:${cli.id}`} onClick={() => void signIn(cli)}>Sign in</Primary>
                {waiting === "login" && <span className="text-[11px]" style={{ color: "var(--ink-faint)" }}>Watching for the sign-in…</span>}
              </div>
            )}
          </Row>
        );
      })}
      {mcp && (
        <Row state={mcp.found ? "ok" : "warn"} title={mcp.found ? `Zotero MCP${mcp.version ? ` — ${mcp.version}` : ""}` : "Zotero MCP — optional"}>
          {hint(<>Lets the agent search your whole library while it answers.</>)}
          {!mcp.found && (
            <div className="flex gap-2 items-center mt-1.5 flex-wrap">
              <Ghost onClick={() => void install(mcp)}>{busy === "install:zotero-mcp" ? "Installing…" : "Install it"}</Ghost>
              {hint(<>runs {code(mcp.installer)}</>)}
            </div>
          )}
          {mcp.found && mcp.source === "probed" && <div className="mt-1.5"><Ghost onClick={adoptPaths}>Use it from where it is</Ghost></div>}
        </Row>
      )}
      <Log />
    </section>
  ) : (
    <section className="space-y-3">
      <Row state={done.api ? "ok" : "warn"} title={done.api ? "Zotero library connected" : "Zotero library not connected"} />
      <Row state={key?.canWrite ? "ok" : "warn"} title={key?.canWrite ? `Highlights sync as ${key.username ?? "your account"}` : "Highlights stay in the session (no zotero.org key)"} />
      <Row state={done.agent ? "ok" : "bad"} title={done.agent ? `Agent ready: ${providers.filter((c) => c.found && c.source !== "probed" && c.auth.loggedIn !== false).map((c) => c.label).join(", ")}` : "No signed-in agent"} />
      <Row state={mcp?.found ? "ok" : "warn"} title={mcp?.found ? "The agent can search your library" : "Library search for the agent not installed (optional)"} />
      {probed.length > 0 && hint(<>Installed but not yet usable from here: {probed.map((c) => c.label).join(", ")}. <button onClick={adoptPaths} className="underline">Use them</button>.</>)}
      {hint(<>Everything here is checked again whenever you open Setup. Nothing leaves your machine except the zotero.org key check.</>)}
    </section>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] backdrop-blur-sm pr-backdrop" style={{ background: "rgba(1,4,9,0.6)" }} onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl overflow-hidden pr-modal-pop"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-modal)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 space-y-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--ink)", fontFamily: "var(--font-lora), Georgia, serif" }}>
                {firstRun ? "Welcome — let's connect things" : "Setup"}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--ink-faint)" }}>
                {firstRun ? "A few minutes: your Zotero library, then an agent to read with." : "What this reader can reach on your machine right now."}
              </p>
            </div>
            <button onClick={() => void check()} disabled={checking} className="btn-ghost text-xs px-2.5 py-1 shrink-0">
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>
          <Steps />
        </div>

        <div className="px-4 py-4 overflow-y-auto">{body}</div>

        <div className="flex items-center gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border-light)" }}>
          {message && (
            <p className="text-[11px] flex-1 min-w-0" style={{ color: message.tone === "ok" ? "var(--status-ok)" : "var(--status-warn)" }}>{message.text}</p>
          )}
          <div className="ml-auto flex gap-2 shrink-0">
            {step !== "app" && <Ghost onClick={() => setChosen(STEPS[Math.max(0, STEPS.findIndex((s) => s.id === step) - 1)].id)}>Back</Ghost>}
            {step !== "done" ? (
              <Ghost onClick={() => setChosen(STEPS[Math.min(STEPS.length - 1, STEPS.findIndex((s) => s.id === step) + 1)].id)}>{done[step] ? "Next" : "Skip"}</Ghost>
            ) : (
              <button onClick={onClose} className="btn-primary text-xs px-3 py-1.5">{firstRun ? "Start reading" : "Close"}</button>
            )}
            {step !== "done" && <Ghost onClick={onClose}>{firstRun ? "Set up later" : "Close"}</Ghost>}
          </div>
        </div>
      </div>
    </div>
  );
}
