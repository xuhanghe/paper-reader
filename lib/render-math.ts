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

// Zhihu (logged out) renders answers truncated — a ~400px clamp plus an
// "阅读全文" button whose click only summons the login wall. The full answer
// HTML is nevertheless delivered in the #js-initialData hydration blob, so
// swap it into the DOM before printing. Injected HTML still carries Zhihu's
// lazy-load placeholders (inline SVG src + data-actualsrc/data-original),
// which never resolve without their JS — rewrite those to the real image.
// Runs before the KaTeX pass so any TeX inside the restored text gets
// rendered too. Harmless elsewhere: no #js-initialData → no-op.
export const EXPAND_COLLAPSED_JS = String.raw`
(() => {
  let expanded = 0;

  const fixLazyImages = (root) => {
    root.querySelectorAll("img[data-actualsrc], img[data-original]").forEach((img) => {
      const real = img.getAttribute("data-actualsrc") || img.getAttribute("data-original");
      if (real && !(img.getAttribute("src") || "").startsWith("http")) img.setAttribute("src", real);
      img.classList.remove("lazy");
    });
  };

  const unclamp = (item) => {
    item.querySelectorAll(".RichContent").forEach((el) => el.classList.remove("is-collapsed"));
    item.querySelectorAll(".RichContent-inner").forEach((el) => {
      el.classList.remove("RichContent-inner--collapsed");
      // clamp and fade both come from class rules — override, don't just clear
      el.style.setProperty("max-height", "none", "important");
      el.style.setProperty("mask-image", "none", "important");
      el.style.setProperty("-webkit-mask-image", "none", "important");
    });
    item
      .querySelectorAll(".ContentItem-expandButton, button.ContentItem-more, .ContentItem-rightButton")
      .forEach((el) => el.remove());
  };

  let entities = {};
  try {
    const data = JSON.parse(document.querySelector("#js-initialData")?.textContent ?? "");
    entities = data?.initialState?.entities ?? {};
  } catch {
    // not a Zhihu-style page — the generic unclamp below still applies
  }
  const fullContent = (id) => {
    for (const kind of ["answers", "articles"]) {
      const content = entities?.[kind]?.[id]?.content;
      if (typeof content === "string" && content.length) return content;
    }
    return null;
  };

  document.querySelectorAll(".ContentItem[name]").forEach((item) => {
    const target = item.querySelector(".RichContent-inner .RichText, .RichContent-inner");
    if (!target) return;
    const content = fullContent(item.getAttribute("name"));
    // Zhihu usually server-renders the complete answer and merely clamps it
    // visually, so unclamping is the whole fix. Swap in the blob only when it
    // genuinely holds more TEXT than the DOM — comparing HTML lengths would
    // let a markup-heavy excerpt replace a complete answer.
    if (content) {
      const blobText = new DOMParser().parseFromString(content, "text/html").body.textContent || "";
      if (blobText.length > (target.textContent || "").length + 200) {
        target.innerHTML = content;
        fixLazyImages(target);
        expanded++;
      }
    }
    unclamp(item);
  });

  // Whatever is still clamped (no blob entry) at least prints in full
  document.querySelectorAll(".RichContent.is-collapsed").forEach((el) => {
    unclamp(el.parentElement || el);
  });

  // With the site's scripts blocked nothing else resolves lazy placeholders,
  // so sweep the whole page, not just the swapped-in answers
  fixLazyImages(document.body);

  return { expanded };
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
  // With page scripts frozen the browser renders <noscript> fallbacks — on
  // Zhihu that's escaped <img …> markup printed as literal text
  document.querySelectorAll("noscript").forEach((el) => el.remove());
  // Fixed/sticky elements repeat on every printed page — always chrome
  [...document.querySelectorAll("*")].forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "sticky") kill(el);
  });
  document.documentElement.style.setProperty("overflow", "auto", "important");
  document.body.style.setProperty("overflow", "auto", "important");
})();
`;
