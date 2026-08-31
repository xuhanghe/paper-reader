import { access, constants } from "node:fs/promises";
import {
  detectCli, detectZoteroKey, detectZoteroLocal, isWritableSetting, readKeyResponse, saveSetting,
  type CliId,
} from "@/lib/doctor";

export const runtime = "nodejs";

const CLIS: CliId[] = ["claude", "codex", "opencode", "zotero-mcp"];

export async function GET() {
  const [zoteroLocal, zoteroKey, ...clis] = await Promise.all([
    detectZoteroLocal(),
    detectZoteroKey(),
    ...CLIS.map((id) => detectCli(id)),
  ]);
  // Only the absence of every provider actually stops the reader working
  const anyProvider = clis.some((cli) => cli.id !== "zotero-mcp" && cli.found);
  return Response.json({ zoteroLocal, zoteroKey, clis, anyProvider });
}

// Applies one setting to .env.local. Values are validated here rather than in
// the UI: this endpoint writes a file, so it does not take the client's word
// for anything. Nothing written is ever echoed back.
export async function POST(req: Request) {
  const { setting, value } = await req.json().catch(() => ({ setting: null, value: null }));
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
  return Response.json({ ok: true });
}
