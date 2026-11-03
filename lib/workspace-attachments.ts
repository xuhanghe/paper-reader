// Images attached to a question for the workspace agent, kept as files in the
// workspace rather than in the browser: the chat is saved in localStorage,
// whose few megabytes a handful of screenshots would fill — and a save that
// fails there loses the conversation since. On disk they are also there for
// the agent, which works in this folder, to open again later. The folder is
// hidden, so neither the file tree nor the agent's file list shows it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageExtension, MAX_ATTACHED_IMAGES, parseImageDataUrl } from "./message-images";
import { resolveWorkspaceFile, validateWorkspaceRoot } from "./workspace-files";

export const ATTACHMENTS_DIR = ".paper-reader/attachments";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Names never collide, though several images of one question are written in
// the same millisecond
let count = 0;

/** Saves images (data URLs) into the workspace; returns their workspace paths, in order. */
export async function saveAttachments(rootValue: string, dataUrls: string[]): Promise<string[]> {
  const root = await validateWorkspaceRoot(rootValue);
  const dir = path.join(root, ...ATTACHMENTS_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  const saved: string[] = [];
  for (const url of dataUrls.slice(0, MAX_ATTACHED_IMAGES)) {
    const image = parseImageDataUrl(url);
    if (!image || !MIME[imageExtension(image.mime)]) continue;
    const name = `image-${Date.now()}-${process.pid}-${++count}.${imageExtension(image.mime)}`;
    await writeFile(path.join(dir, name), Buffer.from(image.base64, "base64"));
    saved.push(`${ATTACHMENTS_DIR}/${name}`);
  }
  return saved;
}

export type Attachment = { path: string; file: string; mime: string; dataUrl: string };

/**
 * Attached images by their workspace paths, read back for the model. Only
 * images in the attachments folder are read: a path from the request never
 * reaches anything else in the workspace, or outside it.
 */
export async function readAttachments(rootValue: string, paths: unknown): Promise<Attachment[]> {
  if (!Array.isArray(paths)) return [];
  const read: Attachment[] = [];
  for (const value of paths.slice(0, MAX_ATTACHED_IMAGES)) {
    if (typeof value !== "string" || !value.startsWith(`${ATTACHMENTS_DIR}/`)) continue;
    try {
      const { file, relative } = await resolveWorkspaceFile(rootValue, value);
      if (path.dirname(relative) !== ATTACHMENTS_DIR) continue;
      const mime = MIME[path.extname(file).slice(1).toLowerCase()];
      if (!mime) continue;
      const bytes = await readFile(file);
      read.push({ path: relative, file, mime, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
    } catch {
      // gone, or never there: the question goes without it
    }
  }
  return read;
}
