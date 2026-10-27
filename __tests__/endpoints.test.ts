import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// The data folder is fixed when lib/home loads, so it is pointed at a
// temporary directory first. Each test file runs in its own process.
let home = "";
let endpoints: typeof import("../lib/endpoints.js");
let providers: typeof import("../lib/providers.js");
before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "paper-reader-endpoints-"));
  process.env.PAPER_READER_HOME = home;
  const load = createRequire(__filename);
  endpoints = load("../lib/endpoints");
  providers = load("../lib/providers");
});
after(() => rm(home, { recursive: true, force: true }));

describe("what makes an endpoint", () => {
  test("a base URL and a model are required; the name defaults to the host", () => {
    assert.match(String((endpoints.validateEndpointInput({ defaultModel: "m" }, null) as { error: string }).error), /base URL/);
    assert.match(String((endpoints.validateEndpointInput({ baseUrl: "https://x.example", defaultModel: "" }, null) as { error: string }).error), /model/);
    assert.match(String((endpoints.validateEndpointInput({ baseUrl: "ftp://x.example", defaultModel: "m" }, null) as { error: string }).error), /base URL/);
    const ok = endpoints.validateEndpointInput({ baseUrl: "https://openrouter.ai/api/v1/", defaultModel: "openai/gpt-5" }, null, 1, () => "ep_x");
    assert.ok("endpoint" in ok);
    assert.equal(ok.endpoint.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(ok.endpoint.name, "openrouter.ai");
    assert.equal(ok.endpoint.format, "openai");
  });

  test("editing without typing a key keeps the saved one; an empty key removes it", () => {
    const first = endpoints.validateEndpointInput({ baseUrl: "https://a.example", defaultModel: "m", apiKey: "sk-secret-123456" }, null, 1, () => "ep_a");
    assert.ok("endpoint" in first);
    const kept = endpoints.validateEndpointInput({ name: "Renamed" }, first.endpoint, 2);
    assert.ok("endpoint" in kept);
    assert.equal(kept.endpoint.apiKey, "sk-secret-123456");
    assert.equal(kept.endpoint.id, "ep_a");
    const cleared = endpoints.validateEndpointInput({ apiKey: "" }, first.endpoint, 3);
    assert.ok("endpoint" in cleared);
    assert.equal(cleared.endpoint.apiKey, "");
  });
});

describe("the saved list", () => {
  test("is written owner-only, never shows its keys to the browser, and can be removed from", async () => {
    const saved = await endpoints.saveEndpoint({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-abcdefgh1234", defaultModel: "openai/gpt-5", vision: true, preset: "openrouter" });
    const file = path.join(home, ".paper-reader-endpoints.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /sk-or-abcdefgh1234/);

    const summary = endpoints.summarizeEndpoint(saved);
    assert.equal("apiKey" in summary, false);
    assert.equal(summary.hasKey, true);
    assert.equal(summary.keyHint, "…1234");

    // The same service added again (a migration run twice) updates instead of duplicating
    await endpoints.saveEndpoint({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-5", vision: false });
    const all = await endpoints.listEndpoints();
    assert.equal(all.length, 1);
    assert.equal(all[0].apiKey, "sk-or-abcdefgh1234");
    assert.equal(all[0].vision, false);

    assert.equal(await endpoints.deleteEndpoint(saved.id), true);
    assert.equal((await endpoints.listEndpoints()).length, 0);
    assert.equal(await endpoints.deleteEndpoint(saved.id), false);
  });

  test("a question names an endpoint by id and gets its key and model on the server", async () => {
    const ep = await endpoints.saveEndpoint({ name: "Local", baseUrl: "http://localhost:11434/v1", defaultModel: "llama3:8b", format: "openai" });
    assert.deepEqual(await providers.customConfigFor(`custom:${ep.id}`), { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3:8b", vision: false, format: "openai" });
    assert.equal((await providers.customConfigFor(`custom:${ep.id}:qwen3:14b`))?.model, "qwen3:14b");
    // A bare "custom", as sessions saved before, runs on the first saved endpoint …
    assert.equal((await providers.customConfigFor("custom"))?.model, "llama3:8b");
    // … unless the browser still sends the config it used to keep
    assert.equal((await providers.customConfigFor("custom", { baseUrl: "https://old.example", model: "old" }))?.baseUrl, "https://old.example");
    assert.equal(await providers.customConfigFor("custom:ep_missing"), null);
    assert.equal(await providers.customConfigFor("claude:opus"), null);
  });
});
