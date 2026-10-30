import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runningServer, zoteroCandidates, zoteroLaunch } from "../scripts/launcher.mjs";

// What the launcher behind ./start, start.cmd and the Windows shortcut
// decides before starting anything: is the reader already up, and where is
// Zotero and how is it started.

describe("the reader already running", () => {
  const withLock = (lock: unknown, check: (root: string) => void) => {
    const root = mkdtempSync(path.join(tmpdir(), "launcher-"));
    try {
      if (lock !== undefined) {
        mkdirSync(path.join(root, ".next", "dev"), { recursive: true });
        writeFileSync(path.join(root, ".next", "dev", "lock"), typeof lock === "string" ? lock : JSON.stringify(lock));
      }
      check(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("its dev server's lock, with a live process, gives the URL to open", () => {
    withLock({ pid: 4242, port: 3001, appUrl: "http://localhost:3001" }, (root) => {
      assert.equal(runningServer(root, (pid: number) => pid === 4242), "http://localhost:3001");
    });
  });

  test("a lock left by a server that is gone, a broken lock, or none: start one", () => {
    withLock({ pid: 4242, appUrl: "http://localhost:3000" }, (root) => assert.equal(runningServer(root, () => false), null));
    withLock("{not json", (root) => assert.equal(runningServer(root, () => true), null));
    withLock(undefined, (root) => assert.equal(runningServer(root, () => true), null));
  });

  test("this very process counts as alive by default", () => {
    withLock({ pid: process.pid, appUrl: "http://localhost:3000" }, (root) => assert.equal(runningServer(root), "http://localhost:3000"));
  });
});

describe("Zotero", () => {
  test("on Windows, where its installer puts it", () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    assert.deepEqual(zoteroCandidates("win32", env, "C:\\Users\\me"), [
      path.join("C:\\Program Files", "Zotero", "zotero.exe"),
      path.join("C:\\Program Files (x86)", "Zotero", "zotero.exe"),
      path.join("C:\\Users\\me\\AppData\\Local", "Zotero", "zotero.exe"),
    ]);
    assert.deepEqual(zoteroLaunch("C:\\Program Files\\Zotero\\zotero.exe", "win32"), ["C:\\Program Files\\Zotero\\zotero.exe", []]);
  });

  test("on macOS, the app, started behind the browser", () => {
    assert.deepEqual(zoteroCandidates("darwin", {}, "/Users/me"), ["/Applications/Zotero.app", "/Users/me/Applications/Zotero.app"]);
    assert.deepEqual(zoteroLaunch("/Applications/Zotero.app", "darwin"), ["open", ["-g", "-a", "/Applications/Zotero.app"]]);
  });

  test("elsewhere it is left to the setup assistant", () => {
    assert.deepEqual(zoteroCandidates("linux", {}, "/home/me"), []);
  });
});
