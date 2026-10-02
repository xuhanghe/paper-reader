import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  INSTALLERS, loginCommandLine, parseClaudeAuth, parseCodexLogin, parseOpencodeAuth, parseProfilesIni, pickProfile,
  PREF_LOCAL_API, readPref, withPrefs, withUserPath, zoteroSupportDir,
} from "../lib/onboarding.js";

// Zotero's profiles.ini, as the desktop app writes it on a Mac
const PROFILES_INI = `[Profile0]
Name=default
IsRelative=1
Path=Profiles/i6qz913a.default
Default=1

[General]
StartWithLastProfile=1
`;

describe("Zotero's profile", () => {
  test("the default profile is read from profiles.ini, and [General] is not a profile", () => {
    const profiles = parseProfilesIni(PROFILES_INI);
    assert.equal(profiles.length, 1);
    assert.deepEqual(profiles[0], { name: "default", path: "Profiles/i6qz913a.default", isRelative: true, isDefault: true });
  });

  test("with several profiles the default wins; with one, that one", () => {
    const two = parseProfilesIni("[Profile0]\nName=old\nPath=a\n[Profile1]\nName=new\nPath=b\nDefault=1\n");
    assert.equal(pickProfile(two)?.name, "new");
    assert.equal(pickProfile(parseProfilesIni("[Profile0]\nName=only\nPath=p\n"))?.name, "only");
    assert.equal(pickProfile([]), null);
  });

  test("the support folder follows the platform", () => {
    assert.equal(zoteroSupportDir("mac", "/Users/ada"), "/Users/ada/Library/Application Support/Zotero");
    assert.equal(zoteroSupportDir("linux", "/home/ada"), "/home/ada/.zotero/zotero");
    assert.equal(zoteroSupportDir("other", "/home/ada"), null);
  });
});

describe("prefs.js", () => {
  const PREFS = `// Mozilla User Preferences
user_pref("extensions.zotero.dataDir", "/Users/ada/Zotero");
user_pref("extensions.zotero.httpServer.localAPI.enabled", false);
user_pref("extensions.zotero.sync.server.username", "ada");
user_pref("extensions.zotero.lastViewedFolder", "C12");
`;

  test("a pref reads back with its type", () => {
    assert.equal(readPref(PREFS, PREF_LOCAL_API), false);
    assert.equal(readPref(PREFS, "extensions.zotero.sync.server.username"), "ada");
    assert.equal(readPref(PREFS, "extensions.zotero.nothing"), null);
  });

  test("switching the local API on replaces the line and leaves the rest untouched", () => {
    const out = withPrefs(PREFS, { [PREF_LOCAL_API]: true });
    assert.equal(readPref(out, PREF_LOCAL_API), true);
    assert.equal(out.split("\n").length, PREFS.split("\n").length);
    assert.ok(out.includes('user_pref("extensions.zotero.lastViewedFolder", "C12");'));
    assert.ok(out.startsWith("// Mozilla User Preferences"));
  });

  test("a pref that was never set is appended as a proper line", () => {
    const out = withPrefs('user_pref("a", 1);', { "extensions.zotero.httpServer.enabled": true });
    assert.equal(out, 'user_pref("a", 1);\nuser_pref("extensions.zotero.httpServer.enabled", true);\n');
    assert.equal(readPref(out, "extensions.zotero.httpServer.enabled"), true);
  });

  test("a string value is quoted and escaped", () => {
    const out = withPrefs("", { "x.y": 'say "hi"' });
    assert.equal(readPref(out, "x.y"), 'say "hi"');
  });
});

describe("whether a coding agent is signed in", () => {
  test("claude reports JSON", () => {
    assert.deepEqual(parseClaudeAuth('{"loggedIn": true, "authMethod": "claude.ai", "email": "ada@example.org"}'), { loggedIn: true, account: "ada@example.org" });
    assert.deepEqual(parseClaudeAuth('{"loggedIn": false}'), { loggedIn: false, account: null });
  });

  test("an older claude speaks prose", () => {
    assert.equal(parseClaudeAuth("Not logged in").loggedIn, false);
    assert.equal(parseClaudeAuth("Logged in as ada@example.org").account, "ada@example.org");
    assert.equal(parseClaudeAuth("").loggedIn, null);
  });

  test("codex says how it is logged in, or that it is not", () => {
    assert.deepEqual(parseCodexLogin("Logged in using ChatGPT\n"), { loggedIn: true, account: "ChatGPT" });
    assert.deepEqual(parseCodexLogin("Not logged in\n"), { loggedIn: false, account: null });
  });

  test("opencode lists a bullet per provider with credentials, in colour", () => {
    const out = "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  OpenCode Zen \x1b[90mapi\n│\n●  OpenRouter \x1b[90mapi\n";
    assert.deepEqual(parseOpencodeAuth(out), { loggedIn: true, account: "OpenCode Zen, OpenRouter" });
    assert.deepEqual(parseOpencodeAuth("┌  Credentials\n│\n└  none\n"), { loggedIn: false, account: null });
  });
});

describe("installing and signing in", () => {
  test("every CLI has an installer, shown as the command a person would type", () => {
    assert.equal(INSTALLERS.claude.display, `npm ${INSTALLERS.claude.args.join(" ")}`);
    assert.equal(INSTALLERS["zotero-mcp"].display, `uv ${INSTALLERS["zotero-mcp"].args.join(" ")}`);
  });

  test("the sign-in command runs the binary the server found, quoted when it needs to be", () => {
    assert.equal(loginCommandLine("/Users/ada/.local/bin/claude", "claude"), "/Users/ada/.local/bin/claude auth login");
    assert.equal(loginCommandLine("/Users/ada/My Tools/codex", "codex"), "'/Users/ada/My Tools/codex' login");
    assert.equal(loginCommandLine("/x/zotero-mcp", "zotero-mcp"), null);
  });

  test("the user's install locations are added to the PATH a GUI-launched server lacks", () => {
    const env = withUserPath({ PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv, "/home/ada");
    const dirs = env.PATH!.split(":");
    assert.equal(dirs[0], "/usr/bin");
    assert.ok(dirs.includes("/home/ada/.local/bin"));
    assert.ok(dirs.includes("/opt/homebrew/bin"));
    assert.equal(new Set(dirs).size, dirs.length);
  });
});
