import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The system's own dialogs for the Workspace — the folder it works in, where
// an export goes — and the system's own bin for a folder it lets go of.
// macOS asks through osascript, Windows through PowerShell (WinForms and the
// Recycle Bin). What a dialog is given travels as arguments or environment,
// never spliced into the script. Elsewhere there is no dialog, and the path
// is typed instead.

export type Run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultRun: Run = (file, args, options) => execFileAsync(file, args, options);

/** This system has no such dialog: the path is typed instead. */
export class NoNativeDialog extends Error {}

type Options = { platform?: NodeJS.Platform; run?: Run };

const OSASCRIPT = "/usr/bin/osascript";
const POWERSHELL = "powershell.exe";

// Windows PowerShell 5.1 ships with every Windows 10 and 11. WinForms dialogs
// want a single-threaded apartment; the owner form keeps the dialog in front
// of the browser, which a dialog from a background server process is not.
const powershell = (script: string) => ["-NoProfile", "-NonInteractive", "-STA", "-Command", script];
const PS_PREAMBLE = [
  // Paths in any language come back intact, not in the console's code page
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
];
const PS_ANSWER = [
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($PATH) }",
  "$owner.Dispose()",
];

// Nothing chosen comes back as nothing
const answer = (stdout: string) => stdout.replace(/\r?\n$/, "").trim() || null;

/** A folder chosen (or made) in the system's dialog; null when cancelled. */
export async function chooseFolder(prompt: string, { platform = process.platform, run = defaultRun }: Options = {}): Promise<string | null> {
  if (platform === "darwin") {
    try {
      const { stdout } = await run(OSASCRIPT, ["-e", "on run argv", "-e", "return POSIX path of (choose folder with prompt (item 1 of argv))", "-e", "end run", prompt], {});
      // A POSIX folder path ends in a slash
      return answer(stdout)?.replace(/(.)\/$/, "$1") ?? null;
    } catch {
      return null; // osascript fails on Cancel
    }
  }
  if (platform === "win32") {
    const script = [
      ...PS_PREAMBLE,
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = $env:PAPER_READER_PROMPT",
      "$dialog.ShowNewFolderButton = $true",
      ...PS_ANSWER.map((line) => line.replace("$PATH", "$dialog.SelectedPath")),
    ].join("\n");
    const { stdout } = await run(POWERSHELL, powershell(script), { env: { ...process.env, PAPER_READER_PROMPT: prompt }, windowsHide: true });
    return answer(stdout);
  }
  throw new NoNativeDialog("There is no folder dialog on this system: type or paste the folder's full path instead.");
}

/** Where to save a file, from the system's save dialog; null when cancelled. */
export async function chooseSaveFile(
  prompt: string,
  { defaultName, location, extension }: { defaultName: string; location?: string; extension?: string },
  { platform = process.platform, run = defaultRun }: Options = {},
): Promise<string | null> {
  if (platform === "darwin") {
    const script = [
      "on run argv",
      "set defaultName to item 1 of argv",
      "set startAt to item 2 of argv",
      "set askText to item 3 of argv",
      'if startAt is "" then',
      "  set chosen to choose file name with prompt askText default name defaultName",
      "else",
      "  set chosen to choose file name with prompt askText default name defaultName default location (POSIX file startAt)",
      "end if",
      "return POSIX path of chosen",
      "end run",
    ].join("\n");
    try {
      const { stdout } = await run(OSASCRIPT, ["-e", script, defaultName, location ?? "", prompt], {});
      return answer(stdout);
    } catch {
      return null;
    }
  }
  if (platform === "win32") {
    const script = [
      ...PS_PREAMBLE,
      "$dialog = New-Object System.Windows.Forms.SaveFileDialog",
      "$dialog.Title = $env:PAPER_READER_PROMPT",
      "$dialog.FileName = $env:PAPER_READER_NAME",
      "$dialog.OverwritePrompt = $true",
      "if ($env:PAPER_READER_EXT) { $dialog.DefaultExt = $env:PAPER_READER_EXT; $dialog.Filter = \"$($env:PAPER_READER_EXT) files (*.$($env:PAPER_READER_EXT))|*.$($env:PAPER_READER_EXT)|All files (*.*)|*.*\" }",
      "if ($env:PAPER_READER_START) { $dialog.InitialDirectory = $env:PAPER_READER_START }",
      ...PS_ANSWER.map((line) => line.replace("$PATH", "$dialog.FileName")),
    ].join("\n");
    const env = { ...process.env, PAPER_READER_PROMPT: prompt, PAPER_READER_NAME: defaultName, PAPER_READER_START: location ?? "", PAPER_READER_EXT: extension ?? "" };
    const { stdout } = await run(POWERSHELL, powershell(script), { env, windowsHide: true });
    return answer(stdout);
  }
  throw new NoNativeDialog("There is no save dialog on this system: type the full path to save to instead.");
}

/** Moves a folder to the Trash (the Recycle Bin on Windows), from where it can be put back. */
export async function moveToTrash(target: string, { platform = process.platform, run = defaultRun }: Options = {}): Promise<void> {
  if (platform === "darwin") {
    const script = [
      "on run argv",
      "set targetPath to item 1 of argv",
      "set targetItem to POSIX file targetPath as alias",
      'tell application "Finder" to delete targetItem',
      "end run",
    ].join("\n");
    await run(OSASCRIPT, ["-e", script, target], {});
    return;
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:PAPER_READER_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
    ].join("\n");
    await run(POWERSHELL, powershell(script), { env: { ...process.env, PAPER_READER_TARGET: target }, windowsHide: true });
    return;
  }
  throw new NoNativeDialog("Moving a folder to the Trash is supported on macOS and Windows.");
}
