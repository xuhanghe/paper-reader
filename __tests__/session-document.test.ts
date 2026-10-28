import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirFor, patchSessionHighlights, readState, writeState } from "../lib/session-store.js";

// A local paper's document — megabytes of PDF — is kept beside its state, not
// inside it: written when it arrives, kept by every save that leaves it out,
// and read only by whoever asks for it.

const LOCAL = "__session-document-local__";
const OLD = "__session-document-old__";
const ZOTERO = "__session-document-zotero__";
after(() => Promise.all([LOCAL, OLD, ZOTERO].map((id) => rm(dirFor(id), { recursive: true, force: true }))));

const DOC = "data:application/pdf;base64," + "JVBERi0xLjcK".repeat(1000);
const stateFile = async (id: string) => JSON.parse(await readFile(path.join(dirFor(id), "state.json"), "utf8"));
const hasDocumentFile = (id: string) => stat(path.join(dirFor(id), "document.dataurl")).then(() => true, () => false);

describe("a local paper's document", () => {
  test("is written beside the state, and read only when asked for", async () => {
    await writeState(LOCAL, { pdfName: "Local.pdf", pdfDataUrl: DOC, annotations: [{ id: "a1" }], highlights: [] });
    assert.equal((await stateFile(LOCAL)).pdfDataUrl, "");
    assert.equal(await hasDocumentFile(LOCAL), true);
    assert.equal((await readState(LOCAL))?.pdfDataUrl, undefined, "the conversation alone by default");
    assert.equal((await readState(LOCAL, undefined, { document: true }))?.pdfDataUrl, DOC);
  });

  test("is kept by a save that leaves it out", async () => {
    await writeState(LOCAL, { pdfName: "Local.pdf", pdfDataUrl: "", annotations: [{ id: "a1" }, { id: "a2" }], highlights: [] });
    const state = await readState(LOCAL, undefined, { document: true });
    assert.equal(state?.pdfDataUrl, DOC);
    assert.equal((state?.annotations as unknown[]).length, 2);
  });

  test("saved inside the state before, moves out on the next save", async () => {
    await mkdir(dirFor(OLD), { recursive: true });
    await writeFile(path.join(dirFor(OLD), "state.json"), JSON.stringify({ pdfName: "Old.pdf", pdfDataUrl: DOC, annotations: [] }));
    assert.equal((await readState(OLD, undefined, { document: true }))?.pdfDataUrl, DOC, "still read where it was");
    await writeState(OLD, { pdfName: "Old.pdf", pdfDataUrl: "", annotations: [{ id: "new" }] });
    assert.equal((await stateFile(OLD)).pdfDataUrl, "");
    assert.equal((await readState(OLD, undefined, { document: true }))?.pdfDataUrl, DOC);
  });

  test("survives the Workspace writing highlights into the session", async () => {
    assert.equal(await patchSessionHighlights(LOCAL, [{ id: "h1", text: "a mark", createdAt: 1 }]), "updated");
    const state = await readState(LOCAL, undefined, { document: true });
    assert.equal(state?.pdfDataUrl, DOC);
    assert.equal((state?.highlights as unknown[]).length, 1);
  });

  test("a paper in Zotero keeps none", async () => {
    await writeState(ZOTERO, { pdfName: "Z.pdf", pdfDataUrl: "", zoteroKey: "ZKEY", annotations: [] });
    assert.equal(await hasDocumentFile(ZOTERO), false);
    assert.equal((await readState(ZOTERO, undefined, { document: true }))?.pdfDataUrl, "");
  });
});
