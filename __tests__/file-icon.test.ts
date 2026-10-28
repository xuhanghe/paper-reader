import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileIcon, FolderIcon, fileKind, fileTint } from "../components/FileIcon";

// The Workspace tells files apart by their icon: the kind picks the mark, the
// extension (for code) the colour.

describe("a file's kind", () => {
  test("comes from its extension, whatever its case", () => {
    assert.equal(fileKind("idea.md"), "markdown");
    assert.equal(fileKind("Paper.PDF"), "pdf");
    assert.equal(fileKind("config.json"), "json");
    assert.equal(fileKind("params.yml"), "config");
    assert.equal(fileKind("plot.png"), "image");
    assert.equal(fileKind("train.py"), "code");
    assert.equal(fileKind("run.sh"), "shell");
    assert.equal(fileKind("results.csv"), "table");
    assert.equal(fileKind("main.tex"), "tex");
    assert.equal(fileKind("refs.bib"), "bib");
    assert.equal(fileKind("eda.ipynb"), "notebook");
    assert.equal(fileKind("data.tar.gz"), "archive");
  });

  test("is a README by name, before its extension", () => {
    assert.equal(fileKind("README.md"), "readme");
    assert.equal(fileKind("readme"), "readme");
    assert.equal(fileKind("READMEFIRST.txt"), "text");
  });

  test("falls back to text for what it does not know", () => {
    assert.equal(fileKind("Makefile"), "text");
    assert.equal(fileKind("notes.txt"), "text");
    assert.equal(fileKind("weights.safetensors"), "text");
    assert.equal(fileKind(""), "text");
  });

  test("of a dot-file is its whole name", () => {
    assert.equal(fileKind(".env"), "config");
  });
});

describe("a file's tint", () => {
  test("is its language's for code, and its kind's otherwise", () => {
    assert.notEqual(fileTint("app.ts"), fileTint("app.js"));
    assert.equal(fileTint("notes.md"), fileTint("README.md"));
  });

  test("follows the kind it is drawn as, not a stray extension in a title", () => {
    assert.equal(fileTint("Learning to rank in foo.ts", "pdf"), fileTint("paper.pdf"));
  });
});

describe("the icons", () => {
  test("are decorative: hidden from assistive technology, sized as asked", () => {
    const file = renderToStaticMarkup(createElement(FileIcon, { name: "idea.md", size: 20 }));
    assert.match(file, /aria-hidden="true"/);
    assert.match(file, /width="20" height="20"/);
    const folder = renderToStaticMarkup(createElement(FolderIcon, { open: true }));
    assert.match(folder, /aria-hidden="true"/);
  });

  test("an open folder is drawn differently from a closed one", () => {
    const closed = renderToStaticMarkup(createElement(FolderIcon, {}));
    const open = renderToStaticMarkup(createElement(FolderIcon, { open: true }));
    assert.notEqual(closed, open);
  });
});
