import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { SESSIONS_ROOT } from "@/lib/session-store";

// Where the panel's scroll trace lands: one JSON object per line, appended,
// under the sessions directory so it lives with the rest of the app's data
// and never in the repository. Development only.
const FILE = path.join(SESSIONS_ROOT, "_trace", "panel.jsonl");

function closed() {
  return process.env.NODE_ENV === "production";
}

export async function POST(req: NextRequest) {
  if (closed()) return NextResponse.json({ error: "not available" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const entries: unknown[] = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) return NextResponse.json({ ok: true, wrote: 0 });
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ received: Date.now(), ...(typeof e === "object" && e ? e : { value: e }) })).join("\n") + "\n";
  await fs.appendFile(FILE, lines, "utf8");
  return NextResponse.json({ ok: true, wrote: entries.length });
}

// The tail of the trace, newest last, for reading it back without the file.
export async function GET(req: NextRequest) {
  if (closed()) return NextResponse.json({ error: "not available" }, { status: 404 });
  const limit = Math.max(1, Math.min(5000, Number(req.nextUrl.searchParams.get("limit")) || 500));
  let text = "";
  try {
    text = await fs.readFile(FILE, "utf8");
  } catch {
    return new NextResponse("", { headers: { "Content-Type": "application/x-ndjson" } });
  }
  const lines = text.split("\n").filter(Boolean);
  return new NextResponse(lines.slice(-limit).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
}

export async function DELETE() {
  if (closed()) return NextResponse.json({ error: "not available" }, { status: 404 });
  await fs.rm(FILE, { force: true });
  return NextResponse.json({ ok: true });
}
