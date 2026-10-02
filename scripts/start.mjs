#!/usr/bin/env node
// The launcher behind ./start and start.cmd, once a Node.js is known to exist:
// installs the dependencies when they are missing or the lockfile has moved
// on, starts the dev server, and opens the browser on the first URL the
// server prints — the next free port when 3000 is taken. PORT fixes the port;
// PAPER_READER_NO_OPEN keeps the browser closed (servers, tests).
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: windows });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`))));
  });
}

// ── Dependencies ──────────────────────────────────────────────────────────
const lock = join(root, "package-lock.json");
const installed = join(root, "node_modules", ".package-lock.json");
const stale = !existsSync(installed) || (existsSync(lock) && statSync(lock).mtimeMs > statSync(installed).mtimeMs);
if (stale) {
  console.log("Installing dependencies (first run; a minute or two)…");
  try {
    await run(npm, ["install", "--no-fund", "--no-audit"]);
  } catch (error) {
    console.error(`\nThe install didn't finish (${error.message}). Fix what it printed above, then run the launcher again.`);
    process.exit(1);
  }
}

// ── Server, then the browser ──────────────────────────────────────────────
function openUrl(url) {
  if (process.env.PAPER_READER_NO_OPEN) return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : windows ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
  opener.on("error", () => console.log(`Open ${url} in your browser.`));
  opener.unref();
}

const args = ["run", "dev"];
if (process.env.PORT) args.push("--", "-p", process.env.PORT);
console.log("Starting Paper Reader… (Ctrl-C stops it)");
const server = spawn(npm, args, { stdio: ["inherit", "pipe", "pipe"], shell: windows });

let opened = false;
const relay = (stream, out) => {
  stream.on("data", (chunk) => {
    out.write(chunk);
    if (opened) return;
    const match = String(chunk).match(/http:\/\/localhost:\d+/);
    if (match) {
      opened = true;
      setTimeout(() => openUrl(match[0]), 1000);
    }
  });
};
relay(server.stdout, process.stdout);
relay(server.stderr, process.stderr);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { server.kill(signal); });
}
server.on("error", (error) => {
  console.error(`Couldn't start the server: ${error.message}`);
  process.exit(1);
});
server.on("exit", (code) => process.exit(code ?? 0));
