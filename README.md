# Paper Reader

A local reading companion for papers, built around your Zotero library. Open a
PDF or a saved web snapshot, highlight as you read, and ask questions about the
passage in front of you — answered by a model that has the whole paper, your
highlights, and the rest of the conversation already in hand.

Everything runs on your machine. Papers are read from Zotero, highlights are
written back to Zotero, and the conversation lives in a plain-text file next to
the paper.

> A fork of [aditya-adiga/paper-reader](https://github.com/aditya-adiga/paper-reader),
> substantially rewritten: Zotero as the store, one fused conversation per paper,
> a paper map, HTML snapshot reading, and four interchangeable model providers.
> MIT, same as upstream.

---

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Setup](#setup)
- [Providers](#providers)
- [Configuration](#configuration)
- [How it fits together](#how-it-fits-together)
- [Project layout](#project-layout)
- [Development](#development)
- [Known gaps](#known-gaps)
- [License](#license)

---

## What you get

**Read from your library.** Browse Zotero collections in the left sidebar and
open any attachment — PDFs and HTML snapshots both. Papers open zero-copy: the
document is fetched from Zotero rather than duplicated into the session, and the
reload button re-reads it so you always see the current file.

Items can also be removed from the sidebar, after a confirmation step. They go
to Zotero's **trash**, not into thin air — the API's outright delete has no way
back, and neither would a stray click. Restore anything from Zotero's own trash.

**Highlight, and mean it.** Select a passage and pick one of Zotero's eight
annotation colours, with or without a note. For PDFs there is exactly one copy
of that highlight and it lives in Zotero — recolour it, edit its note or delete
it here and Zotero changes; do the same in Zotero and the reader follows. Delete
one in Zotero and it disappears here rather than lingering.

Highlights are drawn as smooth per-line bands snapped to the actual ink on the
page, not to the PDF text layer — which sits several pixels below the glyphs and
made the native selection look ragged and misaligned. Selections use Zotero's own
`#71ADFD` at the alpha its reader uses, so the two look identical.

**One conversation per paper.** Every question — explaining a selection, asking
about a figure, a follow-up, a question from the map — goes into a single thread
for that paper, resumed by session id on each ask. Ask about section 3 an hour
later and the model still knows what you asked about section 2.

The conversations in the panel are one workspace rather than separate chats:
select any passage in any of them and **❝ Quote** carries it into your next
question, whichever conversation you ask it in. Hold several at once and each
gets a label — `[1]`, `[2]` — shown on its chip and sent to the model, so a
question can say *"why does [1] contradict [2]?"* and be answered precisely.
Clicking a chip drops its label at the cursor. An answer streaming in can be
stopped, and a question already asked can be rewritten and sent again.

Once a passage has been used, the link stays walkable in both directions. The
passage is underlined in blue where it was originally written, and clicking it
jumps to the question that quoted it; the question shows the passage as a chip,
and clicking that goes back. Either end unfolds a folded conversation on the way.
None of it is stored separately — a question keeps the passages it carried inside
its own text, so the links are read back out of threads that already exist.

**Answers that point at things.** When the model draws on the paper it links
the passage — the words it quoted, underlined, with the page after them — and
clicking lands on those words in the document, not the top of the page. When it
builds on something already settled it links that instead of repeating it, and
clicking goes back to the question it means. A pointer that resolves to nothing
is rendered as plain words rather than a link that goes nowhere.

**Concepts you can write in.** The Concepts tab holds what each conversation
actually established — a few lines per conversation, written by the model when
you open the tab rather than after every answer. They are notes, not output:
rewrite a line, add one, empty one to drop it. Once you have edited a list the
automatic pass leaves it alone, and only an explicit ↻ replaces your words.

**A map of the paper.** A generated outline grounded in verbatim quotes, each of
which jumps to its passage. Alongside it, a notes column listing every highlight
and Zotero note: click one to land on the passage itself — not the top of its
page — and to open a box for writing a note straight back into Zotero. Click a
highlight in the paper and the matching entry reveals itself.

**Figures.** Click the capture button — or hold `Alt` — and drag a box over any
chart, table or diagram to ask about it directly.

**Web pages.** Paste a URL to read a page in the reader, with the same highlight
layer, and save it to Zotero as a snapshot if you want to keep it.

---

## Requirements

| | | |
|---|---|---|
| **Node.js** | 20+ | Required by Next.js 16; 22 recommended |
| **Zotero** | 7 | With the local API enabled — see below |
| **A provider** | one of | `claude` CLI, `codex` CLI, `opencode`, or any OpenAI/Anthropic-compatible endpoint |

Zotero is optional in the sense that you can still open a local PDF or a URL
without it, but the library, highlight sync and notes all need it.

---

## Setup

```bash
npm install
npm run dev          # http://localhost:3000
```

**Enable Zotero's local API.** In Zotero: *Settings → Advanced → Allow other
applications on this computer to communicate with Zotero*. This is what lets the
reader list your collections and fetch attachments. It is read-only.

**Add an API key for writing highlights.** The local API cannot write, so
annotations go through zotero.org and sync back down. Create a key at
[zotero.org/settings/keys](https://www.zotero.org/settings/keys) with library
read/write access, then:

```bash
echo 'ZOTERO_API_KEY=your-key-here' >> .env.local
```

Without the key everything still works, but highlights stay local to the session
instead of becoming real Zotero annotations.

**Optional — give the model your library.** If the `zotero-mcp` server is
installed, the three CLI providers get it automatically and can search your
library while answering. It is configured per invocation from `.env.local`, so
your global `claude`/`codex`/`opencode` configs are left alone. If the binary
isn't there, nothing changes.

---

## Providers

Pick one per paper from the model dropdown; each keeps its own conversation.

| Provider | How it runs | Notes |
|---|---|---|
| **Claude** (Haiku / Sonnet / Opus / Fable) | `claude` CLI | Reads the paper text from disk as a file, so long papers cost nothing extra per turn |
| **Codex** | `codex` CLI | Same agentic file access |
| **OpenCode** | headless HTTP server | Started on first use, adopted if already running, shut down when idle and on exit |
| **Custom API** | direct HTTP | Speaks OpenAI *or* Anthropic — pick the format in the dialog |

The 🌐 toggle turns on web search where the provider supports it. Reasoning
effort is selectable for everything except Custom API.

OpenCode gets a full lifecycle rather than a spawn per question: `opencode run`
hung indefinitely on one of two trivial probes during testing, which would have
left the panel spinning forever behind a stuck child process. The server form
makes hangs recoverable — there is a timeout and an explicit abort endpoint.

---

## Configuration

All optional, in `.env.local`:

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Required to write highlights back to Zotero |
| `ZOTERO_API_URL` | `http://127.0.0.1:23119/api/users/0` | Local Zotero API |
| `ZOTERO_CONNECTOR_URL` | `http://127.0.0.1:23119` | Used when saving pages to Zotero |
| `ZOTERO_USER_ID` | auto-detected | Your zotero.org user id |
| `ZOTERO_MCP_BIN` | `~/.local/bin/zotero-mcp` | Where `zotero-mcp` lives |
| `CLAUDE_BIN` / `CODEX_BIN` / `OPENCODE_BIN` | looked up on `PATH` | Point at a CLI explicitly when the server's `PATH` can't find it |
| `OPENCODE_PORT` | `4599` | Port for the headless server |
| `OPENCODE_MODEL` | server default | `provider/model` override |
| `OPENCODE_IDLE_MS` | `900000` | Shut the server down after this long idle |
| `OPENCODE_TIMEOUT_MS` | `180000` | Give up on a single answer after this long |

---

## How it fits together

Each paper gets a directory under `.paper-reader-sessions/`, keyed by its Zotero
item key so it survives renames:

```
.paper-reader-sessions/<zotero-key>/
  state.json      UI state — highlights, annotation cards, preferences
  paper.md        extracted text, written once; agentic providers read it from disk
  pages/          per-page JPEGs, for questions about figures
  figures/        regions you captured, stored once rather than re-sent
  mindmap.json    the paper map
  thread.jsonl    the conversation, append-only
```

Keeping the paper text out of `state.json` is what makes the agentic providers
work: they read `paper.md` as a file instead of having the whole document
re-injected into every prompt.

Nothing inside a session directory records where the project lives — figure
references in `thread.jsonl` are stored relative to the session — so the folder
can be moved, renamed or copied to another machine and the threads keep
working. Absolute paths exist only transiently, in the prompt handed to a CLI
that has to open the file.

Highlights are matched to the page by text, ignoring whitespace entirely on both
sides — necessary because a browser selection and a PDF text layer rarely agree
about it. CJK text gives every character its own span and Chrome inserts line
breaks where the DOM has none, so `暮易\nIntro` has to match `暮易Intro`. The same
matcher paints highlights into HTML snapshots inside their iframe.

---

## Project layout

```
app/
  page.tsx              the reader — panels, session, highlight and Zotero wiring
  api/ask/              the one endpoint every question goes through
  api/zotero/           library, attachments, notes, annotations
  api/sessions/         per-paper state
  api/paper/            text extraction and page snapshots
  api/mindmap/          paper map generation
  api/takeaways/        one conversation, summarised
  api/fetch-page/       reading a URL
components/
  PdfViewer.tsx         pdf.js viewer, ink-snapped bands, region capture
  HtmlViewer.tsx        sandboxed snapshot reader with the same highlight layer
  MindmapSidebar.tsx    paper map and notes column
  ZoteroLibrary.tsx     collection browser
  ExplainPanel.tsx      the conversation
lib/
  highlight-dom.ts      whitespace-insensitive passage matching and painting
  providers.ts          claude / codex / opencode / custom
  opencode-server.ts    headless server lifecycle
  mcp-config.ts         Zotero MCP, rendered per provider
  session-store.ts      the per-paper directory layout
  zotero-server.ts      local + web Zotero APIs
```

---

## Development

```bash
npm test             # node:test, no watch mode
npx tsc --noEmit     # types
npm run lint
npm run build
```

Tests cover the parts worth protecting: passage matching and painting (against a
real DOM via jsdom, including snapshots with inline `<script>` blocks), both
custom wire formats against a stand-in server, provider dispatch, and MCP config
rendering. There is also `scripts/opencode-lifecycle-check.ts`, which asserts the
headless server starts once, is reused, restarts after an external kill, and
leaves no orphan.

---

## Known gaps

Worth knowing before you rely on them:

- **Highlights on HTML snapshots stay local.** They persist per paper and repaint
  on reload, but they are not written to Zotero. Zotero stores snapshot
  annotations with a different position format, and guessing it would put
  malformed items in your library.
- **The Anthropic custom-endpoint format has only been tested against a local
  mock**, not a live Anthropic-compatible service.
- **Custom API endpoints get no tools** — no Zotero MCP, no web search. That
  needs a server-side tool-calling loop the CLI providers get for free.
- **Stopping an answer does not un-write it.** The text that arrived is kept
  and saved, and the provider's own child process is killed, but the CLIs
  record what they had already generated in their server-side session — so the
  next turn may refer to a passage you never saw.
- **A citation is only as exact as the model made it.** The link text has to be
  copied from the paper verbatim to be found on the page; when the model
  paraphrases it instead, the click still takes you to the cited page, but
  nothing is highlighted there.
- **Rewriting a question cannot un-ask it.** The CLI providers keep their own
  history server-side and are resumed by session id, so the model still
  remembers the original wording and reads the edit as a correction. The panel
  shows only the edited version.
- **A trashed item can reappear in the sidebar until Zotero syncs.** The list is
  read from the local Zotero API but the trashing goes through zotero.org, so ↻
  before the sync lands will show it again. The sidebar says so when it happens.
- **`/api/explain`, `/api/explain-image` and `/api/followup` are dead.** Nothing
  calls them since everything moved to `/api/ask`; they are still in the build.

---

## License

MIT — see [LICENSE](LICENSE). Copyright remains with the original author of the
project this is forked from.
