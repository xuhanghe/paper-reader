import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  createCodexUpdater,
  parseVersion,
  selfUpdatable,
  updateEnvironment,
  type UpdaterDeps,
} from "../lib/codex-update.js";

const STANDALONE = "/Users/ada/.codex/packages/standalone/releases/0.146.0-aarch64-apple-darwin/bin/codex";
const CHATGPT = "/Applications/ChatGPT.app/Contents/Resources/codex";

describe("reading Codex versions", () => {
  test("the version in a --version line, pre-release kept", () => {
    assert.equal(parseVersion("codex-cli 0.165.0"), "0.165.0");
    assert.equal(parseVersion("codex-cli 0.155.0-alpha.16.4"), "0.155.0-alpha.16.4");
    assert.equal(parseVersion("0.165.0"), "0.165.0");
    assert.equal(parseVersion("codex-cli"), undefined);
    assert.equal(parseVersion(null), undefined);
  });

  test("semver order: numbers compare as numbers, a pre-release comes before its release", () => {
    assert.equal(compareVersions("0.165.0", "0.146.0"), 1);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("0.165.0", "0.165.0"), 0);
    assert.equal(compareVersions("0.164.0-alpha.11.1", "0.164.0"), -1);
    assert.equal(compareVersions("0.164.0", "0.164.0-alpha.11.1"), 1);
    assert.equal(compareVersions("0.164.0-alpha.10", "0.164.0-alpha.9"), 1);
    assert.equal(compareVersions("1.0.0", "0.999.0"), 1);
  });
});

describe("which installs update themselves", () => {
  test("the standalone installer, a global npm/bun/pnpm package and a Homebrew cask do", () => {
    assert.equal(selfUpdatable(STANDALONE), true);
    assert.equal(selfUpdatable("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"), true);
    assert.equal(selfUpdatable("/Users/ada/.bun/install/global/node_modules/@openai/codex/bin/codex.js"), true);
    assert.equal(selfUpdatable("/Users/ada/Library/pnpm/global/5/.pnpm/@openai+codex@0.146.0/node_modules/@openai/codex/bin/codex.js"), true);
    assert.equal(selfUpdatable("/opt/homebrew/Caskroom/codex/0.146.0/codex-aarch64-apple-darwin"), true);
    assert.equal(selfUpdatable("C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"), true);
  });

  test("a copy that came with another app does not", () => {
    assert.equal(selfUpdatable(CHATGPT), false);
    assert.equal(selfUpdatable("/Users/ada/.vscode/extensions/openai.chatgpt-26.1021.22027-darwin-arm64/bin/macos-aarch64/codex"), false);
    assert.equal(selfUpdatable("/Users/ada/.cargo/bin/codex"), false);
  });

  test("the update runs in the user's own environment, without what `npm run` adds", () => {
    const env = updateEnvironment({ PATH: "/usr/bin", HOME: "/Users/ada", CODEX_HOME: "/Users/ada/.codex", npm_config_prefix: "/project", npm_lifecycle_event: "dev", NPM_CONFIG_GLOBAL: "true" });
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/ada", CODEX_HOME: "/Users/ada/.codex" });
  });
});

