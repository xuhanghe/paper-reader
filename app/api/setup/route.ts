import { access, constants } from "node:fs/promises";
import {
  detectCli, detectZoteroKey, detectZoteroLocal, isWritableSetting, readKeyResponse, saveSetting,
  type CliId, type WritableSetting,
} from "@/lib/doctor";
import {
  cliAuth, currentPlatform, detectZoteroApp, enableLocalApi, findTool, installCli, INSTALLERS, launchZotero,
  loginCommandLine, openTerminalWith, waitUntil, zoteroPrefsReport, zoteroProcessRunning, ZOTERO_NEW_KEY_URL,
} from "@/lib/onboarding";

export const runtime = "nodejs";

const CLIS: CliId[] = ["claude", "codex", "opencode", "zotero-mcp"];
const isCliId = (value: unknown): value is CliId => typeof value === "string" && (CLIS as string[]).includes(value);

// Every check here costs something real: four CLI subprocesses and their
// sign-in checks, a request to Zotero and one to zotero.org. The reader asks
// on each mount to decide whether to show its badge, and switching surfaces
// remounts it — so hold the answer briefly. The Setup assistant passes
// ?fresh=1 to skip this, and ?scope=zotero while it waits on Zotero alone.
type Report = Awaited<ReturnType<typeof buildReport>>;
let cached: { at: number; report: Report } | null = null;
const TTL_MS = 60_000;

async function zoteroPart() {
  const [app, local, prefs] = await Promise.all([detectZoteroApp(), detectZoteroLocal(), zoteroPrefsReport()]);
  return {
    zoteroApp: app,
    zoteroLocal: local,
    zoteroPrefs: { profileFound: prefs.profileFound, localApiEnabled: prefs.localApiEnabled, syncUsername: prefs.syncUsername },
  };
}

async function buildReport() {
  const [zotero, zoteroKey, clis, installers] = await Promise.all([
    zoteroPart(),
    detectZoteroKey(),
    Promise.all(CLIS.map(async (id) => {
      const cli = await detectCli(id);
      // Found and runnable: is anyone signed in? Only a CLI the server can
      // spawn is asked; a probed one is reported as installed-but-unreachable
      const auth = cli.found && cli.source !== "probed" ? await cliAuth(id, cli.path) : { loggedIn: null, account: null };
      return { ...cli, auth, loginCommand: cli.found ? loginCommandLine(cli.path, id) : null, installer: INSTALLERS[id].display };
    })),
    Promise.all((["npm", "uv", "brew"] as const).map(async (tool) => [tool, (await findTool(tool)) !== null] as const)),
  ]);
  // Only the absence of every provider actually stops the reader working
  const anyProvider = clis.some((cli) => cli.id !== "zotero-mcp" && cli.found);
  return {
    platform: currentPlatform(),
    ...zotero,
    zoteroKey,
    newKeyUrl: ZOTERO_NEW_KEY_URL,
    clis,
    anyProvider,
    installers: Object.fromEntries(installers) as Record<"npm" | "uv" | "brew", boolean>,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fresh = url.searchParams.get("fresh") === "1";
  if (url.searchParams.get("scope") === "zotero") {
    // A quick look while the assistant waits for Zotero to come up
    const part = await zoteroPart();
    if (cached) cached = { at: cached.at, report: { ...cached.report, ...part } };
    return Response.json(part);
  }
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) {
    return Response.json(cached.report);
  }
  const report = await buildReport();
  cached = { at: Date.now(), report };
  return Response.json(report);
}

