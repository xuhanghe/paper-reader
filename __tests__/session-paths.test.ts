import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, readdir } from "node:fs/promises";
import { dirFor, sessionRelativeFile, writeFigureImage, figuresDirFor } from "../lib/session-store.js";

// Anything written into a session directory outlives the checkout it was made
// in: the user can move or rename the project, and the thread has to keep
// working. An absolute path stored in thread.jsonl would break, and would also
// carry the user's home directory into prompts sent to third-party endpoints.

const ID = "__path-test__";
after(() => rm(dirFor(ID), { recursive: true, force: true }));

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

describe("writeFigureImage", () => {
  test("returns a session-relative reference, not an absolute path", async () => {
    const ref = await writeFigureImage(ID, PNG);
    assert.ok(ref, "expected a reference");
    assert.equal(path.isAbsolute(ref), false, `got an absolute path: ${ref}`);
    assert.match(ref, /^figures\/fig-[\d-]+\.png$/);
  });

  test("several figures written at once each get a file of their own", async () => {
    const refs = await Promise.all([writeFigureImage(ID, PNG), writeFigureImage(ID, PNG), writeFigureImage(ID, PNG)]);
    assert.equal(new Set(refs).size, 3, `names collided: ${refs.join(", ")}`);
    const written = await readdir(figuresDirFor(ID));
    for (const ref of refs) assert.ok(written.includes(path.basename(ref!)));
  });

  test("a JPEG keeps its bytes", async () => {
    const ref = (await writeFigureImage(ID, "data:image/jpeg;base64,/9j/4AAQ"))!;
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(path.join(dirFor(ID), ref))).toString("base64"), "/9j/4AAQ");
  });

  test("the reference resolves to the file it just wrote", async () => {
    const ref = (await writeFigureImage(ID, PNG))!;
    const written = await readdir(figuresDirFor(ID));
    assert.ok(written.includes(path.basename(ref)));
    assert.equal(path.join(dirFor(ID), ref), path.join(figuresDirFor(ID), path.basename(ref)));
  });
});

describe("sessionRelativeFile", () => {
  test("passes a relative reference through unchanged", () => {
    assert.equal(sessionRelativeFile(ID, "figures/fig-1.png"), "figures/fig-1.png");
  });

  test("rewrites an absolute reference from an older thread", () => {
    const absolute = path.join(dirFor(ID), "figures", "fig-1.png");
    assert.equal(sessionRelativeFile(ID, absolute), path.join("figures", "fig-1.png"));
  });

  test("never leaks a home directory into a replayed prompt", () => {
    const absolute = path.join(dirFor(ID), "figures", "fig-1.png");
    assert.equal(sessionRelativeFile(ID, absolute).includes(path.sep + "Users" + path.sep), false);
    assert.equal(path.isAbsolute(sessionRelativeFile(ID, absolute)), false);
  });
});
