import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { dirFor, patchSessionHighlights, readState, writeState } from "../lib/session-store.js";

// The Workspace marks a paper the Reader also reads. Its highlights go into
// the paper's own session, so the Reader shows them; nothing else in the
// session is the Workspace's to touch.

const KNOWN = "__ws-highlights-known__";
const NEW = "__ws-highlights-new__";
const LOCAL = "__ws-highlights-local__";
after(() => Promise.all([KNOWN, NEW, LOCAL].map((id) => rm(dirFor(id), { recursive: true, force: true }))));

const mark = (id: string, text: string) => ({ id, text, createdAt: 1 });

describe("highlights written from the workspace", () => {
  test("land in an existing session and leave the rest of it alone", async () => {
    await writeState(KNOWN, { pdfName: "Known.pdf", pdfDataUrl: "", zoteroKey: "K1", annotations: [{ id: "a1" }], concepts: [{ annotationId: "a1" }], highlights: [mark("old", "earlier")], model: "m" });
    assert.equal(await patchSessionHighlights(KNOWN, [mark("old", "earlier"), mark("h2", "a new one")]), "updated");
    const state = await readState(KNOWN);
    assert.deepEqual((state?.highlights as { id: string }[]).map((h) => h.id), ["old", "h2"]);
    assert.deepEqual(state?.annotations, [{ id: "a1" }], "the conversation cards are untouched");
    assert.deepEqual(state?.concepts, [{ annotationId: "a1" }]);
  });

  test("a Zotero paper never opened in the Reader gets a session the Reader can open", async () => {
    assert.equal(await patchSessionHighlights(NEW, [mark("h1", "first")], { pdfName: "New.pdf", zoteroKey: "Z9", zoteroAttachmentKey: "ATT9" }), "created");
    // Read as the Reader opens it, document and all: there is none to read
    const state = await readState(NEW, undefined, { document: true });
    assert.equal(state?.zoteroKey, "Z9");
    assert.equal(state?.zoteroAttachmentKey, "ATT9");
    assert.equal(state?.pdfDataUrl, "", "the Reader fetches the PDF by key, as for its own Zotero sessions");
    assert.deepEqual(state?.annotations, []);
    assert.deepEqual((state?.highlights as { id: string }[]).map((h) => h.id), ["h1"]);
  });

  test("a local paper with no session cannot be seeded: its PDF lives only in its session", async () => {
    assert.equal(await patchSessionHighlights(LOCAL, [mark("h1", "first")], { pdfName: "Local.pdf" }), "missing");
    assert.equal(await readState(LOCAL), null);
  });
});
