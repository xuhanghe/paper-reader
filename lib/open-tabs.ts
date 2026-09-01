// The Reader's open papers. One instance of the shared tab-store mechanism;
// the Workspace makes its own over its own key, so the two behave identically
// while keeping separate contents.

import type { MaterialTab } from "@/components/MaterialTabs";
import { createTabStore, upsertTab } from "@/lib/tab-store";

export const OPEN_TABS_KEY = "paper-reader:open-tabs";

// A tab with no name has nothing to render
const store = createTabStore<MaterialTab>(
  OPEN_TABS_KEY,
  (entry) => !!(entry as MaterialTab | null)?.id && !!(entry as MaterialTab | null)?.name
);

export const loadOpenTabs = store.load;
export const saveOpenTabs = store.save;
export const subscribeOpenTabs = store.subscribe;
export const upsertOpenTab = upsertTab<MaterialTab>;
