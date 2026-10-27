// Which backend a model choice runs on.
//
// The client needs the same answer as the server — it keys each paper's saved
// session ids by provider — and lib/providers.ts imports child_process, so it
// can't be pulled into the browser bundle. The one implementation lives in
// lib/model-spec, which is client-safe; this module keeps the import path the
// rest of the app already uses. A model routed to "opencode" on the server but
// keyed as "claude" on the client would resume the wrong conversation.

export { providerIdFor, type ProviderId } from "./model-spec";
