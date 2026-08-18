// A DOM, installed before react-dom is imported.
//
// react-dom decides at import time whether it is running in a browser, and
// falls back to an IE-era value-tracking path if it is not — which then dies on
// `activeElement.attachEvent` the moment a text box takes focus. Creating the
// window inside a test is too late, so this module is imported first and every
// test shares the one window.
import { JSDOM } from "jsdom";

// Deliberately not pretendToBeVisual: that starts an animation-frame loop that
// never stops, and a window created at module scope then keeps the event loop
// alive forever, so the test process hangs instead of exiting.
export const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/",
});

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
// Browser globals the highlight layer reaches for by name
g.NodeFilter = dom.window.NodeFilter;
g.Range = dom.window.Range;
g.Text = dom.window.Text;
g.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
// Unref'd, so a frame still pending at the end of a test cannot hold the
// process open
g.requestAnimationFrame = (cb: FrameRequestCallback) => {
  const t = setTimeout(() => cb(0), 0);
  t.unref?.();
  return t as unknown as number;
};
g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
dom.window.requestAnimationFrame = g.requestAnimationFrame as typeof dom.window.requestAnimationFrame;
dom.window.cancelAnimationFrame = g.cancelAnimationFrame as typeof dom.window.cancelAnimationFrame;

// Geometry jsdom has no layout for. The panel places the quote button over a
// selection, and scrolls conversations into view.
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect(20, 40, 80, 16);
dom.window.Range.prototype.getClientRects = (() => []) as unknown as Range["getClientRects"];

export const scrollCalls: ScrollIntoViewOptions[] = [];
dom.window.Element.prototype.scrollIntoView = function (opts?: boolean | ScrollIntoViewOptions) {
  scrollCalls.push(typeof opts === "object" && opts ? opts : {});
};

// A fresh mount point per test, so state never leaks between them
export function freshRoot(): HTMLElement {
  dom.window.document.body.innerHTML = "<div id='root'></div>";
  scrollCalls.length = 0;
  return dom.window.document.getElementById("root") as unknown as HTMLElement;
}
