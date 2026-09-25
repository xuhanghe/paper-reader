import path from "path";

// Where the reader keeps what it makes: sessions, workspaces, skills, the
// .env.local it reads. Started from a shell that is the working directory,
// as it always was. Packaged as an app the working directory is the app's
// own server folder, which is read-only and lost on update, so the app sets
// PAPER_READER_HOME to a folder of the reader's choosing instead.
export const HOME = process.env.PAPER_READER_HOME?.trim() || process.cwd();

export const homePath = (...parts: string[]) => path.join(HOME, ...parts);
