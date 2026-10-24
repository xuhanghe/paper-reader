import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildConversationExport, defaultExportPath } from "../lib/conversation-export.js";

// A conversation exported to carry elsewhere: the user's note to the next
// reader first, the papers it concerned, then every turn as said.

const at = new Date(2026, 9, 24, 15, 2);

describe("a conversation exported as Markdown", () => {
  test("carries the user's notes first, the papers, and every turn in order", () => {
    const text = buildConversationExport({
      workspace: { name: "Encrypted MPI", root: "/Users/x/research/mpi" },
      exportedAt: at,
      notes: "Hand this to the cluster agent; the open question is the nonce size.",
      model: "claude-sonnet-4-6",
      papers: [{ name: "CryptMPI.pdf", zoteroKey: "LA9KBFR7", sessionDir: "/Users/x/.paper-reader-sessions/LA9KBFR7" }, { name: "Other.pdf" }],
      messages: [
        { role: "user", content: "Why is the nonce seven bytes?" },
        { role: "assistant", content: "Because the counter takes the rest.", tools: [{ name: "Read", detail: "paper.md" }] },
        { role: "user", content: "Explain this figure.", hasImage: true },
        { role: "assistant", content: "It shows throughput." },
      ],
    });
    const lines = text.split("\n");
    assert.equal(lines[0], "# Conversation: Encrypted MPI");
    assert.ok(text.includes("Exported from Paper Reader on 2026-10-24 15:02."));
    assert.ok(text.includes("Workspace directory: /Users/x/research/mpi"));
    assert.ok(text.includes("Model: claude-sonnet-4-6"));
    assert.ok(text.indexOf("## Notes from the user") < text.indexOf("## Papers in the workspace"), "notes come first");
    assert.ok(text.includes("the open question is the nonce size."));
    assert.ok(text.includes("- CryptMPI — Zotero key LA9KBFR7 · Reader session: /Users/x/.paper-reader-sessions/LA9KBFR7"));
    assert.ok(text.includes("- Other\n"), "a paper with nothing more is just its title");
    assert.ok(text.includes("## Conversation (2 turns)"));
    assert.ok(text.includes("### 1 · You\n\nWhy is the nonce seven bytes?"));
    assert.ok(text.includes("### 1 · Agent\n\nBecause the counter takes the rest.\n\n_Tools used: Read (paper.md)_"));
    assert.ok(text.includes("### 2 · You\n\n_(a figure was attached)_\n\nExplain this figure."));
    assert.ok(text.endsWith("It shows throughput.\n"));
  });

  test("without notes or papers, those sections are simply absent", () => {
    const text = buildConversationExport({ workspace: { name: "W", root: "/w" }, exportedAt: at, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "" }] });
    assert.ok(!text.includes("## Notes"));
    assert.ok(!text.includes("## Papers"));
    assert.ok(text.includes("## Conversation (1 turn)"));
    assert.ok(text.includes("### 1 · Agent\n\n_(no text)_"), "an empty answer is marked, not dropped");
  });

  test("the default file is a dated note inside the workspace", () => {
    assert.equal(defaultExportPath(at), "notes/conversation-2026-10-24-1502.md");
  });
});
