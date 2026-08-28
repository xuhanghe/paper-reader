export const runtime = "nodejs";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type FetchedPage = { html: string; title: string; finalUrl: string };

async function fetchPlain(url: URL): Promise<FetchedPage | null> {
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title =
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().replace(/\s+/g, " ") || url.hostname;
    return { html, title, finalUrl: res.url || url.toString() };
  } catch {
    return null;
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { EXPAND_COLLAPSED_JS, RENDER_MATH_JS, STRIP_CHROME_JS } from "@/lib/render-math";

// KaTeX assets, read once from node_modules (no CDN at render time).
// Its CSS references fonts by relative URL, which would 404 against the
// article's own domain and render every formula invisible — so the woff2
// files are inlined as data URIs.
// Ask the module resolver where katex actually is rather than assuming a flat
// node_modules under the cwd — that assumption breaks under pnpm/Yarn and
// whenever the server is started from anywhere but the project root.
function katexDir(): string {
  try {
    return path.dirname(createRequire(import.meta.url).resolve("katex/dist/katex.min.js"));
  } catch {
    return path.join(process.cwd(), "node_modules", "katex", "dist");
  }
}

let katexAssets: { js: string; css: string } | null = null;
async function loadKatex() {
  if (katexAssets) return katexAssets;
  const dir = katexDir();
  const [js, rawCss] = await Promise.all([
    readFile(path.join(dir, "katex.min.js"), "utf8"),
    readFile(path.join(dir, "katex.min.css"), "utf8"),
  ]);

  const fontFiles = [...new Set(rawCss.match(/fonts\/[\w-]+\.woff2/g) ?? [])];
  const fontData = new Map<string, string>();
  await Promise.all(
    fontFiles.map(async (rel) => {
      try {
        const buf = await readFile(path.join(dir, rel));
        fontData.set(rel, `data:font/woff2;base64,${buf.toString("base64")}`);
      } catch {
        // missing font — the remaining ones still render
      }
    })
  );
  const css = rawCss.replace(/url\((fonts\/[\w-]+\.woff2)\)/g, (m, rel) =>
    fontData.has(rel) ? `url(${fontData.get(rel)})` : m
  );

  katexAssets = { js, css };
  return katexAssets;
}

// Print styles: keep formulas and figures from splitting across page breaks
const PRINT_CSS = `
  .katex-display { page-break-inside: avoid; break-inside: avoid; margin: 0.6em 0; }
  figure, img, table, pre { page-break-inside: avoid; break-inside: avoid; max-width: 100% !important; }
  h1, h2, h3 { page-break-after: avoid; break-after: avoid; }
  body { background: #fff !important; }
`;

// Render the fully-loaded page to a PDF — math, code, and figures come out
// exactly as the browser displays them (fixes unreadable LaTeX in snapshots)
async function fetchViaChromePdf(
  url: URL
): Promise<{ pdfBase64: string; title: string; finalUrl: string; mathRendered: number } | null> {
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1080, height: 1440 },
        locale: "zh-CN",
        // Sites like Zhihu send a CSP that blocks injected <script>/<style>,
        // which would stop the KaTeX pass below from ever running
        bypassCSP: true,
      });
      const page = await context.newPage();
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000); // let math/images render

      // Wait for real article text — sites under load sometimes serve a stub
      // first, which would otherwise be printed as an empty PDF. The evaluate
      // can race a challenge page navigating to the real one — count that as
      // "not ready yet", not a failure.
      const articleReady = async () =>
        (page.evaluate(`(() => {
          const el = document.querySelector("article, .Post-RichText, .RichText, main");
          return ((el || document.body).innerText || "").trim().length;
        })()`) as Promise<number>).catch(() => 0);
      for (let i = 0; i < 8 && (await articleReady()) < 400; i++) {
        await page.waitForTimeout(1500);
      }

      // Zhihu tags headless visitors with a 403 while still serving the full
      // server-rendered page — then its client app notices and REPLACES the
      // page with an error view partway through our pipeline (the same app
      // code draws the login wall and keeps answers collapsed). The moment the
      // article text is in, freeze the page's own scripts so the swap can
      // never happen. DevTools-driven evaluate() (expansion, KaTeX, chrome
      // stripping) still runs with page script execution disabled.
      if (/(^|\.)zhihu\.com$/.test(url.hostname)) {
        try {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
        } catch (err) {
          console.error("[fetch-page] script freeze skipped:", err);
        }
      }

      // Restore content the site renders truncated (Zhihu's collapsed answers)
      // before touching images or math — the swapped-in HTML needs both passes
      try {
        const { expanded } = (await page.evaluate(EXPAND_COLLAPSED_JS)) as { expanded: number };
        if (expanded) console.log("[fetch-page] collapsed sections restored:", expanded);
      } catch (err) {
        console.error("[fetch-page] expand pass skipped:", err);
      }

      // Nudge lazy-loaded images by walking down the page, then return to top.
      // Driven from here, not by an async loop inside the page — with page
      // scripts frozen, in-page timers never fire and that loop would hang.
      const scrollHeight = (await page
        .evaluate("document.body.scrollHeight")
        .catch(() => 0)) as number;
      for (let y = 0; y < scrollHeight; y += 900) {
        await page.evaluate(`window.scrollTo(0, ${y})`).catch(() => {});
        await page.waitForTimeout(60);
      }
      await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
      await page.waitForTimeout(1200);

      // Render raw LaTeX (Zhihu & co. ship it as plain text) before printing.
      // evaluate() runs through the debugger, so it works even where injected
      // <script> tags would be refused.
      let mathRendered = 0;
      try {
        const katex = await loadKatex();
        await page.evaluate(katex.js);
        await page.evaluate(`(() => {
          const s = document.createElement("style");
          s.textContent = ${JSON.stringify(katex.css)};
          document.head.appendChild(s);
        })()`);
        const result = (await page.evaluate(RENDER_MATH_JS)) as { rendered?: number };
        mathRendered = result?.rendered ?? 0;
        console.log("[fetch-page] math formulas rendered:", mathRendered);
      } catch (err) {
        console.error("[fetch-page] math rendering skipped:", err);
      }

      // Synchronous injection — addStyleTag waits on the style's load event,
      // which never fires while page scripts are frozen
      await page.evaluate(`(() => {
        const s = document.createElement("style");
        s.textContent = ${JSON.stringify(PRINT_CSS)};
        document.head.appendChild(s);
      })()`);
      await page.evaluate(STRIP_CHROME_JS);
      await page.emulateMedia({ media: "screen" });
      const title = (await page.title()) || url.hostname;
      const finalUrl = page.url();
      const pdf = await page.pdf({
        width: "8.5in",
        printBackground: true,
        margin: { top: "0.5in", bottom: "0.5in", left: "0.45in", right: "0.45in" },
      });
      return { pdfBase64: Buffer.from(pdf).toString("base64"), title, finalUrl, mathRendered };
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error("[fetch-page pdf]", err);
    return null;
  }
}

