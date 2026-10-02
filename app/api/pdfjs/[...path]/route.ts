import type { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

// pdf.js's own font and CMap files, served from the installed package.
//
// Safari draws glyphs from paths rather than registering every embedded font
// subset with the document (see PdfViewer) — and a PDF that does not embed a
// font then needs pdf.js's stand-in for it, the Foxit and Liberation files
// under `standard_fonts/`. CMaps are what CJK documents without embedded
// encodings need to map their codes to glyphs at all. Both are read from
// pdfjs-dist here, so the files never have to be copied anywhere, and both
// are immutable: pdf.js keys them by its own version. The package is found
// from the working directory: the bundler rewrites a require.resolve of it
// into a path of its own that is not on disk.
const PACKAGE_ROOT = path.join(process.cwd(), "node_modules", "pdfjs-dist");
const DIRECTORIES: Record<string, { dir: string; names: RegExp; type: (name: string) => string }> = {
  "standard-fonts": {
    dir: path.join(PACKAGE_ROOT, "standard_fonts"),
    names: /^[A-Za-z0-9-]+\.(pfb|ttf)$/,
    type: (name) => (name.endsWith(".ttf") ? "font/ttf" : "application/octet-stream"),
  },
  cmaps: {
    dir: path.join(PACKAGE_ROOT, "cmaps"),
    names: /^[A-Za-z0-9-]+\.bcmap$/,
    type: () => "application/octet-stream",
  },
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  const [kind, name, ...rest] = parts ?? [];
  const where = kind ? DIRECTORIES[kind] : undefined;
  if (!where || !name || rest.length > 0 || !where.names.test(name)) {
    return new Response("not found", { status: 404 });
  }
  try {
    const bytes = await readFile(path.join(where.dir, name));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": where.type(name),
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
