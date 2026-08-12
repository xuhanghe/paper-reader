// Injected into a page before printing it to PDF.
//
// Blog platforms (Zhihu in particular) serve article math as RAW LaTeX text —
// their own renderer only runs inside the full logged-in app — so a printed
// page shows "\boldsymbol{y}" instead of the formula. This finds the TeX and
// renders it with KaTeX, which is injected from node_modules (no CDN).
//
// Detection: TeX never contains CJK characters, so within each text node we
// take maximal non-CJK runs that contain at least one TeX command and render
// those. Standard $$…$$ / \[…\] / \(…\) delimiters are handled first.
export const RENDER_MATH_JS = String.raw`
(() => {
  if (!window.katex) return { rendered: 0, reason: "katex missing" };
  let rendered = 0;

  const renderOnce = (tex, display) => {
    const span = document.createElement("span");
    try {
      window.katex.render(tex, span, { displayMode: display, throwOnError: false, strict: false });
      return span.querySelector(".katex-error") ? null : span;
    } catch {
      return null;
    }
  };

  // Some constructs (\tag, multi-line environments) are display-only, so a
  // failed inline attempt is retried as display; if both fail the original
  // text is left untouched rather than showing KaTeX's red error text.
  const render = (tex, display) => {
    const span = renderOnce(tex, display) || (display ? null : renderOnce(tex, true));
    if (span) rendered++;
    return span;
  };

  const CJK = /[　-鿿＀-￯]/;
  const TEX_CMD = /\\[a-zA-Z]{2,}|[_^]\{|\\\[|\\\(/;
  const DELIMITED = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/;

  // Nodes whose text we should never touch
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "NOSCRIPT"]);

  const processTextNode = (node) => {
    const text = node.nodeValue;
    if (!text || text.length < 3 || !TEX_CMD.test(text)) return;
    if (node.parentElement && SKIP.has(node.parentElement.tagName)) return;
    if (node.parentElement && node.parentElement.closest(".katex")) return;

    const frag = document.createDocumentFragment();
    let rest = text;
    let progressed = false;

    while (rest.length) {
      const m = DELIMITED.exec(rest);
      if (m) {
        // Explicit delimiters win
        if (m.index > 0) frag.appendChild(document.createTextNode(rest.slice(0, m.index)));
        const tex = (m[1] ?? m[2] ?? m[3] ?? "").trim();
        const display = m[0].startsWith("$$") || m[0].startsWith("\\[");
        const el = render(tex, display);
        frag.appendChild(el || document.createTextNode(m[0]));
        progressed = true;
        rest = rest.slice(m.index + m[0].length);
        continue;
      }

      // Heuristic: maximal non-CJK run containing a TeX command
      let start = -1;
      for (let i = 0; i < rest.length; i++) {
        if (!CJK.test(rest[i])) { start = i; break; }
      }
      if (start === -1) { frag.appendChild(document.createTextNode(rest)); break; }
      let end = start;
      while (end < rest.length && !CJK.test(rest[end])) end++;

      const chunk = rest.slice(start, end);
      const trimmed = chunk.replace(/\\\\\s*$/, "").trim();
      if (TEX_CMD.test(trimmed) && trimmed.length > 1) {
        if (start > 0) frag.appendChild(document.createTextNode(rest.slice(0, start)));
        // Display mode only for genuinely standalone formulas: a multi-line
        // environment, or a formula that is the entire paragraph. Comparing
        // against the nearest BLOCK ancestor keeps mid-sentence math inline
        // even when the site wraps each formula in its own <span>.
        const block = node.parentElement && node.parentElement.closest("p, li, td, div, section, article, blockquote");
        const display =
          /\\begin\{(aligned|align|equation|gather|array|cases|split|multline)/.test(trimmed) ||
          /\\tag\{/.test(trimmed) ||
          (!!block && block.textContent.trim() === trimmed);
        const el = render(trimmed, display);
        if (el) {
          frag.appendChild(el);
          progressed = true;
        } else {
          frag.appendChild(document.createTextNode(chunk));
        }
        rest = rest.slice(end);
      } else {
        frag.appendChild(document.createTextNode(rest.slice(0, end)));
        rest = rest.slice(end);
      }
    }

    if (progressed) node.parentNode && node.parentNode.replaceChild(frag, node);
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(processTextNode);

  return { rendered };
})();
`;

// Removes site chrome that would otherwise repeat on every printed page
// (fixed navbars, login cards, cookie banners) and unlocks scrolling.
export const STRIP_CHROME_JS = String.raw`
(() => {
  const kill = (el) => {
    if (!el || el === document.body || el === document.documentElement) return;
    if (el.contains(document.querySelector("article, .Post-RichText, .RichText"))) return;
    el.remove();
  };
  document
    .querySelectorAll('[role="dialog"], [class*="Modal"], [class*="signFlow"], [class*="LoginBar"], [class*="login-modal"], [class*="Popover-backdrop"], [class*="backdrop"], [class*="CornerButtons"], [class*="Sticky"]')
    .forEach(kill);
  // Fixed/sticky elements repeat on every printed page — always chrome
  [...document.querySelectorAll("*")].forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "sticky") kill(el);
  });
  document.documentElement.style.setProperty("overflow", "auto", "important");
  document.body.style.setProperty("overflow", "auto", "important");
})();
`;