// Sites with bot protection (Zhihu, Medium, …) reject plain fetches on TLS
// fingerprint and JS challenges — render the page in real headless Chrome.
async function fetchViaChrome(url: URL): Promise<FetchedPage | null> {
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
      });
      const page = await context.newPage();
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2000); // let client-side rendering settle
      const html = await page.content();
      const title = (await page.title()) || url.hostname;
      const finalUrl = page.url();
      return { html, title, finalUrl };
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const { url, format } = await req.json();

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return Response.json({ error: "Please provide a valid http(s) URL." }, { status: 400 });
  }

  if (format === "pdf") {
    // One retry: sites occasionally rate-limit a first headless request
    const pdf = (await fetchViaChromePdf(parsed)) ?? (await fetchViaChromePdf(parsed));
    if (!pdf) {
      return Response.json(
        { error: "Could not render that page to PDF — the site blocked access or timed out." },
        { status: 502 }
      );
    }
    return Response.json({
      kind: "pdf",
      pdf_base64: `data:application/pdf;base64,${pdf.pdfBase64}`,
      title: pdf.title,
      finalUrl: pdf.finalUrl,
      math_rendered: pdf.mathRendered,
    });
  }

  const result = (await fetchPlain(parsed)) ?? (await fetchViaChrome(parsed));
  if (!result) {
    return Response.json(
      { error: "Could not fetch that page — the site blocked both direct and browser-based access, or timed out." },
      { status: 502 }
    );
  }

  let { html } = result;
  // Inject <base> so relative images/styles resolve inside the iframe
  const baseTag = `<base href="${result.finalUrl}">`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
  } else {
    html = baseTag + html;
  }

  return Response.json({ html, title: result.title, finalUrl: result.finalUrl });
}
