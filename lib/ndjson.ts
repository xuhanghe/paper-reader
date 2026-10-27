// Newline-delimited JSON, as every provider stream here speaks it.
//
// A network or pipe chunk ends wherever it ends — often in the middle of a
// line — so a reader has to keep the unfinished tail until the rest of its
// line arrives. Splitting each chunk on its own drops every event that
// straddles two chunks: a word missing from an answer, a session id never
// captured. Every stream reader in the app goes through this one splitter.
//
// Client-safe: no Node imports.

export type LineSplitter = {
  /** Feeds text; calls `onLine` for every complete, non-blank line. */
  push: (text: string) => void;
  /** Flushes a final line that had no newline after it. */
  end: () => void;
};

export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let tail = "";
  return {
    push(text) {
      if (!text) return;
      const lines = (tail + text).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    },
    end() {
      const last = tail;
      tail = "";
      if (last.trim()) onLine(last);
    },
  };
}

/** Feeds a byte stream through a splitter, decoding UTF-8 across chunk boundaries too. */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const splitter = createLineSplitter(onLine);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      splitter.push(decoder.decode(value, { stream: true }));
    }
    splitter.push(decoder.decode());
    splitter.end();
  } finally {
    reader.releaseLock();
  }
}

/** JSON.parse that answers undefined instead of throwing, for lines that may be partial or not JSON at all. */
export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
