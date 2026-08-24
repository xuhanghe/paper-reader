// End-to-end audit of text selection, highlighting and underlining.
//
// Drives the running dev server in a real Chrome against a synthetic PDF whose
// every baseline is authored — so "where the text is" is a known number, not
// another measurement. Verifies the live selection band, the highlight wash,
// the asked-passage rule, multi-line selections, zoom, and the legacy fallback
// (records with no stored position), and screenshots each state.
//
//   node scripts/band-audit.mjs        (dev server on :3000, Chrome installed)
//
// Screenshots and the verdict table land in band-audit-out/.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "band-audit-out");
const SESSION = path.join(ROOT, ".paper-reader-sessions", "band-audit-pdf");
fs.mkdirSync(OUT, { recursive: true });

// ── The authored page: 12 lines, baselines from y=700 down in steps of 20 ──
function makePdf() {
  const lines = [];
  let y = 700;
  for (let i = 1; i <= 12; i++) {
    const text =
      i === 3 || i === 8
        ? `line ${String(i).padStart(2, "0")} the kernel is bandwidth bound at every size`
        : `line ${String(i).padStart(2, "0")} steady prose filling the measured line ${String(i).padStart(2, "0")}`;
    lines.push([y, text]);
    y -= 20;
  }
  let content = "BT\n/F1 12 Tf\n";
  for (const [ly, text] of lines) content += `1 0 0 1 72 ${ly} Tm (${text}) Tj\n`;
  content += "ET\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(OUT, "band-audit.pdf");
  fs.writeFileSync(file, Buffer.from(out, "latin1"));
  return file;
}

const failures = [];
function judge(label, bands, ink, expect) {
  for (const b of bands) {
    const near = Object.entries(ink).reduce((best, kv) =>
      Math.abs((kv[1].top + kv[1].bottom) / 2 - (b.top + b.bottom) / 2) <
      Math.abs((best[1].top + best[1].bottom) / 2 - (b.top + b.bottom) / 2) ? kv : best
    );
    const [line, li] = near;
    const dTop = b.top - li.top;
    const dBot = b.bottom - li.bottom;
    const wrongLine = expect && expect[b.kind] && !expect[b.kind].includes(+line);
    const off = b.kind === "rule" ? Math.abs(dBot) > 4 : Math.abs(dTop) > 9 || Math.abs(dBot) > 6;
    const bad = wrongLine || off;
    if (bad) failures.push(`${label}: ${b.kind} -> line ${line} dTop=${dTop.toFixed(1)} dBot=${dBot.toFixed(1)}`);
    console.log(
      `  ${bad ? "FAIL" : " ok "} ${label.padEnd(16)} ${b.kind.padEnd(9)} -> line ${String(line).padStart(2)}  dTop=${dTop.toFixed(1).padStart(6)} dBot=${dBot.toFixed(1).padStart(6)}`
    );
  }
}