// The assistant's actions. Each one does something on this machine on the
// user's say-so — starts or restarts Zotero, runs an installer, opens a
// terminal — so the request names exactly what to do, and nothing from the
// client is ever passed to a shell.
async function act(action: string, cli: unknown): Promise<Response> {
  if (action === "launch-zotero") {
    const app = await detectZoteroApp();
    if (app.installed === false) return Response.json({ error: "Zotero isn't installed on this machine yet." }, { status: 400 });
    try {
      await launchZotero(app);
    } catch {
      return Response.json({ error: "Zotero couldn't be started from here. Open it yourself, then re-check." }, { status: 500 });
    }
    const running = await waitUntil(() => zoteroProcessRunning(app.platform), 15000);
    cached = null;
    return Response.json({ ok: true, running });
  }

  if (action === "enable-local-api") {
    const result = await enableLocalApi(async () => (await detectZoteroLocal()).reachable);
    cached = null;
    return Response.json(result, { status: result.ok ? 200 : 500 });
  }

  if (action === "install") {
    if (!isCliId(cli)) return Response.json({ error: "Unknown tool." }, { status: 400 });
    const result = await installCli(cli);
    cached = null;
    // The server's PATH may not see where it landed; the next report probes
    // the install locations and offers to adopt the path
    return Response.json(result, { status: result.ok ? 200 : 500 });
  }

  if (action === "login") {
    if (!isCliId(cli)) return Response.json({ error: "Unknown tool." }, { status: 400 });
    const report = await detectCli(cli);
    const command = report.found ? loginCommandLine(report.path, cli) : null;
    if (!command) return Response.json({ error: "That tool isn't installed, or has no sign-in." }, { status: 400 });
    const opened = await openTerminalWith(command);
    cached = null;
    return Response.json({ ok: true, opened, command });
  }

  if (action === "adopt-paths") {
    // Every CLI that is installed but off the server's PATH gets its path
    // saved, in one go, so the providers appear without a click each
    const adopted: string[] = [];
    for (const id of CLIS) {
      const report = await detectCli(id);
      if (report.found && report.source === "probed") {
        await saveSetting(report.envVar as WritableSetting, report.path);
        adopted.push(report.label);
      }
    }
    cached = null;
    return Response.json({ ok: true, adopted });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}

// Applies one setting to .env.local, or runs one action. Values are validated
// here rather than in the UI: this endpoint writes a file, so it does not take
// the client's word for anything. Nothing written is ever echoed back.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { action?: unknown; cli?: unknown; setting?: unknown; value?: unknown };
  if (typeof body.action === "string") return act(body.action, body.cli);

  const { setting, value } = body;
  if (!isWritableSetting(setting) || typeof value !== "string") {
    return Response.json({ error: "Unknown setting." }, { status: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed || /[\n\r]/.test(trimmed)) {
    return Response.json({ error: "That value isn't usable." }, { status: 400 });
  }

  if (setting === "ZOTERO_API_KEY") {
    if (!/^[A-Za-z0-9]{16,64}$/.test(trimmed)) {
      return Response.json(
        { error: "A Zotero key is 24-ish letters and digits. Copy it straight from zotero.org/settings/keys." },
        { status: 400 }
      );
    }
    // Check it before saving, so a typo can't be stored as a working setting
    let report;
    try {
      const res = await fetch(`https://api.zotero.org/keys/${encodeURIComponent(trimmed)}`, {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      report = readKeyResponse(res.status, res.ok ? await res.json().catch(() => null) : null);
    } catch {
      return Response.json({ error: "Couldn't reach zotero.org to verify the key." }, { status: 502 });
    }
    if (!report.valid) return Response.json({ error: report.problem }, { status: 400 });
    await saveSetting(setting, trimmed);
    cached = null;
    // A read-only key is saved but reported, since it half-works
    return Response.json({ ok: true, warning: report.problem, username: report.username });
  }

  // Binary paths: absolute, present, and executable
  if (!trimmed.startsWith("/")) {
    return Response.json({ error: "Give the full path, starting with /." }, { status: 400 });
  }
  try {
    await access(trimmed, constants.X_OK);
  } catch {
    return Response.json({ error: "Nothing executable at that path." }, { status: 400 });
  }
  await saveSetting(setting, trimmed);
  cached = null;
  return Response.json({ ok: true });
}
