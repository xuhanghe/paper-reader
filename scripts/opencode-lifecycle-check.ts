// Lifecycle checks for the headless opencode server. No model calls, so this
// costs nothing to run:  npx tsx scripts/opencode-lifecycle-check.ts
import { execSync } from "node:child_process";
import { ensureServer, shutdown } from "../lib/opencode-server";

const port = process.env.OPENCODE_PORT!;
const count = () => {
  try {
    return execSync(`ps -eo command | grep -c "[o]pencode serve --port ${port}"`).toString().trim();
  } catch {
    return "0";
  }
};
const pid = () => {
  try {
    return execSync(`pgrep -f "opencode serve --port ${port}" | head -1`).toString().trim();
  } catch {
    return "";
  }
};
const ok = (label: string, pass: boolean, detail = "") =>
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);

async function main() {
  if (!port) throw new Error("set OPENCODE_PORT for this check");

  const url1 = await ensureServer();
  const first = pid();
  ok("starts exactly one server", count() === "1", `pid ${first} at ${url1}`);

  const t0 = Date.now();
  const url2 = await ensureServer();
  ok("second call reuses it", pid() === first && url1 === url2, `${Date.now() - t0}ms, still pid ${first}`);

  // Killed out from under us → the next call brings it back
  execSync(`kill ${first}`);
  await new Promise((r) => setTimeout(r, 1200));
  ok("child death is noticed", count() === "0");
  await ensureServer();
  const second = pid();
  ok("restarts after a crash", count() === "1" && second !== first, `new pid ${second}`);

  // Idle shutdown (OPENCODE_IDLE_MS is read at import time)
  const idleMs = Number(process.env.OPENCODE_IDLE_MS) || 0;
  if (idleMs && idleMs <= 10000) {
    await new Promise((r) => setTimeout(r, idleMs + 2500));
    ok(`idle shutdown after ${idleMs}ms`, count() === "0");
  }

  // Adoption: a server we did not start must survive our shutdown
  const adopted = await ensureServer();
  const adoptedPid = pid();
  await shutdown();
  await new Promise((r) => setTimeout(r, 500));
  ok("explicit shutdown stops our own server", count() === "0", `was pid ${adoptedPid} at ${adopted}`);

  execSync(`opencode serve --port ${port} --hostname 127.0.0.1 >/dev/null 2>&1 &`);
  for (let i = 0; i < 40 && count() === "0"; i++) await new Promise((r) => setTimeout(r, 250));
  const foreign = pid();
  await ensureServer();
  ok("adopts a server it did not start", pid() === foreign && count() === "1", `pid ${foreign}`);
  await shutdown();
  await new Promise((r) => setTimeout(r, 800));
  ok("never kills an adopted server", count() === "1" && pid() === foreign);
  execSync(`kill ${foreign}`); // clean up the one this check started
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
