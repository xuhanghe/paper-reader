// The custom API config versions before saved endpoints kept in the browser,
// moved once to the server's endpoint list (lib/endpoints), so the key leaves
// localStorage and sessions that still say "custom" find it there.
//
// Client-only.

const LEGACY_KEY = "paper-reader:custom-api";
let started = false;

export function migrateLegacyCustomApi(onMoved?: () => void) {
  if (started || typeof window === "undefined") return;
  started = true;
  let config: Record<string, unknown> | null = null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    config = raw ? JSON.parse(raw) : null;
  } catch {
    return;
  }
  if (!config) return;
  const forget = () => {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // storage unavailable: nothing to clean up then
    }
  };
  if (typeof config.baseUrl !== "string" || typeof config.model !== "string") return forget();
  fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Custom API",
      baseUrl: config.baseUrl,
      apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
      defaultModel: config.model,
      vision: config.vision === true,
      format: config.format === "anthropic" ? "anthropic" : "openai",
      maxTokens: config.maxTokens,
    }),
  })
    .then((res) => {
      if (!res.ok) return;
      forget();
      onMoved?.();
    })
    .catch(() => {
      // Try again on the next load
      started = false;
    });
}
