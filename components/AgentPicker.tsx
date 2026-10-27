"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { effortForModel, effortName, findModel, groupKeyFor, loadModelCatalog, useModelCatalog, type CatalogGroup, type CatalogModel } from "@/hooks/useModelCatalog";
import { modelSpec, parseModelSpec, type ProviderId } from "@/lib/model-spec";
import type { EndpointSummary } from "@/lib/endpoints";
import { EndpointDialog } from "./EndpointDialog";
import styles from "./agent-picker.module.css";

type Props = {
  // The model spec (lib/model-spec) and effort currently chosen
  value: string;
  effort?: string;
  onChange: (spec: string, effort: string | undefined) => void;
  // What this choice is for, read out with the button: "Model for questions"
  label?: string;
};

const TINT: Record<ProviderId, string> = { claude: "#D97757", codex: "#AEB7BF", opencode: "#7EA6F0", custom: "#E1C369" };

function ProviderMark({ provider }: { provider: ProviderId }) {
  const paths: Record<ProviderId, ReactNode> = {
    // A spark, a prompt, a pair of brackets, a plug
    claude: <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />,
    codex: <path d="M2.5 4.5 6 8l-3.5 3.5M8 12h5.5" />,
    opencode: <path d="M5.5 2.5C3.5 2.5 4 7 2 8c2 1 1.5 5.5 3.5 5.5M10.5 2.5c2 0 1.5 4.5 3.5 5.5-2 1-1.5 5.5-3.5 5.5" />,
    custom: <path d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3" />,
  };
  return (
    <span className={styles.mark} style={{ "--mark": TINT[provider] } as CSSProperties} aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[provider]}</svg>
    </span>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const REFRESH = "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3";
const PENCIL = "M10.5 2.5l3 3-8 8H2.5v-3z";
const TRASH = "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9";

/** The words a model goes by, from the catalog when it lists it, else from the spec itself. */
function describe(value: string, groups: CatalogGroup[] | null) {
  const parsed = parseModelSpec(value);
  const found = findModel(groups, value);
  const group = found?.group ?? null;
  const model = found?.model ?? null;
  const fallback = parsed.model
    ? parsed.model
    : parsed.provider === "claude" ? "Claude default"
    : parsed.provider === "custom" ? group?.label ?? "Custom API"
    : `${parsed.provider === "codex" ? "Codex" : "OpenCode"} default`;
  return { provider: parsed.provider, group, model, name: model?.label ?? fallback };
}

export function AgentPicker({ value, effort, onChange, label = "Model" }: Props) {
  const { groups, loading, error } = useModelCatalog();
  const [open, setOpen] = useState(false);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [dialog, setDialog] = useState<EndpointSummary | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const current = describe(value, groups);
  const shownEffort = current.model ? effortForModel(current.model, effort) : current.provider === "custom" ? undefined : effort;
  const selectedKey = current.group?.key ?? groupKeyFor(value);
  const view = groups?.find((g) => g.key === (viewKey ?? selectedKey)) ?? groups?.find((g) => g.key === selectedKey) ?? groups?.[0] ?? null;
  const unhealthy = current.group && current.group.status !== "ready";

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(600, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom;
    const top = below >= 360 || below >= rect.top ? rect.bottom + 6 : Math.max(8, rect.top - 6 - Math.min(560, rect.top - 14));
    setPosition({ top, left, width });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setConfirmRemove(false);
    setTyped("");
    triggerRef.current?.focus();
  }, []);

  const openPicker = () => {
    place();
    setViewKey(null);
    setOpen(true);
    // Opened before the idle fetch ran: ask now
    if (!groups && !loading) void loadModelCatalog();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open || dialog) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, dialog, close]);

  // Focus the chosen model, or the first control, when the panel opens
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target = popoverRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? popoverRef.current?.querySelector<HTMLElement>("button");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const choose = (model: CatalogModel) => onChange(model.spec, effortForModel(model, effort));

  const applyTyped = () => {
    const id = typed.trim();
    if (!id || !view) return;
    const spec = modelSpec(view.provider, id, view.endpoint?.id);
    // A model the backend didn't list: its efforts are unknown, so keep the
    // current one where the CLI takes one at all
    onChange(spec, view.provider === "claude" || view.provider === "codex" ? effort : undefined);
    setTyped("");
  };

  const removeEndpoint = async (endpoint: EndpointSummary) => {
    await fetch(`/api/endpoints?id=${encodeURIComponent(endpoint.id)}`, { method: "DELETE" }).catch(() => {});
    setConfirmRemove(false);
    await loadModelCatalog();
    // A choice that pointed at it moves to Claude, which every install has
    if (groupKeyFor(value) === `custom:${endpoint.id}`) onChange("claude:sonnet", "high");
    setViewKey(null);
  };

  const endpointSaved = async (endpoint: EndpointSummary, added: boolean) => {
    setDialog(null);
    await loadModelCatalog(`custom:${endpoint.id}`);
    setViewKey(`custom:${endpoint.id}`);
    // A new endpoint is added to be used
    if (added) onChange(modelSpec("custom", endpoint.defaultModel, endpoint.id), undefined);
  };

  const providerGroups = groups?.filter((g) => g.provider !== "custom") ?? [];
  const endpointGroups = groups?.filter((g) => g.provider === "custom") ?? [];

  const statusText = (g: CatalogGroup) =>
    g.status === "missing" ? "Not installed" : g.status === "error" && g.provider !== "custom" ? "Problem" : g.status === "error" ? "Unreachable" : "";

  const modelsPane = () => {
    if (!view) {
      return loading || !groups
        ? <div aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className={styles.skeleton} />)}</div>
        : <div className={styles.notice} data-tone="error"><strong>Could not list the models</strong>{error}</div>;
    }
    const chosen = findModel(groups, value);
    return (
      <>
        <div className={styles.modelsHead}>
          <ProviderMark provider={view.provider} />
          <strong>{view.label}</strong>
          <small>{view.status === "ready" ? `${view.models.length} model${view.models.length === 1 ? "" : "s"}` : ""}</small>
          <span className={styles.headActions}>
            {view.endpoint && (
              <>
                <button type="button" className={styles.iconButton} onClick={() => setDialog(view.endpoint!)} title={`Edit ${view.label}`} aria-label={`Edit ${view.label}`}><Icon d={PENCIL} /></button>
                <button type="button" className={styles.iconButton} onClick={() => setConfirmRemove(true)} title={`Remove ${view.label}`} aria-label={`Remove ${view.label}`}><Icon d={TRASH} /></button>
              </>
            )}
            <button type="button" className={`${styles.iconButton} ${loading ? styles.spinning : ""}`} onClick={() => void loadModelCatalog(view.key)} disabled={loading} title={`Ask ${view.label} for its models again`} aria-label={`Refresh ${view.label}`}><Icon d={REFRESH} /></button>
          </span>
        </div>

        {confirmRemove && view.endpoint && (
          <div className={styles.notice} data-tone="error">
            <strong>Remove {view.label}?</strong>
            Its key is deleted from this computer. Conversations already had with it stay.
            <div className={styles.noticeActions}>
              <button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => setConfirmRemove(false)}>Keep</button>
              <button type="button" className="btn-primary text-xs px-3 py-1" onClick={() => void removeEndpoint(view.endpoint!)}>Remove</button>
            </div>
          </div>
        )}

        {view.status === "missing" && (
          <div className={styles.notice}>
            <strong>{view.label} isn&apos;t installed on this computer</strong>
            Install it, sign in, then check again.
            {view.install && <code>{view.install}</code>}
            <div className={styles.noticeActions}><button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => void loadModelCatalog(view.key)}>Check again</button></div>
          </div>
        )}
        {view.status === "error" && (
          <div className={styles.notice} data-tone="error">
            <strong>{view.provider === "custom" ? "Its model list could not be read" : `${view.label} did not list its models`}</strong>
            {view.detail}
            <div className={styles.noticeActions}><button type="button" className="btn-ghost text-xs px-3 py-1" onClick={() => void loadModelCatalog(view.key)}>Try again</button></div>
          </div>
        )}

        {view.models.length > 0 && (
          <div className={styles.modelList} role="radiogroup" aria-label={`${view.label} models`}>
            {view.models.map((m) => {
              const selected = chosen?.group.key === view.key && chosen.model?.id === m.id;
              return (
                <button key={m.spec} type="button" role="radio" aria-checked={selected} className={styles.model} onClick={() => choose(m)} title={m.description}>
                  <span className={styles.radio} aria-hidden="true" />
                  <span className={styles.modelText}>
                    <strong>{m.label}</strong>
                    {(m.description || m.label !== m.id) && <small>{m.description && m.description !== m.label ? m.description : m.id}</small>}
                  </span>
                  {m.isDefault && <span className={styles.tag}>Default</span>}
                </button>
              );
            })}
          </div>
        )}
        {view.status !== "missing" && (
          <form className={styles.other} onSubmit={(e) => { e.preventDefault(); applyTyped(); }}>
            <input className={styles.input} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={view.provider === "opencode" ? "Other model: provider/model" : "Other model id…"} spellCheck={false} aria-label="Use another model id" />
            <button type="submit" className="btn-ghost text-xs px-3" disabled={!typed.trim()}>Use</button>
          </form>
        )}
      </>
    );
  };

  const effortBar = () => {
    const model = findModel(groups, value)?.model ?? null;
    if (!model) {
      return <span className={styles.effortNote}>{groups ? "Effort options show for models the backend lists." : "Loading…"}</span>;
    }
    if (!model.efforts.length) return <span className={styles.effortNote}>{model.label} has no effort setting.</span>;
    const active = effortForModel(model, effort);
    return (
      <span className={styles.segmented} role="radiogroup" aria-label="Effort">
        {model.efforts.map((e) => (
          <button key={e} type="button" role="radio" aria-checked={active === e} onClick={() => onChange(value, e)}>{effortName(e)}</button>
        ))}
      </span>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => (open ? close() : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${current.group?.label ?? current.provider}, ${current.name}${shownEffort ? `, effort ${effortName(shownEffort)}` : ""}`}
        title={`${current.group?.label ?? current.provider} · ${current.name}${shownEffort ? ` · ${effortName(shownEffort)} effort` : ""}${unhealthy ? ` — ${current.group?.detail ?? "not ready"}` : ""}`}
      >
        <ProviderMark provider={current.provider} />
        <span className={styles.triggerName}>{current.name}</span>
        {shownEffort && <span className={styles.triggerEffort}>{effortName(shownEffort)}</span>}
        {unhealthy && <span className={styles.warnDot} aria-hidden="true" />}
        <svg className={styles.chevron} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>

      {open && position && createPortal(
        <div ref={popoverRef} className={styles.popover} style={{ top: position.top, left: position.left, width: position.width }} role="dialog" aria-label={label}>
          <div className={styles.head}>
            <div>
              <h2>{label}</h2>
              <p>Models and effort levels as each backend reports them</p>
            </div>
            <span className={styles.headActions}>
              <button type="button" className={`${styles.iconButton} ${loading ? styles.spinning : ""}`} onClick={() => void loadModelCatalog(true)} disabled={loading} title="Ask every backend again" aria-label="Refresh all"><Icon d={REFRESH} /></button>
            </span>
          </div>
          <div className={styles.body}>
            <nav className={styles.providers} aria-label="Providers">
              <p className={styles.sectionLabel}>Agents</p>
              {!groups && [0, 1, 2].map((i) => <div key={i} className={styles.skeleton} style={{ height: 26 }} />)}
              {providerGroups.map((g) => (
                <button key={g.key} type="button" className={styles.provider} aria-current={view?.key === g.key} onClick={() => { setViewKey(g.key); setConfirmRemove(false); }}>
                  <ProviderMark provider={g.provider} />
                  <span className={styles.providerName}>
                    {g.label}
                    {g.status !== "ready" && <small className={styles.status} data-status={g.status}>{statusText(g)}</small>}
                  </span>
                  {g.key === selectedKey && <span className={styles.inUse} title="In use" />}
                </button>
              ))}
              <p className={styles.sectionLabel}>Custom endpoints</p>
              {endpointGroups.map((g) => (
                <button key={g.key} type="button" className={styles.provider} aria-current={view?.key === g.key} onClick={() => { setViewKey(g.key); setConfirmRemove(false); }}>
                  <ProviderMark provider="custom" />
                  <span className={styles.providerName}>
                    {g.label}
                    {g.status !== "ready" && <small className={styles.status} data-status={g.status}>{statusText(g)}</small>}
                  </span>
                  {g.key === selectedKey && <span className={styles.inUse} title="In use" />}
                </button>
              ))}
              <button type="button" className={styles.addEndpoint} onClick={() => setDialog("new")}>
                <span aria-hidden="true">＋</span> Add endpoint
              </button>
            </nav>
            <div className={styles.models}>{modelsPane()}</div>
          </div>
          <div className={styles.effort}>
            <span className={styles.effortLabel}>Effort</span>
            {effortBar()}
          </div>
        </div>,
        document.body
      )}

      {dialog && (
        <EndpointDialog
          initial={dialog === "new" ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={(endpoint) => void endpointSaved(endpoint, dialog === "new")}
        />
      )}
    </>
  );
}
