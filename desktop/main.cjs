// The reader as an app: a window around the same Next.js server the browser
// version runs, started here on a free port. Packaged, the server is the
// standalone build shipped inside the app; with --dev it is whatever `npm run
// dev` is serving, so the app can be used while the code is still changing.
//
// Two things a GUI app does not get for free are supplied here: the PATH of
// the reader's login shell, without which `claude` and `codex` are not found,
// and a data folder of the reader's choosing, since the app's own folder is
// read-only and replaced on update.
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const DEV = process.argv.includes("--dev");
const DEV_URL = process.env.PAPER_READER_DEV_URL || "http://localhost:3000";
const SCREENSHOT = (() => { const i = process.argv.indexOf("--screenshot"); return i >= 0 ? process.argv[i + 1] : null; })();

const configFile = () => path.join(app.getPath("userData"), "config.json");
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return {}; } };
const writeConfig = (c) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 2)); };

// The data folder: chosen once, kept in the app's own config; until chosen,
// a folder in Application Support
const dataHome = () => {
  const chosen = readConfig().home;
  if (chosen && fs.existsSync(chosen)) return chosen;
  const fallback = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
};

// The login shell's PATH — Homebrew, nvm, ~/.local/bin and the rest
const shellPath = () => {
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(sh, ["-ilc", 'echo -n "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (out && out.includes("/")) return out.trim();
  } catch { /* fall through */ }
  return [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")].filter(Boolean).join(":");
};

// KEY=value lines of the data folder's .env.local, for the server's environment
const dotenv = (home) => {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(home, ".env.local"), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* no .env.local is fine */ }
  return env;
};

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

const waitFor = (url, ms = 30000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const probe = () => {
    fetch(url, { method: "HEAD" }).then(() => resolve()).catch(() => {
      if (Date.now() - started > ms) reject(new Error(`no answer from ${url}`));
      else setTimeout(probe, 250);
    });
  };
  probe();
});

let server = null;
let win = null;

async function startServer(home) {
  const port = await freePort();
  const serverDir = path.join(process.resourcesPath, "standalone");
  const env = {
    ...process.env,
    ...dotenv(home),
    PATH: shellPath(),
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    PAPER_READER_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
  };
  server = spawn(process.execPath, [path.join(serverDir, "server.js")], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  server.on("exit", (code) => { server = null; if (code !== 0 && code !== null && win) dialog.showErrorBox("Paper Reader", `The server stopped (exit ${code}). See the log for why.`); });
  const url = `http://127.0.0.1:${port}/`;
  await waitFor(url);
  return url;
}

function stopServer() {
  if (server) { server.kill("SIGTERM"); server = null; }
}

async function chooseHome() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose the folder the reader keeps its sessions in",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: dataHome(),
  });
  if (canceled || !filePaths[0]) return;
  writeConfig({ ...readConfig(), home: filePaths[0] });
  const { response } = await dialog.showMessageBox(win, { message: "Data folder changed", detail: `The reader will use ${filePaths[0]} after a restart.`, buttons: ["Restart now", "Later"] });
  if (response === 0) { app.relaunch(); app.exit(0); }
}

function menu() {
  const template = [
    { role: "appMenu", submenu: [
      { role: "about" }, { type: "separator" },
      { label: "Data Folder…", click: chooseHome },
      { label: "Reveal Data Folder", click: () => shell.openPath(dataHome()) },
      { type: "separator" }, { role: "quit" },
    ] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function open() {
  menu();
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    title: "Paper Reader",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links the answers recommend open in the reader's browser, not in here
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.once("ready-to-show", () => win.show());
  try {
    const url = DEV ? DEV_URL : await startServer(dataHome());
    await win.loadURL(url);
  } catch (err) {
    dialog.showErrorBox("Paper Reader could not start", String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  if (SCREENSHOT) {
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(SCREENSHOT, image.toPNG());
      app.quit();
    }, 6000);
  }
}

app.whenReady().then(open);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", stopServer);