describe("keeping Codex current", () => {
  type Fake = UpdaterDeps & { calls: { latest: number; runUpdate: string[] }; clock: number; finish: (error?: Error) => void; installed: string };

  type Options = { latest?: string | undefined; resolved?: string; env?: Record<string, string>; runUpdate?: UpdaterDeps["runUpdate"] };

  function fake(overrides: Options = {}): Fake {
    let finish: (error?: Error) => void = () => {};
    const f: Fake = {
      calls: { latest: 0, runUpdate: [] },
      clock: 1_000_000,
      installed: "codex-cli 0.146.0",
      finish: (error) => finish(error),
      latest: async () => {
        f.calls.latest++;
        return "latest" in overrides ? (overrides.latest as string | undefined) : "0.165.0";
      },
      resolve: async () => overrides.resolved ?? STANDALONE,
      runUpdate: overrides.runUpdate ?? ((bin) => {
        f.calls.runUpdate.push(bin);
        return new Promise<void>((resolve, reject) => {
          finish = (error) => {
            if (error) return reject(error);
            f.installed = "codex-cli 0.165.0";
            resolve();
          };
        });
      }),
      versionOf: async () => f.installed,
      env: () => overrides.env ?? {},
      now: () => f.clock,
    };
    return f;
  }
  const cli = { path: "/Users/ada/.local/bin/codex", version: "codex-cli 0.146.0" };

  test("an up-to-date Codex is left alone", async () => {
    const deps = fake();
    const updater = createCodexUpdater(deps);
    await updater.keepCurrent({ ...cli, version: "codex-cli 0.165.0" }, () => assert.fail("nothing to update"));
    assert.equal(updater.status(), undefined);
    assert.deepEqual(deps.calls.runUpdate, []);
  });

  test("an outdated Codex that updates itself is updated in the background, once, then asked again", async () => {
    const deps = fake();
    const updater = createCodexUpdater(deps);
    let updated = 0;
    await updater.keepCurrent(cli, () => updated++);
    // Not waited for: the models are listed while it runs
    assert.deepEqual(updater.status(), { state: "running", from: "0.146.0", to: "0.165.0", updatable: true });
    await updater.keepCurrent(cli, () => updated++);
    assert.deepEqual(deps.calls.runUpdate, [cli.path]);

    deps.finish();
    await updater.running();
    assert.equal(updater.status(), undefined);
    assert.equal(updated, 1);

    // The new build is current
    await updater.keepCurrent({ ...cli, version: deps.installed }, () => updated++);
    assert.deepEqual(deps.calls.runUpdate, [cli.path]);
  });

  test("the copy inside ChatGPT.app is never updated, only reported", async () => {
    const deps = fake({ resolved: CHATGPT });
    const updater = createCodexUpdater(deps);
    await updater.keepCurrent({ path: CHATGPT, version: "codex-cli 0.155.0-alpha.16.4" }, () => {});
    assert.equal(updater.status()?.state, "outdated");
    assert.equal(updater.status()?.updatable, false);
    assert.deepEqual(deps.calls.runUpdate, []);
  });

  test("PAPER_READER_CODEX_AUTO_UPDATE=0 reports instead of updating", async () => {
    const deps = fake({ env: { PAPER_READER_CODEX_AUTO_UPDATE: "0" } });
    const updater = createCodexUpdater(deps);
    await updater.keepCurrent(cli, () => {});
    assert.deepEqual({ ...updater.status(), detail: undefined }, { state: "outdated", from: "0.146.0", to: "0.165.0", updatable: true, detail: undefined });
    assert.deepEqual(deps.calls.runUpdate, []);
  });

  test("a failed update is reported, not retried for hours, but retried when asked", async () => {
    const deps = fake();
    const updater = createCodexUpdater(deps);
    let updated = 0;
    await updater.keepCurrent(cli, () => updated++);
    deps.finish(new Error("curl: (6) Could not resolve host: chatgpt.com"));
    await updater.running();
    assert.equal(updated, 1);
    assert.deepEqual(updater.status(), { state: "failed", from: "0.146.0", to: "0.165.0", updatable: true, detail: "curl: (6) Could not resolve host: chatgpt.com" });

    deps.clock += 60 * 60_000;
    await updater.keepCurrent(cli, () => updated++);
    assert.equal(deps.calls.runUpdate.length, 1);
    assert.equal(updater.status()?.state, "failed");

    await updater.keepCurrent(cli, () => updated++, true);
    assert.equal(deps.calls.runUpdate.length, 2);
    deps.finish();
    await updater.running();

    // Six hours on, an automatic check tries again by itself
    const later = fake();
    const again = createCodexUpdater(later);
    await again.keepCurrent(cli, () => {});
    later.finish(new Error("no"));
    await again.running();
    later.clock += 7 * 60 * 60_000;
    await again.keepCurrent(cli, () => {});
    assert.equal(later.calls.runUpdate.length, 2);
  });

  test("an update after which Codex still reports the old version counts as failed", async () => {
    const deps = fake({ runUpdate: async () => {} });
    const updater = createCodexUpdater(deps);
    await updater.keepCurrent(cli, () => {});
    await updater.running();
    assert.equal(updater.status()?.state, "failed");
    assert.match(updater.status()?.detail ?? "", /still reports 0\.146\.0/);
  });

  test("no answer about the newest release means nothing is done", async () => {
    const deps = fake({ latest: undefined });
    const updater = createCodexUpdater(deps);
    await updater.keepCurrent(cli, () => {});
    assert.equal(updater.status(), undefined);
    assert.deepEqual(deps.calls.runUpdate, []);
  });

  test("the newest release is looked up at most every half hour, unless someone asks", async () => {
    const deps = fake();
    const updater = createCodexUpdater(deps);
    const current = { ...cli, version: "codex-cli 0.165.0" };
    await updater.keepCurrent(current, () => {});
    await updater.keepCurrent(current, () => {});
    assert.equal(deps.calls.latest, 1);
    await updater.keepCurrent(current, () => {}, true);
    assert.equal(deps.calls.latest, 2);
    deps.clock += 31 * 60_000;
    await updater.keepCurrent(current, () => {});
    assert.equal(deps.calls.latest, 3);
  });
});
