import type { ReactElement } from "react";

// File and folder icons for the Workspace — its tree, its tabs, its pickers.
//
// Every file is the same page, tinted and marked by what it holds, the way an
// editor's icon theme tells files apart at a glance: the mark says what kind
// of file it is, the tint which language or format. Folders are two-tone and
// open when their contents show. Drawn on a 16px grid, the size the tree uses,
// so the strokes land on whole pixels there; larger sizes scale.

export type FileKind =
  | "markdown" | "readme" | "pdf" | "json" | "config" | "image" | "code"
  | "shell" | "table" | "tex" | "bib" | "notebook" | "archive" | "text";

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  pdf: "pdf",
  json: "json", jsonl: "json", geojson: "json",
  yaml: "config", yml: "config", toml: "config", ini: "config", cfg: "config", conf: "config", env: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", tif: "image", tiff: "image", avif: "image",
  py: "code", ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code", html: "code", htm: "code",
  css: "code", scss: "code", r: "code", jl: "code", c: "code", h: "code", cpp: "code", hpp: "code", cc: "code",
  rs: "code", go: "code", java: "code", kt: "code", swift: "code", rb: "code", lua: "code", sql: "code", m: "code",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  csv: "table", tsv: "table", xlsx: "table", xls: "table", parquet: "table",
  tex: "tex", sty: "tex", cls: "tex",
  bib: "bib", ris: "bib",
  ipynb: "notebook",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", bz2: "archive", xz: "archive", "7z": "archive",
};

const TINT = {
  blue: "#6aa9f0", coral: "#ef7f6d", amber: "#e3b45c", purple: "#b592ea", teal: "#5ec4b6", green: "#6cc58f",
  yellow: "#e8cf68", orange: "#f0a35c", steel: "#7ab0e0", pink: "#e98fc4", grey: "#97a2ac",
} as const;

const KIND_TINT: Record<FileKind, string> = {
  markdown: TINT.blue, readme: TINT.blue, pdf: TINT.coral, json: TINT.amber, config: TINT.amber,
  image: TINT.purple, code: TINT.steel, shell: TINT.green, table: TINT.green, tex: TINT.teal,
  bib: TINT.teal, notebook: TINT.orange, archive: TINT.grey, text: TINT.grey,
};

