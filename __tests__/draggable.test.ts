// Must come first: react-dom decides at import time whether it is in a
// browser, and takes an IE-era code path if it is not.
import { dom, freshRoot } from "./helpers/dom-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { SelectionPopover } from "../components/SelectionPopover.js";
import { HighlightPopover } from "../components/HighlightPopover.js";

// A popover sits where its anchor puts it; the reader can then drag it by
// its frame anywhere, and it stays until the anchor changes.
describe("popovers can be dragged", () => {
  const rect = (left: number, top: number) => ({ left, top, right: left + 100, bottom: top + 20, width: 100, height: 20, x: left, y: top, toJSON() {} }) as DOMRect;
  const mouse = (el: { dispatchEvent: (e: Event) => boolean }, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })); });

  test("the selection popover follows a drag on its frame, not on its buttons", () => {
    const host = freshRoot();
    const root = createRoot(host);
    const render = (r: DOMRect) => act(() => { root.render(createElement(SelectionPopover, { rect: r, selectedText: "x", onExplain: () => {}, onAsk: () => {}, onDismiss: () => {} })); });
    render(rect(200, 100));
    const box = host.querySelector("[data-draggable]") as HTMLElement;
    assert.match(box.style.transform, /translate\(calc\(-50% \+ 0px\), 0px\)/);
    mouse(box, "mousedown", 300, 130);
    mouse(dom.window, "mousemove", 340, 190);
    mouse(dom.window, "mouseup", 340, 190);
    assert.match(box.style.transform, /\+ 40px\), 60px\)/, "moved by the drag");
    // Let go over the box itself — whose mouseup does not bubble — and the
    // box must not keep following the pointer
    mouse(box, "mousedown", 300, 130);
    mouse(dom.window, "mousemove", 305, 135);
    mouse(box, "mouseup", 305, 135);
    mouse(dom.window, "mousemove", 900, 900);
    assert.match(box.style.transform, /\+ 45px\), 65px\)/, "put down where the pointer was released");
    // a press on a button is a click, not a drag
    const button = box.querySelector("button")!;
    mouse(button, "mousedown", 300, 130);
    mouse(dom.window, "mousemove", 400, 400);
    mouse(dom.window, "mouseup", 400, 400);
    assert.match(box.style.transform, /\+ 45px\), 65px\)/, "unchanged");
    // a new anchor forgets the offset
    render(rect(500, 300));
    assert.match(box.style.transform, /\+ 0px\), 0px\)/);
  });

  test("the highlight popover too", () => {
    const host = freshRoot();
    act(() => { createRoot(host).render(createElement(HighlightPopover, { rect: rect(200, 100), onRecolor: () => {}, onEditNote: () => {}, onRemove: () => {}, onDismiss: () => {} })); });
    const box = host.querySelector("[data-draggable]") as HTMLElement;
    mouse(box, "mousedown", 300, 130);
    mouse(dom.window, "mousemove", 310, 150);
    mouse(dom.window, "mouseup", 310, 150);
    assert.match(box.style.transform, /\+ 10px\), 20px\)/);
  });
});
