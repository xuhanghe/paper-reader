import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendThread, dirFor, paperPathFor, pagesDirFor } from "../lib/session-store.js";
import { paperPages, paperTextUpTo, runTool, toolSpecs, type ToolContext } from "../lib/endpoint-tools.js";
import { conversationsOf } from "../lib/endpoint-context.js";

// A model behind a third-party API reads the paper with these, run here: by
// page, by search, a conversation in full, a page as an image — never past
// the page the reader has reached unless they asked about the whole paper.

const ID = "__endpoint-tools-test__";
const PAPER = ["# A paper", "", "[page 1]", "Intro text. Offload paths matter.", "", "[page 2]", "Methods: OvS-DPDK offload rules go to the eSwitch.", "", "[page 3]", "Results we have not reached yet: offload wins."].join("\n");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  paperId: ID,
  readUpTo: 2,
  wholePaper: false,
  vision: true,
  conversations: conversationsOf({ annotations: [
    { id: "ovs-0001-aaaa", type: "text", label: "OvS", selectedText: "OvS-DPDK (HW offload)", pageNumber: 2, messages: [{ role: "user", content: "is OvS in userspace?" }, { role: "assistant", content: "Yes." }], createdAt: 0 },
  ] }, "ovs-0001-aaaa"),
  ...over,
});

before(async () => {
  await mkdir(pagesDirFor(ID), { recursive: true });
  await writeFile(paperPathFor(ID), PAPER);
  await writeFile(path.join(pagesDirFor(ID), "page-2.jpg"), JPEG);
  await writeFile(path.join(pagesDirFor(ID), "page-3.jpg"), JPEG);
  await appendThread(ID, { ts: 1, role: "user", text: "[turn 1] About this passage (page 2):\n\n\"OvS-DPDK\"\n\nMy question: is OvS in userspace?\n\nI am at page 2 of the paper. Stand on what comes before.", annotationId: "ovs-0001-aaaa" });
  await appendThread(ID, { ts: 2, role: "assistant", text: "Yes, OvS runs in userspace here.", annotationId: "ovs-0001-aaaa", turn: 1 });
});
after(() => rm(dirFor(ID), { recursive: true, force: true }));

describe("the paper, page by page", () => {
  test("split on its [page N] markers; a document without them is one page", () => {
    assert.deepEqual([...paperPages(PAPER).keys()], [1, 2, 3]);
    assert.equal(paperPages(PAPER).get(2), "Methods: OvS-DPDK offload rules go to the eSwitch.");
    assert.deepEqual([...paperPages("just text").entries()], [[1, "just text"]]);
  });

  test("inline for a model without tools: up to the reader's page, the nearest pages first when they don't all fit", () => {
    const text = paperTextUpTo(PAPER, 2, 10000);
    assert.ok(text.includes("[page 2]") && !text.includes("not reached"));
    assert.equal(paperTextUpTo(PAPER, 2, 60), "[page 2]\nMethods: OvS-DPDK offload rules go to the eSwitch.");
    assert.ok(paperTextUpTo(PAPER, undefined, 10000).includes("[page 3]"));
  });
});

describe("the tools", () => {
  test("view_page is offered only to a model that reads images", () => {
    assert.deepEqual(toolSpecs({ vision: false }).map((s) => s.name), ["read_paper", "search_paper", "read_conversation"]);
    assert.ok(toolSpecs({ vision: true }).some((s) => s.name === "view_page"));
  });

  test("read_paper reads up to the reader's page, says what it left out, and names what it is doing", async () => {
    const r = await runTool("read_paper", { from_page: 1, to_page: 3 }, ctx());
    assert.ok(r.text.includes("[page 1]") && r.text.includes("[page 2]") && !r.text.includes("not reached"));
    assert.match(r.text, /Up to page 2, where I am/);
    assert.equal(r.activity, "Reading pages 1–3");
    assert.match((await runTool("read_paper", { from_page: 3 }, ctx())).text, /page 3 comes later/);
    assert.ok((await runTool("read_paper", { from_page: "3" }, ctx({ wholePaper: true }))).text.includes("offload wins"));
  });

  test("search_paper finds words with their pages, not past the reader's page", async () => {
    const r = await runTool("search_paper", { query: "offload" }, ctx());
    assert.ok(r.text.includes("[page 1]") && r.text.includes("[page 2]") && !r.text.includes("[page 3]"));
    assert.match((await runTool("search_paper", { query: "nowhere to be found" }, ctx())).text, /^No "nowhere to be found" up to page 2/);
  });

  test("read_conversation gives one in full by its id, the app's directions left out", async () => {
    const r = await runTool("read_conversation", { conversation: "[ovs0001a]" }, ctx());
    assert.match(r.text, /^Me: \[turn 1\] About this passage \(page 2\):/);
    assert.ok(r.text.includes("You: Yes, OvS runs in userspace here.") && !r.text.includes("Stand on what comes before"));
    assert.match((await runTool("read_conversation", { conversation: "nope" }, ctx())).text, /There is no conversation/);
  });

  test("view_page returns the page as an image, and not a page the reader hasn't reached", async () => {
    const r = await runTool("view_page", { page: 2 }, ctx());
    assert.match(r.images?.[0] ?? "", /^data:image\/jpeg;base64,/);
    assert.equal(r.activity, "Looking at page 2");
    const later = await runTool("view_page", { page: 3 }, ctx());
    assert.equal(later.images, undefined);
    assert.equal((await runTool("view_page", { page: 2 }, ctx({ vision: false }))).text, "There is no tool called view_page.");
  });
});
