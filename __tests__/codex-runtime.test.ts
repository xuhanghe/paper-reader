import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeCodexSessionId,
  encodeCodexSessionId,
  paperReaderCodexHome,
  prepareCodexEnvironment,
} from "../lib/codex-runtime.js";

describe("Paper Reader Codex runtime", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("uses an app-owned home rather than the desktop Codex home", () => {
    assert.equal(
      paperReaderCodexHome({ NODE_ENV: "test" }, "darwin", "/Users/ada"),
      "/Users/ada/Library/Application Support/Paper Reader/codex"
    );
  });

  test("isolates mutable state while reusing documented auth and skills", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paper-reader-codex-home-"));
    cleanups.push(root);
    const source = path.join(root, "shared");
    const runtime = path.join(root, "runtime");
    await mkdir(path.join(source, "skills"), { recursive: true });
    await writeFile(path.join(source, "auth.json"), "test credential placeholder");

    const childEnv = prepareCodexEnvironment({
      NODE_ENV: "test",
      CODEX_HOME: source,
      PAPER_READER_CODEX_HOME: runtime,
    }, "darwin", root);

    assert.equal(childEnv.CODEX_HOME, runtime);
    assert.equal(await readlink(path.join(runtime, "auth.json")), path.join(source, "auth.json"));
    assert.equal(await readlink(path.join(runtime, "skills")), path.join(source, "skills"));
    assert.equal(await readFile(path.join(runtime, "auth.json"), "utf8"), "test credential placeholder");
    assert.equal(existsSync(path.join(runtime, "models_cache.json")), false);
  });

  test("only resumes sessions created in the isolated runtime", () => {
    const raw = "019c1234-1234-7000-8000-123456789abc";
    assert.equal(decodeCodexSessionId(encodeCodexSessionId(raw)), raw);
    assert.equal(decodeCodexSessionId(raw), undefined);
    assert.equal(decodeCodexSessionId("paper-reader-codex-v1:"), undefined);
  });
});
