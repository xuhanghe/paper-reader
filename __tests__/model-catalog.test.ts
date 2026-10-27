import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as catalog from "../lib/model-catalog.js";
import type { CatalogGroup } from "../lib/model-catalog.js";

const known: CatalogGroup = {
  key: "claude",
  provider: "claude",
  label: "Claude Code",
  status: "ready",
  fetchedAt: Date.now(),
  models: [
    { spec: "claude:opus", id: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { spec: "claude:claude-haiku-4-5-20251001", id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] },
  ],
};
const codexKnown: CatalogGroup = {
  key: "codex",
  provider: "codex",
  label: "Codex",
  status: "ready",
  fetchedAt: Date.now(),
  models: [{ spec: "codex:gpt-5.2-codex", id: "gpt-5.2-codex", label: "GPT-5.2 Codex", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", isDefault: true }],
};
// The catalog keeps its cache on globalThis, so what it "knows" is seeded
// there, and effort checks are tested without starting anything
before(() => {
  const holder = (globalThis as { __paperReaderCatalog?: { groups: Map<string, CatalogGroup> } }).__paperReaderCatalog!;
  holder.groups.set("claude", known);
  holder.groups.set("codex", codexKnown);
});

describe("parsing what each backend says it has", () => {
  test("Claude Code: every model with the effort levels it accepts, and none for one that takes none", () => {
    const models = catalog.parseClaudeModels([
      { value: "default", displayName: "Default (recommended)", description: "Fable 5.1", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "haiku", displayName: "Haiku 5.5", supportsEffort: true, supportedEffortLevels: ["low", "high", "bogus"] },
      { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", supportsThinkingOff: true },
      { value: "--evil", displayName: "x" },
    ]);
    assert.deepEqual(models.map((m) => m.spec), ["claude:default", "claude:haiku", "claude:claude-haiku-4-5-20251001"]);
    assert.equal(models[0].isDefault, true);
    assert.deepEqual(models[1].efforts, ["low", "high"]);
    assert.deepEqual(models[2].efforts, []);
  });

  test("Codex: models with their reasoning efforts, default effort, default model and image input", () => {
    const models = catalog.parseCodexModels([
      { id: "gpt-5.2-codex", model: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "xhigh", description: "" }], defaultReasoningEffort: "low", isDefault: true, inputModalities: ["text", "image"] },
      { id: "internal", model: "internal", hidden: true },
      { id: "gpt-5.2-codex", model: "gpt-5.2-codex" },
    ]);
    assert.equal(models.length, 1);
    assert.deepEqual(models[0], { spec: "codex:gpt-5.2-codex", id: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: undefined, efforts: ["low", "xhigh"], defaultEffort: "low", isDefault: true, vision: true });
  });

  test("OpenCode, as /config/providers answers: variants are the efforts", () => {
    const models = catalog.parseOpencodeProviders({
      providers: [{ id: "anthropic", name: "Anthropic", models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", attachment: true, variants: { high: {}, max: {} } } } }],
      default: { anthropic: "claude-sonnet-4-5" },
    });
    assert.deepEqual(models, [{ spec: "opencode:anthropic/claude-sonnet-4-5", id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", description: "Anthropic", efforts: ["high", "max"], isDefault: true, vision: true }]);
  });

  test("OpenCode, as /provider answers: only connected providers, capabilities nested", () => {
    const models = catalog.parseOpencodeProviders({
      all: [
        { id: "openai", name: "OpenAI", models: [{ id: "gpt-5", name: "GPT-5", capabilities: { input: ["text", "image"] }, variants: ["low", "high"] }] },
        { id: "groq", name: "Groq", models: { llama: { name: "Llama" } } },
      ],
      connected: ["openai"],
      default: {},
    });
    assert.deepEqual(models.map((m) => [m.spec, m.efforts, m.vision]), [["opencode:openai/gpt-5", ["low", "high"], true]]);
  });

  test("an OpenAI-format list: chat models only, newest first", () => {
    const models = catalog.parseEndpointModels({ data: [
      { id: "gpt-4.1", created: 100 },
      { id: "text-embedding-3-small", created: 300 },
      { id: "gpt-5.2", created: 200 },
      { id: "whisper-1", created: 50 },
    ] }, { id: "ep_1", vision: false });
    assert.deepEqual(models.map((m) => m.spec), ["custom:ep_1:gpt-5.2", "custom:ep_1:gpt-4.1"]);
  });

  test("OpenRouter's list says which models see images and take reasoning effort", () => {
    const [m] = catalog.parseEndpointModels({ data: [{ id: "openai/gpt-5", name: "OpenAI: GPT-5", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["reasoning", "tools"] }] }, { id: "ep_or", vision: false });
    assert.equal(m.label, "OpenAI: GPT-5");
    assert.equal(m.vision, true);
    assert.deepEqual(m.efforts, ["low", "medium", "high"]);
  });

  test("Anthropic's list, and the request each format needs", () => {
    const [m] = catalog.parseEndpointModels({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" }], has_more: false }, { id: "ep_a", vision: true });
    assert.equal(m.label, "Claude Sonnet 4.5");
    assert.equal(m.vision, true);
    assert.deepEqual(catalog.endpointModelsRequest({ baseUrl: "https://api.anthropic.com", apiKey: "k", format: "anthropic" }), {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "anthropic-version": "2023-06-01", "x-api-key": "k" },
    });
    assert.equal(catalog.endpointModelsRequest({ baseUrl: "https://proxy.example/v1", apiKey: "", format: "anthropic" }).url, "https://proxy.example/v1/models?limit=1000");
    assert.deepEqual(catalog.endpointModelsRequest({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk", format: "openai" }), {
      url: "https://openrouter.ai/api/v1/models",
      headers: { Authorization: "Bearer sk" },
    });
  });
});

describe("the effort actually sent", () => {
  test("a Claude model gets an effort it accepts, and none when it takes none", () => {
    assert.equal(catalog.effortFor("claude:opus", "max"), "max");
    assert.equal(catalog.effortFor("claude:claude-haiku-4-5-20251001", "high"), undefined);
    assert.equal(catalog.effortFor("claude:opus", "minimal"), undefined);
  });

  test("a Codex model falls back to its own default for an effort it doesn't take", () => {
    assert.equal(catalog.effortFor("codex:gpt-5.2-codex", "xhigh"), "xhigh");
    assert.equal(catalog.effortFor("codex:gpt-5.2-codex", "max"), "xhigh"); // saved as "max" before Codex named its levels
    assert.equal(catalog.effortFor("codex:gpt-5.2-codex", "minimal"), "medium");
    assert.equal(catalog.effortFor("codex", "high"), "high"); // the default model, as the catalog says
  });

  test("OpenCode without a catalog keeps the mapping saved sessions relied on", () => {
    assert.equal(catalog.effortFor("opencode", "low"), "minimal");
    assert.equal(catalog.effortFor("opencode", "medium"), undefined);
    assert.equal(catalog.effortFor("opencode", "max"), "max");
  });

  test("nothing that isn't an effort name is ever sent", () => {
    assert.equal(catalog.effortFor("claude:opus", "--max"), undefined);
    assert.equal(catalog.effortFor("codex", undefined), undefined);
  });
});

describe("asking the CLIs", () => {
  let dir = "";
  const saved = { CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN, PAPER_READER_CODEX_HOME: process.env.PAPER_READER_CODEX_HOME };

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paper-reader-catalog-"));
    // A stand-in claude: answers the SDK initialize control request, as the real CLI does
    const claude = path.join(dir, "claude");
    await writeFile(claude, `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "control_request" && msg.request.subtype === "initialize") {
      process.stdout.write(JSON.stringify({ type: "system", subtype: "status" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { models: [{ value: "opus", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "max"] }] } } }) + "\\n");
    }
  }
  buf = "";
});
process.stdin.on("end", () => process.exit(0));
`);
    // A stand-in codex app-server: refuses model/list until initialized, pages its answer
    const codex = path.join(dir, "codex");
    await writeFile(codex, `#!/usr/bin/env node
if (process.argv[2] !== "app-server") process.exit(2);
let ready = false, tail = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => {
  const lines = (tail + d).split("\\n"); tail = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake/" + msg.params.clientInfo.name } });
    else if (msg.method === "initialized") ready = true;
    else if (msg.method === "model/list") {
      if (!ready) send({ id: msg.id, error: { code: -32600, message: "Not initialized" } });
      else if (!msg.params.cursor) send({ id: msg.id, result: { data: [{ id: "a", model: "gpt-a", displayName: "A", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", isDefault: true }], nextCursor: "page2" } });
      else send({ id: msg.id, result: { data: [{ id: "b", model: "gpt-b", displayName: "B", supportedReasoningEfforts: [] }], nextCursor: null } });
    }
  }
});
`);
    await chmod(claude, 0o755);
    await chmod(codex, 0o755);
    process.env.CLAUDE_BIN = claude;
    process.env.CODEX_BIN = codex;
    process.env.PAPER_READER_CODEX_HOME = path.join(dir, "codex-home");
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("Claude Code lists its models through the initialize request, without asking a model anything", async () => {
    const models = catalog.parseClaudeModels(await catalog.probeClaudeModels());
    assert.deepEqual(models.map((m) => [m.spec, m.efforts]), [["claude:opus", ["low", "max"]]]);
  });

  test("Codex lists every page of its models, after the initialize handshake", async () => {
    const models = catalog.parseCodexModels(await catalog.probeCodexModels());
    assert.deepEqual(models.map((m) => [m.spec, m.efforts, m.isDefault]), [["codex:gpt-a", ["low"], true], ["codex:gpt-b", [], false]]);
  });
});
