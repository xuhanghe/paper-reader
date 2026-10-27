"use client";
import { useEffect, useRef, useState } from "react";
import type { EndpointSummary } from "@/lib/endpoints";
import { ENDPOINT_PRESETS, presetById, type EndpointPreset } from "@/lib/endpoint-presets";
import styles from "./agent-picker.module.css";

type Props = {
  // An endpoint to edit, or null to add one
  initial: EndpointSummary | null;
  onClose: () => void;
  onSaved: (endpoint: EndpointSummary) => void;
};

type Listed = { id: string; label: string; vision?: boolean };
type Check = { ok: boolean; text: string } | null;

// Adding or editing a custom endpoint. A preset fills in where a known service
// answers; "Check connection" asks the endpoint for its models with what has
// been typed, before anything is saved, so a wrong URL or key shows up here
// rather than as a failed question later. The key goes to the server and is
// never sent back.
export function EndpointDialog({ initial, onClose, onSaved }: Props) {
  const [preset, setPreset] = useState<string | undefined>(initial?.preset ?? (initial ? undefined : "openai"));
  const [name, setName] = useState(initial?.name ?? "OpenAI");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? presetById("openai")!.baseUrl);
  const [format, setFormat] = useState<"openai" | "anthropic">(initial?.format ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.defaultModel ?? "");
  const [vision, setVision] = useState(initial?.vision ?? false);
  const [maxTokens, setMaxTokens] = useState(initial?.maxTokens ? String(initial.maxTokens) : "");
  const [listed, setListed] = useState<Listed[]>([]);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Check>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameTouched = useRef(!!initial);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choosePreset = (p: EndpointPreset) => {
    setPreset(p.id);
    setFormat(p.format);
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    if (!nameTouched.current) setName(p.id === "other" ? "" : p.name);
    setListed([]);
    setCheck(null);
  };

  const connect = async () => {
    setChecking(true);
    setCheck(null);
    try {
      const res = await fetch("/api/endpoints/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: initial?.id, baseUrl, format, apiKey, model, vision }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCheck({ ok: false, text: data.error || "The endpoint did not answer." });
        return;
      }
      const models: Listed[] = data.models ?? [];
      setListed(models);
      if (models.length && !models.some((m) => m.id === model)) setModel(models[0].id);
      const chosen = models.find((m) => m.id === (model || models[0]?.id));
      if (chosen?.vision !== undefined) setVision(chosen.vision);
      setCheck({
        ok: true,
        text: models.length
          ? `Connected · ${models.length} model${models.length === 1 ? "" : "s"} · ${data.ms} ms`
          : `Connected · the model answered in ${data.ms} ms`,
      });
    } catch {
      setCheck({ ok: false, text: "Could not reach Paper Reader's server." });
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/endpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: initial?.id,
          name,
          preset,
          format,
          baseUrl,
          // Typed: replaces the saved key. Left empty while editing: keeps it
          ...(apiKey || !initial ? { apiKey } : {}),
          defaultModel: model,
          vision,
          maxTokens: maxTokens ? Number(maxTokens) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save the endpoint.");
      onSaved(data.endpoint as EndpointSummary);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the endpoint.");
    } finally {
      setSaving(false);
    }
  };

  const current = presetById(preset);
  const keyPlaceholder = initial?.hasKey ? `Saved (${initial.keyHint}) — leave empty to keep it` : current?.local ? "Usually not needed for a local server" : "Paste the API key";

  return (
    <div className={`${styles.backdrop} pr-backdrop`} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`${styles.dialog} pr-modal-pop`} role="dialog" aria-modal="true" aria-labelledby="endpoint-dialog-title">
        <header className={styles.dialogHead}>
          <h2 id="endpoint-dialog-title">{initial ? `Edit ${initial.name}` : "Add a custom endpoint"}</h2>
          <p>Any service that speaks the OpenAI chat format, or Anthropic&apos;s Messages API. Its key is kept on this computer, by Paper Reader&apos;s server.</p>
        </header>

        <div className={styles.dialogBody}>
          <div className={styles.presets} role="group" aria-label="Service">
            {ENDPOINT_PRESETS.map((p) => (
              <button key={p.id} type="button" className={styles.preset} aria-pressed={preset === p.id} onClick={() => choosePreset(p)}>
                {p.name}
              </button>
            ))}
          </div>

          <div className={styles.row}>
            <label className={styles.field}>
              <span>Name</span>
              <input ref={firstField} className={styles.input} value={name} onChange={(e) => { nameTouched.current = true; setName(e.target.value); }} placeholder="e.g. OpenRouter" />
            </label>
            <label className={styles.field} style={{ flex: "0 0 168px" }}>
              <span>Format</span>
              <select className={styles.input} value={format} onChange={(e) => setFormat(e.target.value as "openai" | "anthropic")}>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
          </div>

          <label className={styles.field}>
            <span>Base URL<small>{format === "anthropic" ? "…/v1/messages is added" : "…/chat/completions is added"}</small></span>
            <input className={styles.input} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setCheck(null); }} placeholder="https://api.example.com/v1" spellCheck={false} />
          </label>

          <label className={styles.field}>
            <span>API key{current?.keyUrl ? <a href={current.keyUrl} target="_blank" rel="noreferrer">Get a key ↗</a> : null}</span>
            <input className={styles.input} type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setCheck(null); }} placeholder={keyPlaceholder} autoComplete="off" spellCheck={false} />
          </label>

          <div className={styles.result} aria-live="polite" data-ok={check ? String(check.ok) : undefined}>
            <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={connect} disabled={checking || !baseUrl.trim()}>
              {checking ? "Checking…" : listed.length ? "Check again" : "Check connection & load models"}
            </button>
            {check && <span>{check.ok ? "✓" : "!"} {check.text}</span>}
          </div>

          <label className={styles.field}>
            <span>Model<small>{listed.length ? "choose from the list, or type an id" : "type its id, or load the list above"}</small></span>
            <input className={styles.input} list="endpoint-models" value={model} onChange={(e) => {
              setModel(e.target.value);
              const known = listed.find((m) => m.id === e.target.value);
              if (known?.vision !== undefined) setVision(known.vision);
            }} placeholder={format === "anthropic" ? "e.g. claude-sonnet-4-5" : "e.g. gpt-5.2, llama3.3:70b"} spellCheck={false} />
            <datalist id="endpoint-models">
              {listed.map((m) => <option key={m.id} value={m.id}>{m.label !== m.id ? m.label : undefined}</option>)}
            </datalist>
          </label>

          {format === "anthropic" && (
            <label className={styles.field}>
              <span>Max tokens<small>Anthropic requires one; empty means 8192</small></span>
              <input className={styles.input} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ""))} placeholder="8192" />
            </label>
          )}

          <label className={styles.check}>
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
            <span>The model reads images: captured figures and page snapshots are sent with questions. Leave off for text-only models.</span>
          </label>
        </div>

        <footer className={styles.dialogFoot}>
          {error ? <span className={`${styles.error} ${styles.grow}`}>{error}</span> : <span className={styles.grow} />}
          <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary text-xs px-4 py-1.5 disabled:opacity-40" onClick={save} disabled={saving || !baseUrl.trim() || !model.trim()}>
            {saving ? "Saving…" : initial ? "Save" : "Add endpoint"}
          </button>
        </footer>
      </section>
    </div>
  );
}
