"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type WorkspaceFile = { path: string; name: string; kind: "file" | "directory"; extension?: string; size?: number };

type Listing = { root: string; version: number; files: WorkspaceFile[] };
const NONE: WorkspaceFile[] = [];

/**
 * The workspace folder's entries: read when the workspace changes, and again
 * on `refresh` — after a save, a move, an answer that may have written files.
 * While a fresh read is under way the last listing of the same folder stays
 * on show; another workspace's never does.
 */
export function useWorkspaceFiles(root: string | null, onError: (message: string) => void) {
  const [version, setVersion] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    fetch(`/api/workspaces/files?root=${encodeURIComponent(root)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not read workspace files.");
        if (!cancelled) setListing({ root, version, files: data.files || [] });
      })
      .catch((reason) => {
        if (cancelled) return;
        // Settled all the same: the folder as last read, or nothing
        setListing((last) => ({ root, version, files: last?.root === root ? last.files : NONE }));
        report.current(reason instanceof Error ? reason.message : "Could not read workspace files.");
      });
    return () => {
      cancelled = true;
    };
  }, [root, version]);

  const refresh = useCallback(() => setVersion((count) => count + 1), []);
  const shown = listing?.root === root ? listing : null;
  return { files: shown?.files ?? NONE, loading: !!root && shown?.version !== version, refresh };
}