async function main() {
  fs.rmSync(SESSION, { recursive: true, force: true });
  const pdf = makePdf();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.route("**/api/ask", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        JSON.stringify({ type: "system", session_id: "audit" }) + "\n" +
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "mock answer." } }) + "\n",
    })
  );

  const open = async () => {
    await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
    await page.setInputFiles('input[type="file"][accept=".pdf"]', pdf);
    await page.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 20000 });
    try { await page.click("text=Don't save", { timeout: 3000 }); } catch { /* not offered */ }
    await page.waitForTimeout(1200);
  };
  await open();

  const select = (needle, phrase) =>
    page.evaluate(([needle, phrase]) => {
      const spans = Array.from(document.querySelectorAll(".textLayer span"));
      const span = spans.find((s) => s.textContent && s.textContent.includes(needle));
      if (!span) return { error: "span not found: " + needle };
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let node = null, at = -1;
      while (walker.nextNode()) {
        const i = walker.currentNode.data.indexOf(phrase);
        if (i !== -1) { node = walker.currentNode; at = i; break; }
      }
      if (!node) return { error: "phrase not in span" };
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + phrase.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { ok: true };
    }, [needle, phrase]);

  const measure = () =>
    page.evaluate(() => {
      const cr = document.querySelector('.page[data-page-number="1"] canvas').getBoundingClientRect();
      const k = cr.height / 792;
      const ink = {};
      for (let i = 1; i <= 12; i++) {
        const y = 700 - (i - 1) * 20;
        ink[i] = { top: cr.top + (792 - y) * k - 8.6 * k, bottom: cr.top + (792 - y) * k + 2.5 * k };
      }
      const bands = Array.from(document.querySelectorAll(".pr-band")).map((b) => {
        const r = b.getBoundingClientRect();
        return {
          kind: b.className.includes("pr-asked-rule") ? "rule" : b.className.includes("pr-selection") ? "selection" : "wash",
          top: r.top, bottom: r.bottom,
        };
      });
      return { ink, bands };
    });

  const shot = async (name) => {
    const clip = await page.evaluate(() => {
      const cr = document.querySelector('.page[data-page-number="1"] canvas').getBoundingClientRect();
      return { x: Math.max(0, cr.left - 10), y: Math.max(0, cr.top + 40), width: Math.min(760, cr.width + 20), height: 460 };
    });
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
  };

  // 1. live selection
  let r = await select("line 05", "steady prose filling");
  if (r.error) throw new Error(r.error);
  await page.waitForTimeout(400);
  let m = await measure();
  judge("selection", m.bands, m.ink, { selection: [5] });
  await shot("1-selection");

  // 2. highlight
  await page.evaluate(() => document.querySelector('[title="Highlight in this colour"] button')?.click());
  await page.waitForTimeout(600);
  m = await measure();
  judge("highlight", m.bands, m.ink, { wash: [5] });
  await shot("2-highlight");

  // 3. underline on the SECOND occurrence of a repeated phrase
  r = await select("line 08", "the kernel is bandwidth bound");
  if (r.error) throw new Error(r.error);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Explain"))?.click();
  });
  await page.waitForTimeout(900);
  m = await measure();
  judge("underline", m.bands, m.ink, { wash: [5], rule: [8] });
  await shot("3-underline");

  // 4. multi-line
  r = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll(".textLayer span"));
    const s9 = spans.find((s) => s.textContent?.includes("line 09"));
    const s11 = spans.find((s) => s.textContent?.includes("line 11"));
    if (!s9 || !s11) return { error: "spans not found" };
    const range = document.createRange();
    range.setStart(s9.firstChild, s9.firstChild.data.indexOf("steady"));
    range.setEnd(s11.firstChild, s11.firstChild.data.indexOf("prose") + 5);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    s11.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { ok: true };
  });
  if (r.error) throw new Error(r.error);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[title="Highlight in this colour"] button')?.click());
  await page.waitForTimeout(600);
  m = await measure();
  judge("multiline", m.bands, m.ink, { wash: [5, 9, 10, 11], rule: [8] });
  await shot("4-multiline");

  // 5. zoom — everything must follow the page
  await page.click('[title^="Zoom in"]');
  await page.waitForTimeout(900);
  m = await measure();
  judge("zoom", m.bands, m.ink, { wash: [5, 9, 10, 11], rule: [8] });
  await shot("5-zoom");

  // 6. legacy records: strip position + occurrence, reload. Geometry must
  // still sit on a line of ink; which line is informational — without an
  // occurrence a repeated phrase resolves to its first match, and that is a
  // documented limitation, not a regression.
  await page.waitForTimeout(1200); // let autosave land
  const stateFile = path.join(SESSION, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (const h of state.highlights ?? []) { delete h.position; delete h.occurrence; }
  for (const a of state.annotations ?? []) { delete a.position; delete a.occurrence; }
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await open();
  m = await measure();
  judge("legacy", m.bands, m.ink, null);
  await shot("6-legacy");

  // ── 7. a real paper whose text layer lies (xPU, fetched from Zotero) ──
  // The pathology: invisible spans ride ~half a line below the printed glyphs,
  // so sweeping a printed line selects the line above and copy returns the
  // neighbouring sentence. Calibration must shift the layer onto the ink.
  // Skipped cleanly when Zotero isn't reachable or the paper isn't there.
  try {
    const xpu = path.join(OUT, "band-audit-xpu.pdf");
    const items = await (await fetch("http://127.0.0.1:23119/api/users/0/items?q=xPU&format=json")).json();
    const parent = items.find((i) => i.data?.title?.includes("xPU"));
    if (!parent) throw new Error("paper not in library");
    const kids = await (await fetch(`http://127.0.0.1:23119/api/users/0/items/${parent.key}/children?format=json`)).json();
    const att = kids.find((k) => k.data?.contentType === "application/pdf");
    if (!att) throw new Error("no PDF attachment");
    const head = await fetch(`http://127.0.0.1:23119/api/users/0/items/${att.key}/file`, { redirect: "manual" });
    const loc = head.headers.get("location");
    if (!loc) throw new Error("no file redirect");
    fs.copyFileSync(decodeURIComponent(new URL(loc).pathname), xpu);

    const calibrations = [];
    page.on("console", (m) => { if (m.text().includes("[paper-reader]")) calibrations.push(m.text()); });
    await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
    await page.setInputFiles('input[type="file"][accept=".pdf"]', xpu);
    await page.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 30000 });
    try { await page.click("text=Don't save", { timeout: 3000 }); } catch { /* not offered */ }
    // virtualized pages render on approach — nudge until page 2's layer exists
    for (let tries = 0; tries < 10; tries++) {
      await page.evaluate(() => document.querySelector('.page[data-page-number="2"]')?.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(1200);
      const there = await page.evaluate(() => !!document.querySelector('.page[data-page-number="2"] .textLayer span'));
      if (there) break;
    }
    await page.waitForSelector('.page[data-page-number="2"] .textLayer span', { timeout: 15000 });
    await page.waitForTimeout(2000);

    const probe = await page.evaluate(() => {
      const layer = document.querySelector('.page[data-page-number="2"] .textLayer');
      const span = Array.from(layer.querySelectorAll("span")).find((s) => s.textContent?.includes("end-to-end work"));
      if (!span) return { error: "probe span not found" };
      const r = span.getBoundingClientRect();
      const canvas = document.querySelector('.page[data-page-number="2"] canvas');
      const cr = canvas.getBoundingClientRect();
      const sx = canvas.width / cr.width, sy = canvas.height / cr.height;
      const ctx = canvas.getContext("2d");
      const y0 = Math.max(0, Math.floor((r.top - cr.top - r.height * 1.5) * sy));
      const img = ctx.getImageData(
        Math.floor((r.left - cr.left) * sx), y0,
        Math.ceil(r.width * sx), Math.ceil(r.height * 4 * sy)
      );
      const runs = [];
      for (let row = 0; row < img.height; row++) {
        let ink = 0;
        for (let col = 0; col < img.width; col++) {
          const i = (row * img.width + col) * 4;
          if (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] < 150) ink++;
        }
        const inked = ink > img.width * 0.015;
        const open = runs[runs.length - 1];
        if (inked && open && open.last === row - 1) open.last = row;
        else if (inked) runs.push({ first: row, last: row });
      }
      const top = (r.top - cr.top) * sy - y0;
      let nearest = null;
      for (const run of runs) {
        const d = ((run.first + run.last + 1) / 2 - (top + (r.height * sy) / 2)) / sy;
        if (nearest === null || Math.abs(d) < Math.abs(nearest)) nearest = d;
      }
      // where the span's own ink starts, in viewport px, for the drag below
      const own = runs.reduce((best, run) => {
        const d = Math.abs((run.first + run.last + 1) / 2 - (top + (r.height * sy) / 2));
        return !best || d < best.d ? { d, first: run.first } : best;
      }, null);
      return {
        text: span.textContent.slice(0, 46),
        transform: layer.style.transform || "(none)",
        nearestOffsetPx: nearest === null ? null : +nearest.toFixed(1),
        rect: { left: r.left, width: r.width },
        inkTopViewport: own === null ? null : cr.top + (y0 + own.first) / sy,
      };
    });
    if (probe.error) throw new Error(probe.error);
    console.log(`  span-vs-ink after correction: ${probe.nearestOffsetPx}px`);
    for (const c of calibrations.slice(0, 3)) console.log(" ", c);
    const aligned = probe.nearestOffsetPx !== null && Math.abs(probe.nearestOffsetPx) < 3.5;
    if (!aligned) failures.push(`xpu: layer still ${probe.nearestOffsetPx}px off its glyphs`);
    console.log(`  ${aligned ? " ok " : "FAIL"} xpu layer sits on its glyphs`);

    // the copy bug: drag along the printed glyphs and read what got selected
    if (probe.inkTopViewport !== null) {
      const y = probe.inkTopViewport + 2; // upper part of the printed line — the previous-line trap
      await page.mouse.move(probe.rect.left + 2, y);
      await page.mouse.down();
      await page.mouse.move(probe.rect.left + probe.rect.width * 0.5, y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const got = await page.evaluate(() => window.getSelection()?.toString() ?? "");
      // the drag starts a couple of px in, so the first glyph may be clipped
      const wanted = probe.text.replace(/\s+/g, " ").trim().slice(1, 9);
      const ok = got.replace(/\s+/g, " ").includes(wanted);
      if (!ok) failures.push(`xpu copy: dragging the printed line selected ${JSON.stringify(got.slice(0, 40))}`);
      console.log(`  ${ok ? " ok " : "FAIL"} dragging the printed glyphs selects their own text (${JSON.stringify(got.slice(0, 34))})`);
    }
    fs.rmSync(path.join(ROOT, ".paper-reader-sessions", "band-audit-xpu-pdf"), { recursive: true, force: true });
  } catch (e) {
    console.log(`  xpu scenario skipped: ${e.message}`);
  }

  await browser.close();
  fs.rmSync(SESSION, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n  ` + failures.join("\n  "));
    process.exit(1);
  }
  console.log("\nall bands where they belong; screenshots in band-audit-out/");
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
