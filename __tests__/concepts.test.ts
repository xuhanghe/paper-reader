// Must come first: react-dom decides at import time whether it is in a browser.
import { dom, freshRoot } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { MindmapSidebar } from "../components/MindmapSidebar.js";
import type { ConceptEntry } from "../types/session.js";

// Concepts used to be a table of contents: one row per conversation, labelled
// with the words that started it. That says where you asked something, not
// what you learned. These are the answers, short enough to scan.

const CONCEPT: ConceptEntry = {
  annotationId: "a1",
  label: "__shared__ float local[TPB * (K + 1)]",
  type: "text",
  takeaways: ["每行加 1 元素错开同列地址，消除 bank 冲突", "__syncthreads() 只同步 block 内"],
  summarizedTurns: 4,
};

let host: HTMLElement;
let shown: number;
let resummarized: string[];
let edited: string[][];

const mount = (concepts: ConceptEntry[], summarizing = new Set<string>()) => {
  shown = 0;
  resummarized = [];
  edited = [];
  host = freshRoot();
  act(() => {
    createRoot(host).render(
      createElement(MindmapSidebar, {
        mindmap: null, mindmapLoading: false, mindmapError: null, hasPdf: true,
        onGenerateMindmap: () => {}, onJumpToSource: () => {}, onJumpToHighlight: () => {},
        onAskAboutNode: () => {},
        concepts,
        summarizingIds: summarizing,
        onConceptsShown: () => { shown += 1; },
        onResummarize: (id: string) => { resummarized.push(id); },
        onEditTakeaways: (_id: string, lines: string[]) => { edited.push(lines); },
        onSelectConcept: () => {},
        highlights: [], onRemoveHighlight: () => {}, onEditNote: () => {},
        zoteroNotes: [], zoteroAnnotations: [], onRemoveZoteroAnnotation: () => {},
        isOpen: true, onToggle: () => {},
      })
    );
  });
};

const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const openConcepts = () => {
  const tab = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith("Concepts"));
  assert.ok(tab, "expected a Concepts tab");
  click(tab!);
};

describe("the concepts list holds what was learned", () => {
  test("each takeaway is its own line", () => {
    mount([CONCEPT]);
    openConcepts();
    const bullets = Array.from(host.querySelectorAll("li")).map((li) => li.textContent ?? "");
    assert.equal(bullets.length, 2);
    assert.ok(bullets[0].includes("消除 bank 冲突"));
    assert.ok(bullets[1].includes("__syncthreads()"));
  });

  test("the conversation it came from is still there to open, but subordinate", () => {
    mount([CONCEPT]);
    openConcepts();
    const text = host.textContent ?? "";
    assert.ok(text.includes("__shared__ float local"), "the label still identifies the conversation");
    assert.ok(text.indexOf("__shared__ float local") < text.indexOf("消除 bank 冲突"), "the takeaways come under it");
  });

  test("opening the tab is what asks for the summaries", () => {
    // Summarising after every answer would spend a model call on conversations
    // nobody looks up again
    mount([CONCEPT]);
    assert.equal(shown, 0, "nothing is summarised while the map is showing");
    openConcepts();
    assert.equal(shown, 1);
  });

  test("a conversation being summarised says so", () => {
    mount([{ annotationId: "a1", label: "padding", type: "text" }], new Set(["a1"]));
    openConcepts();
    assert.ok(host.textContent?.includes("summarising"));
  });

  test("one not summarised yet says that instead of pretending", () => {
    mount([{ annotationId: "a1", label: "padding", type: "text" }]);
    openConcepts();
    assert.ok(host.textContent?.includes("not summarised yet"));
  });

  test("a summary can be asked for again", () => {
    mount([CONCEPT]);
    openConcepts();
    const again = Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Summarise again");
    assert.ok(again, "expected a way to re-summarise a conversation that has moved on");
    click(again!);
    assert.deepEqual(resummarized, ["a1"]);
  });

  test("an empty list says what will fill it", () => {
    mount([]);
    openConcepts();
    assert.ok(host.textContent?.includes("summarised here"));
  });
});

// The list is notes as much as it is output: a summary you cannot correct is
// something to read past, not something to keep.
describe("concepts are notes you can write in", () => {
  const type = (box: HTMLTextAreaElement, text: string) => {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(box, text);
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const box = () => host.querySelector("textarea") as HTMLTextAreaElement;
  const lineButtons = () => Array.from(host.querySelectorAll("li button")).filter((b) => b.getAttribute("aria-label") === null);

  test("a line can be rewritten", () => {
    mount([CONCEPT]);
    openConcepts();
    click(lineButtons()[0]);
    type(box(), "padding 让同列错开 bank");
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save")!);
    assert.deepEqual(edited, [["padding 让同列错开 bank", CONCEPT.takeaways![1]]]);
  });

  test("a line can be added", () => {
    mount([CONCEPT]);
    openConcepts();
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("+ note"))!);
    type(box(), "自己的观察");
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save")!);
    assert.deepEqual(edited, [[...CONCEPT.takeaways!, "自己的观察"]]);
  });

  test("a line can be removed", () => {
    mount([CONCEPT]);
    openConcepts();
    click(Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Remove note line")!);
    assert.deepEqual(edited, [[CONCEPT.takeaways![1]]]);
  });

  test("emptying a line removes it — the same gesture, one fewer button", () => {
    mount([CONCEPT]);
    openConcepts();
    click(lineButtons()[0]);
    type(box(), "   ");
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save")!);
    assert.deepEqual(edited, [[CONCEPT.takeaways![1]]]);
  });

  test("an empty addition writes nothing", () => {
    mount([CONCEPT]);
    openConcepts();
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("+ note"))!);
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save")!);
    assert.deepEqual(edited, []);
  });

  test("an edited list says so, so it is clear what ↻ would replace", () => {
    mount([{ ...CONCEPT, edited: true }]);
    openConcepts();
    const marker = Array.from(host.querySelectorAll("span")).find((el) => el.getAttribute("title")?.includes("automatic summary leaves it alone"));
    assert.ok(marker, "expected an edited marker");
  });

  test("notes can be added to a conversation that was never summarised", () => {
    mount([{ annotationId: "a1", label: "padding", type: "text" }]);
    openConcepts();
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("+ note"))!);
    type(box(), "手写的第一条");
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save")!);
    assert.deepEqual(edited, [["手写的第一条"]]);
  });
});

// Every box the reader types prose into grows to hold it. They were <input>s,
// which cannot take a newline at all and scroll sideways once the text outruns
// the width — so a long note hid its own beginning.
describe("prose boxes hold everything typed into them", () => {
  test("the note box on a concept is a textarea", () => {
    mount([CONCEPT]);
    openConcepts();
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("+ note"))!);
    const el = host.querySelector("textarea");
    assert.ok(el, "expected a growing box, not a single-line input");
    assert.match(el!.className, /pr-autosize/);
    assert.equal(host.querySelectorAll('input[type="text"]').length, 0);
  });
});
