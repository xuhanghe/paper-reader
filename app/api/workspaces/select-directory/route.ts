import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
const run = promisify(execFile);

export async function POST() {
  if (process.platform !== "darwin") {
    return Response.json({ error: "The native folder picker is currently available on macOS. Enter the absolute path instead." }, { status: 501 });
  }
  try {
    const { stdout } = await run("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose or create the folder for this research workspace")',
    ]);
    return Response.json({ root: stdout.trim().replace(/\/$/, "") });
  } catch {
    return Response.json({ cancelled: true }, { status: 499 });
  }
}
