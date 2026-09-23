// Must come first: react-dom decides at import time whether it is in a
// browser, and takes an IE-era code path if it is not.
import { dom, freshRoot } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { ExplainPanel } from "../components/AskPanel.js";
import type { Annotation, Message } from "../types/session.js";

const thread = (messages: Message[], id = "a1", label = "conversation A"): Annotation => ({
  id,
  type: "text",
  label,
  selectedText: label,
  messages,
  createdAt: 0,
});

// ── Citations the model writes ────────────────────────────────────────
// An answer that says "as the paper puts it" is only half useful if the reader
// has to go and find the place. The model links what it draws on, and those
// links have to land — or, when they point at nothing, stop pretending to.
describe("citations in an answer", () => {
  const PAPER_CITE = "Answering: [the kernel is bandwidth bound](paper:12) explains it.";
  const TURN_CITE = "As covered in [the padding question](turn:3), banks matter.";
  const PLAIN_LINK = "See [the CUDA guide](https://docs.nvidia.com/cuda/) for more.";

  let host: HTMLElement;
  let jumps: { page: number; quote: string }[];
  const refs = { current: {} as Record<string, HTMLDivElement | null> };

  const mount = (annotations: Annotation[]) => {
    jumps = [];
    refs.current = {};
    host = freshRoot();
    act(() => {
      createRoot(host).render(
        createElement(ExplainPanel, {
          annotations,
          activeId: null,
          model: "claude-sonnet-4-6",
          streamingIds: new Set<string>(),
          onFollowUp: () => {},
          onAskGeneral: () => {},
          onDelete: () => {},
          onReExplainImage: () => {},
          onViewInPdf: () => {},
          onCitePaper: (page: number, quote: string) => jumps.push({ page, quote }),
          annotationRefs: refs,
          isOpen: true,
          onToggle: () => {},
        })
      );
    });
  };

  const answering = (content: string, id = "a1") =>
    thread([{ role: "user", content: "what is this", turn: 3 }, { role: "assistant", content }], id, "conversation A");
  const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  const cites = () => Array.from(host.querySelectorAll("button.pr-cite"));

  test("a cited passage takes the reader to it in the paper", () => {
    mount([answering(PAPER_CITE)]);
    const cite = cites().find((b) => b.classList.contains("pr-cite-paper"));
    assert.ok(cite, "expected the paper citation to be clickable");
    assert.ok(cite!.textContent?.includes("the kernel is bandwidth bound"), "it reads as the quote, not as a marker");
    click(cite!);
    assert.deepEqual(jumps, [{ page: 12, quote: "the kernel is bandwidth bound" }]);
  });

  test("a formula in a cited passage is typeset, and the jump carries its plain reading", () => {
    // Written as the screenshot had it: LaTeX inside the link text. KaTeX
    // hands the link three copies of it, and the label used to show all three
    mount([answering("This explains why [learnable positional biases $B^a, B^b \\in \\mathbb{R}^{m \\times c}$](paper:10) are per channel.")]);
    const [cite] = cites();
    assert.ok(cite, "a citation button");
    assert.ok(cite.querySelector(".katex"), "the formula is typeset inside the link");
    // Nothing of the LaTeX source is shown outside KaTeX's own hidden annotation
    const shown = Array.from(cite.childNodes).filter((n) => !(n instanceof dom.window.HTMLElement && (n.matches(".katex") || n.querySelector(".katex")))).map((n) => n.textContent).join("");
    assert.doesNotMatch(shown, /mathbb|\^/);
    assert.match(cite.textContent || "", /learnable positional biases/);
    assert.match(cite.childNodes[0].textContent || "", /biases $/, "the space before the formula is kept");
    click(cite);
    assert.equal(jumps.length, 1);
    assert.equal(jumps[0].page, 10);
    assert.doesNotMatch(jumps[0].quote, /mathbb|\^|\\/, "no LaTeX in what is searched for");
    assert.equal(jumps[0].quote.replace(/\s+/g, ""), "learnablepositionalbiasesBa,Bb∈Rm×c", "the formula read as the page reads it, once");
  });

  test("the page it points at is shown, so the jump is predictable", () => {
    mount([answering(PAPER_CITE)]);
    assert.ok(host.textContent?.includes("p12"));
  });

  test("a cited turn goes back to that question", async () => {
    mount([answering(TURN_CITE)]);
    const cite = cites().find((b) => b.classList.contains("pr-cite-turn"));
    assert.ok(cite, "expected the conversation citation to be clickable");
    click(cite!);
    await settle();
    const landed = host.querySelector(".pr-quote-flash");
    assert.ok(landed?.textContent?.includes("what is this"), "lands on the turn it names");
  });

  test("a turn that is not in the panel is not offered as a link", () => {
    // The model does invent numbers; a link that goes nowhere is worse than none
    mount([answering("See [something](turn:99) for that.")]);
    assert.equal(cites().length, 0);
    assert.ok(host.textContent?.includes("something"), "the words stay, only the link goes");
  });

  test("an ordinary link the model recommends stays an ordinary link", () => {
    mount([answering(PLAIN_LINK)]);
    assert.equal(cites().length, 0);
    const link = host.querySelector('a[href^="https://docs.nvidia.com"]');
    assert.ok(link, "a recommended resource must not be swallowed by the citation scheme");
    assert.equal(link!.getAttribute("target"), "_blank");
  });

  test("a citation half-written by streaming is not rendered as a broken one", () => {
    mount([answering("Answering: [the kernel is bandwid")]);
    assert.equal(cites().length, 0);
    assert.ok(host.textContent?.includes("the kernel is bandwid"), "it reads as ordinary text until it is finished");
  });

  test("the reader's own question is never treated as markdown", () => {
    // A question mentioning [brackets](turn:1) is text the reader typed
    mount([thread([{ role: "user", content: "why [this](turn:1)?" }], "a1", "conversation A")]);
    assert.equal(cites().length, 0);
    assert.ok(host.textContent?.includes("why [this](turn:1)?"));
  });
});

// Going back to where a jump started. The buttons live beside the
// conversations because that is where most jumps are taken from.
describe("undoing a jump", () => {
  let host: HTMLElement;
  let moves: string[];

  const mount = (canBack: boolean, canForward: boolean) => {
    moves = [];
    host = freshRoot();
    act(() => {
      createRoot(host).render(
        createElement(ExplainPanel, {
          annotations: [thread([{ role: "assistant", content: "an answer" }])],
          activeId: null, model: "m", streamingIds: new Set<string>(),
          onFollowUp: () => {}, onAskGeneral: () => {}, onDelete: () => {},
          onReExplainImage: () => {}, onViewInPdf: () => {},
          annotationRefs: { current: {} },
          canGoBack: canBack, canGoForward: canForward,
          onGoBack: () => moves.push("back"), onGoForward: () => moves.push("forward"),
          isOpen: true, onToggle: () => {},
        })
      );
    });
  };
  const button = (label: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label);

  test("both controls are offered", () => {
    mount(true, true);
    assert.ok(button("Back"));
    assert.ok(button("Forward"));
  });

  test("clicking back asks to go back", () => {
    mount(true, false);
    act(() => { button("Back")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(moves, ["back"]);
  });

  test("with nowhere to go they are disabled rather than misleading", () => {
    mount(false, false);
    assert.equal((button("Back") as HTMLButtonElement).disabled, true);
    assert.equal((button("Forward") as HTMLButtonElement).disabled, true);
  });
});
