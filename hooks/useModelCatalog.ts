"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { CatalogGroup, CatalogModel } from "@/lib/model-catalog";
import { parseModelSpec } from "@/lib/model-spec";

// The models each backend offers (see lib/model-catalog), shared by every
// picker on the page: one request however many pickers are mounted.
//
// Asking costs the server a process per CLI, so the list is fetched once the
// page has settled rather than during its first render, and the server keeps
// the answer for ten minutes — opening a picker then shows it at once.

export type { CatalogGroup, CatalogModel };

type State = {
  groups: CatalogGroup[] | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: State = { groups: null, loading: false, error: null };
let state: State = EMPTY;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const update = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// While Codex updates itself the server asks it again once it is done (see
// lib/codex-update); looking every few seconds until then brings the new
// models in without anyone pressing refresh
const UPDATE_POLL_MS = 5000;
let followUp: ReturnType<typeof setTimeout> | null = null;

const watchUpdates = (groups: CatalogGroup[]) => {
  if (followUp || !groups.some((g) => g.update?.state === "running")) return;
  followUp = setTimeout(() => {
    followUp = null;
    void loadModelCatalog(undefined, true);
  }, UPDATE_POLL_MS);
};

/**
 * Fetches the catalog; `refresh` re-asks every backend, or the one group named.
 * `quiet` looks again without showing it: no spinner, and a failure keeps what is shown.
 */
export function loadModelCatalog(refresh?: true | string, quiet = false): Promise<void> {
  if (inflight && !refresh) return inflight;
  if (!quiet) update({ loading: true, error: null });
  const query = refresh ? `?refresh=${refresh === true ? "1" : encodeURIComponent(refresh)}` : "";
  const run = fetch(`/api/models${query}`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.groups)) throw new Error(data.error || "Could not list the models.");
      // A refresh of one group answers with all of them; keep the order stable
      update(quiet ? { groups: data.groups } : { groups: data.groups, loading: false });
      watchUpdates(data.groups);
    })
    .catch((error) => {
      if (!quiet) update({ loading: false, error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

/** The catalog, fetched once per page in idle time unless `eager`. */
export function useModelCatalog(eager = false) {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  useEffect(() => {
    if (state.groups || inflight) return;
    if (eager) {
      void loadModelCatalog();
      return;
    }
    const idle = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(() => void loadModelCatalog(), { timeout: 4000 })
      : window.setTimeout(() => void loadModelCatalog(), 1500);
    return () => {
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [eager]);
  return { ...snapshot, refresh: loadModelCatalog };
}

/** The group a model spec belongs to: "claude", "codex", "opencode" or "custom:<id>". */
export function groupKeyFor(spec: string): string {
  const parsed = parseModelSpec(spec);
  if (parsed.provider !== "custom") return parsed.provider;
  return parsed.endpointId ? `custom:${parsed.endpointId}` : "custom";
}

/** The catalog's entry for a model spec, when the catalog lists it. */
export function findModel(groups: CatalogGroup[] | null, spec: string): { group: CatalogGroup; model: CatalogModel | null } | null {
  if (!groups) return null;
  const parsed = parseModelSpec(spec);
  const key = groupKeyFor(spec);
  // A bare "custom" is the first saved endpoint, as on the server
  const group = key === "custom" ? groups.find((g) => g.provider === "custom") : groups.find((g) => g.key === key);
  if (!group) return null;
  const id = parsed.provider === "claude" ? parsed.model ?? "default" : parsed.model;
  const model = id ? group.models.find((m) => m.id === id) ?? null : group.models.find((m) => m.isDefault) ?? null;
  return { group, model };
}

/**
 * The effort to keep when moving to `model`: the current one if it takes it,
 * else its own default. No effort chosen stays none — the backend's default.
 */
export function effortForModel(model: CatalogModel | null, current: string | undefined): string | undefined {
  if (!model || model.efforts.length === 0 || !current) return undefined;
  if (model.efforts.includes(current)) return current;
  if (model.defaultEffort) return model.defaultEffort;
  // Claude names no default; "high" is what the reader has always started on
  if (model.efforts.includes("high")) return "high";
  return model.efforts[Math.floor(model.efforts.length / 2)];
}

const EFFORT_NAMES: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" };

/** An effort level as the picker shows it: the backend's word, capitalized. */
export const effortName = (effort: string) => EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
