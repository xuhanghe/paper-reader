import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
const run = promisify(execFile);

// The macOS save dialog, for choosing where a file goes
export async function POST(req: Request) {
  if (process.platform !== "darwin") {
    return Response.json({ error: "The native save dialog is currently available on macOS. Enter the path instead." }, { status: 501 });
  }
  const body = await req.json().catch(() => ({}));
  const defaultName = typeof body.defaultName === "string" && body.defaultName.trim() ? body.defaultName.trim() : "conversation.md";
  const location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : "";
  const script = [
    "on run argv",
    "set defaultName to item 1 of argv",
    "set startAt to item 2 of argv",
    'if startAt is "" then',
    '  set chosen to choose file name with prompt "Save the conversation export" default name defaultName',
    "else",
    '  set chosen to choose file name with prompt "Save the conversation export" default name defaultName default location (POSIX file startAt)',
    "end if",
    "return POSIX path of chosen",
    "end run",
  ].join("\n");
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script, defaultName, location]);
    return Response.json({ path: stdout.trim() });
  } catch {
    return Response.json({ cancelled: true }, { status: 499 });
  }
}
