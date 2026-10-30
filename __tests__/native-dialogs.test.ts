import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { chooseFolder, chooseSaveFile, moveToTrash, NoNativeDialog, type Run } from "../lib/native-dialogs.js";
import { expandWorkspacePath } from "../lib/workspace-files.js";

// The Workspace's folder and save dialogs and its bin, on macOS and on
// Windows: what each system is asked, and how its answer is read. A runner
// stands in for the system, so these run anywhere.

type Call = { file: string; args: string[]; env?: NodeJS.ProcessEnv };
const runner = (reply: string | Error) => {
  const calls: Call[] = [];
  const run: Run = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (reply instanceof Error) throw reply;
    return { stdout: reply };
  };
  return { run, calls };
};

describe("choosing a folder", () => {
  test("macOS asks osascript, the prompt as an argument, and drops the slash a folder path ends in", async () => {
    const { run, calls } = runner("/Users/me/Research/dpu/\n");
    assert.equal(await chooseFolder("Choose a folder", { platform: "darwin", run }), "/Users/me/Research/dpu");
    assert.equal(calls[0].file, "/usr/bin/osascript");
    assert.equal(calls[0].args.at(-1), "Choose a folder");
  });

  test("on macOS, Cancel (osascript failing) is nothing chosen", async () => {
    const { run } = runner(new Error("User canceled. (-128)"));
    assert.equal(await chooseFolder("Choose", { platform: "darwin", run }), null);
  });

  test("Windows asks PowerShell's folder dialog, the prompt in the environment and not in the script", async () => {
    const { run, calls } = runner("C:\\Users\\me\\研究\\dpu\r\n");
    assert.equal(await chooseFolder("Pick \"it\"; exit", { platform: "win32", run }), "C:\\Users\\me\\研究\\dpu");
    const [{ file, args, env }] = calls;
    assert.equal(file, "powershell.exe");
    assert.ok(args.includes("-STA"));
    const script = args.at(-1)!;
    assert.match(script, /FolderBrowserDialog/);
    assert.match(script, /OutputEncoding = \[Text\.Encoding\]::UTF8/);
    assert.ok(!script.includes("Pick"));
    assert.equal(env?.PAPER_READER_PROMPT, "Pick \"it\"; exit");
  });

  test("on Windows, Cancel is an empty answer, and nothing chosen", async () => {
    const { run } = runner("");
    assert.equal(await chooseFolder("Choose", { platform: "win32", run }), null);
  });

  test("elsewhere there is no dialog, and the path is typed instead", async () => {
    const { run, calls } = runner("");
    await assert.rejects(chooseFolder("Choose", { platform: "linux", run }), NoNativeDialog);
    assert.equal(calls.length, 0);
  });
});

describe("choosing where to save", () => {
  test("Windows: the name, the folder to start in and the extension go in the environment", async () => {
    const { run, calls } = runner("D:\\exports\\conversation.md\r\n");
    const chosen = await chooseSaveFile("Save the export", { defaultName: "conversation.md", location: "C:\\work\\dpu", extension: "md" }, { platform: "win32", run });
    assert.equal(chosen, "D:\\exports\\conversation.md");
    assert.match(calls[0].args.at(-1)!, /SaveFileDialog/);
    assert.equal(calls[0].env?.PAPER_READER_NAME, "conversation.md");
    assert.equal(calls[0].env?.PAPER_READER_START, "C:\\work\\dpu");
    assert.equal(calls[0].env?.PAPER_READER_EXT, "md");
  });

  test("macOS: osascript with the name, the folder and the prompt as arguments", async () => {
    const { run, calls } = runner("/Users/me/Desktop/conversation.md\n");
    assert.equal(await chooseSaveFile("Save the export", { defaultName: "conversation.md", location: "/Users/me/work" }, { platform: "darwin", run }), "/Users/me/Desktop/conversation.md");
    assert.deepEqual(calls[0].args.slice(-3), ["conversation.md", "/Users/me/work", "Save the export"]);
  });
});

describe("moving a folder to the bin", () => {
  test("Windows sends it to the Recycle Bin, the folder in the environment", async () => {
    const { run, calls } = runner("");
    await moveToTrash("C:\\work\\old workspace", { platform: "win32", run });
    const script = calls[0].args.at(-1)!;
    assert.match(script, /SendToRecycleBin/);
    assert.ok(!script.includes("old workspace"));
    assert.equal(calls[0].env?.PAPER_READER_TARGET, "C:\\work\\old workspace");
  });

  test("macOS asks Finder; elsewhere it is refused", async () => {
    const { run, calls } = runner("");
    await moveToTrash("/Users/me/old", { platform: "darwin", run });
    assert.match(calls[0].args[1], /tell application "Finder" to delete/);
    assert.equal(calls[0].args.at(-1), "/Users/me/old");
    await assert.rejects(moveToTrash("/home/me/old", { platform: "linux", run }), NoNativeDialog);
  });
});

test("a workspace path typed from home, with either separator", () => {
  assert.equal(expandWorkspacePath("~/research/dpu"), path.join(homedir(), "research/dpu"));
  assert.equal(expandWorkspacePath("~\\research"), path.join(homedir(), "research"));
});