// Code wears its language's colour
const EXTENSION_TINT: Record<string, string> = {
  ts: TINT.blue, tsx: TINT.blue, js: TINT.yellow, jsx: TINT.yellow, mjs: TINT.yellow, cjs: TINT.yellow,
  html: TINT.orange, htm: TINT.orange, css: TINT.pink, scss: TINT.pink, r: TINT.blue, jl: TINT.purple,
  rs: TINT.orange, go: TINT.teal, java: TINT.coral, kt: TINT.purple, swift: TINT.orange, rb: TINT.coral, sql: TINT.amber,
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // ".env" is all extension; "Makefile" has none
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** What a file is, as far as its icon goes: by name for a README, else by extension */
export function fileKind(name: string): FileKind {
  if (/^readme(\.|$)/i.test(name)) return "readme";
  return KIND_BY_EXTENSION[extensionOf(name)] ?? "text";
}

export function fileTint(name: string, kind: FileKind = fileKind(name)): string {
  const extension = extensionOf(name);
  // The language's colour only when the name and the kind agree on what it is
  return (KIND_BY_EXTENSION[extension] === kind && EXTENSION_TINT[extension]) || KIND_TINT[kind];
}

// The page, its folded corner, and one mark per kind, inside x 5–11, y 7–12.5
const PAGE = "M5 1.5h4.6l2.9 2.9V13a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 13V3A1.5 1.5 0 0 1 5 1.5z";
const EAR = "M9.6 1.5v2.4c0 .28.22.5.5.5h2.4z";
const DOT = { fill: "currentColor", stroke: "none" } as const;

const MARKS: Record<FileKind, ReactElement> = {
  text: <path d="M5.6 7.6h4.8M5.6 9.85h4.8M5.6 12.1h2.9" />,
  markdown: <path d="M5.1 12.2V7.9l1.55 1.9L8.2 7.9v4.3M10.55 7.9v4.2M9.35 10.95l1.2 1.2 1.2-1.2" />,
  readme: <><circle cx="8" cy="7.35" r=".85" {...DOT} /><path d="M8 9.3v3" /></>,
  // Acrobat's loop, the mark people know a PDF by
  pdf: <path d="M5.45 12.25c1-.65 2.3-2.75 2.85-4.5.28-1 .1-1.6-.33-1.6s-.6.6-.38 1.37c.44 1.6 1.92 3.3 3.02 3.74.6.22.88 0 .77-.33-.11-.38-1.05-.55-2.37-.33-1.32.22-2.85.82-3.56 1.65z" />,
  json: <path d="M7 6.85c-.85 0-1.25.4-1.25 1.2v.7c0 .5-.3.8-.8.8.5 0 .8.3.8.8v.7c0 .8.4 1.2 1.25 1.2M9 6.85c.85 0 1.25.4 1.25 1.2v.7c0 .5.3.8.8.8-.5 0-.8.3-.8.8v.7c0 .8-.4 1.2-1.25 1.2" />,
  config: <path d="M5.4 7.6h3.4M7.1 9.85h3.5M7.1 12.1h2.2" />,
  image: <><circle cx="10.05" cy="7.65" r="1.05" {...DOT} /><path d="M5 12.45l2.3-3.15 1.6 1.8 1.1-1.1 1.75 2.45z" {...DOT} /></>,
  code: <path d="M6.75 7.75 5 9.85l1.75 2.1M9.25 7.75 11 9.85l-1.75 2.1" />,
  shell: <path d="M5.25 7.9 7.2 9.75 5.25 11.6M8.45 11.95h2.6" />,
  table: <path d="M5.2 7.3h5.6v5H5.2zM5.2 9.8h5.6M8 7.3v5" />,
  tex: <path d="M10.8 7.3H5.5l2.6 2.5-2.6 2.5h5.3" />,
  bib: <path d="M6 7.05h4v5.4L8 11.1l-2 1.35z" />,
  notebook: <><circle cx="8" cy="9.75" r=".95" {...DOT} /><path d="M5.2 8.35c1.6-1.2 4-1.2 5.6 0M5.2 11.15c1.6 1.2 4 1.2 5.6 0" /></>,
  archive: <><path d="M8 4.6v.95M8 6.55v.95M8 8.5v.7" /><rect x="6.75" y="9.6" width="2.5" height="2.75" rx=".7" /></>,
};

type IconProps = { size?: number; className?: string };

/** A file's icon, from its name — or from `kind` where the name says nothing (a paper's title) */
export function FileIcon({ name = "", kind, size = 16, className }: IconProps & { name?: string; kind?: FileKind }) {
  const resolved = kind ?? fileKind(name);
  return (
    <svg className={className} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" style={{ color: fileTint(name, resolved) }}>
      <path d={PAGE} fill="currentColor" fillOpacity={0.16} stroke="currentColor" strokeOpacity={0.62} strokeLinejoin="round" />
      <path d={EAR} fill="currentColor" fillOpacity={0.5} />
      <g fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
        {MARKS[resolved]}
      </g>
    </svg>
  );
}

// A darker back with the tab, a lighter front; opening tilts the front forward
const FOLDER_BACK = "M1.5 4A1.5 1.5 0 0 1 3 2.5h3.2c.4 0 .78.16 1.06.44L8.4 4.1H13a1.5 1.5 0 0 1 1.5 1.5v6.9A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z";
const FOLDER_FRONT = "M1.5 6.6c0-.5.4-.9.9-.9h11.2c.5 0 .9.4.9.9v5.9A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z";
const FOLDER_OPEN_FRONT = "M3.4 7.25c.16-.42.56-.7 1.02-.7h10.07c.66 0 1.12.64.9 1.26l-1.55 4.98A1.75 1.75 0 0 1 12.17 14H2.68c-.66 0-1.12-.64-.9-1.26z";

export function FolderIcon({ open = false, size = 16, className }: IconProps & { open?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path d={FOLDER_BACK} fill="#a7843a" />
      <path d={open ? FOLDER_OPEN_FRONT : FOLDER_FRONT} fill="#dcb862" />
      {/* the light catching the front's top edge */}
      {!open && <path d="M2.4 6.25h11.2" stroke="#ecd38a" strokeWidth={0.9} strokeLinecap="round" />}
    </svg>
  );
}
