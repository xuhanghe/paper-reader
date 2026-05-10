# Paper Reader

A local AI reading companion for academic papers. Open a PDF, select any text or drag over any figure, and get a plain-English explanation with relevant background, context within the paper, and learning resources — all powered by your existing Claude subscription with no extra API keys.

---

## What it does

When you're reading a dense paper and hit something you don't understand, Paper Reader gives you two ways to get help:

**Text selection** — highlight any term, equation, or passage and click "Explain this ↗". You get a structured breakdown:
1. What it means (from scratch, no assumed knowledge)
2. Why it's here (its role in the paper's method or findings)
3. Background you need (prerequisite topics)
4. Learning resources (specific textbook chapters, Wikipedia articles, courses)

**Figure capture** — hold `Alt` and drag a rectangle over any graph, diagram, table, or equation image. You get:
1. How to read it (axes, variables, visual encoding)
2. What it's showing (the actual result or pattern)
3. Why it matters (how it connects to the paper's broader argument)
4. Background and resources

Every explanation is a live conversation — you can ask follow-up questions, and the AI remembers the full context of that annotation thread.

---

## Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| **Node.js** | 18.18+ | v20 or v22 recommended |
| **npm** | 9+ | Comes with Node.js |
| **Claude Code CLI** | latest | Must be installed and authenticated |

### Install Claude Code

If you don't have the Claude Code CLI yet, follow the [official installation guide](https://code.claude.com/docs/en/getting-started).

The short version:

```bash
npm install -g @anthropic-ai/claude-code
```

Then authenticate:

```bash
claude
```

Follow the login prompt. Paper Reader uses your existing Claude subscription — no API key needed. AI calls draw from the same credits as your normal Claude Code usage.

To verify your Claude Code installation is working before running the app:

```bash
claude --version
# Expected output: <version number> (Claude Code)

claude -p "say hi"
# Expected: a short response streamed to your terminal
```

If `claude` is not found, make sure your npm global bin directory is on your PATH:

```bash
# Find where npm installs global binaries
npm bin -g

# Add it to your shell profile if needed (e.g. ~/.bashrc or ~/.zshrc)
export PATH="$(npm bin -g):$PATH"
```

---

## Installation

```bash
# Clone or download the project
cd paper_reader

# Install dependencies
npm install

# Start the development server
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## Getting started

1. Click **Open PDF** in the top-left and choose any PDF file.
2. The paper loads in the left pane. Select some text you want explained.
3. Click **Explain this ↗** in the popover that appears.
4. The explanation streams into the right panel.
5. Ask follow-up questions in the input at the bottom of each explanation card.

---

## Features

### Text explanations
- Select any text in the PDF with your mouse.
- A small popover appears — click **Explain this ↗** or press `Escape` to dismiss.
- The explanation appears as an annotation card on the right, streaming word by word.
- Each card shows the selected text in full (with a "show more / show less" toggle for long passages).
- Click **view in PDF ↩** inside the card to jump back to where the text appears in the document and highlight it.

### Figure / image capture
- Hold `Alt` and drag a rectangle over any figure, graph, diagram, table, or equation.
- Release to capture — the region is sent to Claude Vision for analysis.
- Click the thumbnail in the annotation card header to open the full-size image in a lightbox.
- From the lightbox, click **✦ Explain with AI** to create a new explanation for the same image.

### Follow-up questions
- Each annotation card has its own conversation thread.
- Type a question in the input at the bottom of any card and press `Enter` or click **Ask**.
- Follow-ups reuse the same Claude session — no re-sending of previous content, just the new question.
- Speaker labels: **you** for your messages, **explainer** for Claude's responses.

### Model selector
Choose the Claude model in the top-right of the header:

| Model | Best for |
|---|---|
| **Haiku — fast** | Quick lookups, simple terms |
| **Sonnet — balanced** | Default; good for most explanations |
| **Opus — thorough** | Complex math, dense theory, multi-step figures |

The selected model applies to all new explanations. Changing it mid-session doesn't affect ongoing conversations.

### Concept sidebar
- The collapsible panel on the far right lists every concept explained this session.
- Each entry shows a type badge — amber **Txt** for text selections, purple **Fig** for figures.
- Click any entry to scroll the explanation panel to that annotation.
- Click the header to collapse the sidebar if you need more reading space.

### Session save / load
- Click **Save session** to download a `.json` file containing the PDF and all your annotations and conversations.
- Click **Load session** to restore a previous session — everything comes back exactly as you left it, including the full conversation history.
- Sessions embed the PDF as base64, so the JSON file is self-contained. No need to re-upload the PDF.

### Zoom controls

**PDF pane** — zoom the document itself:
- `Ctrl` + scroll up/down
- `−` / `%` / `+` buttons in the toolbar above the PDF
- The `%` button resets to 100%

**Explanation pane** — adjust the reading font size:
- `Ctrl` + scroll up/down while hovering over the explanation panel
- `−` / `px` / `+` buttons in the toolbar above the explanations
- The `px` button resets to the default size

### Delete annotations
Click the `✕` button in the top-right of any annotation card to remove it. This also removes it from the concept sidebar.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt` + drag | Capture a figure region |
| `Escape` | Dismiss the text selection popover |
| `Enter` (in follow-up box) | Send a follow-up question |
| `Ctrl` + scroll (PDF pane) | Zoom PDF in / out |
| `Ctrl` + scroll (explain pane) | Increase / decrease explanation font size |
| `Escape` (lightbox open) | Close the image lightbox |

---

## How it works

Paper Reader is a local Next.js app. All AI calls go through Next.js Route Handlers on the server side, which spawn the `claude` CLI as a subprocess. The browser never calls Claude directly.

```
Browser (localhost:3000)
    │
    ├── POST /api/explain          → claude -p "..." --output-format stream-json
    ├── POST /api/explain-image    → claude -p "..." --input-format stream-json (base64 image via stdin)
    └── POST /api/followup         → claude -p "..." --resume <session_id>
```

**Streaming** — responses stream token by token. The UI updates in real time as Claude generates.

**Session memory** — the first response for each annotation captures Claude's internal `session_id` from the stream. Follow-up questions use `--resume <session_id>`, so only the new question is sent — not the full history — making follow-ups fast and token-efficient.

**PDF rendering** — `react-pdf` (PDF.js) renders each page with both a canvas layer (for region capture) and a text layer (for native browser text selection).

---

## Project structure

```
paper_reader/
├── app/
│   ├── page.tsx                   # Root layout and orchestration
│   ├── layout.tsx                 # Fonts (Geist + Lora), metadata
│   ├── globals.css                # CSS variables, dark theme, utility classes
│   └── api/
│       ├── explain/route.ts       # Text explanation endpoint
│       ├── explain-image/route.ts # Image explanation endpoint (stdin stream-json)
│       └── followup/route.ts      # Follow-up via --resume
├── components/
│   ├── PdfViewer.tsx              # PDF rendering, text selection, region drag, zoom
│   ├── ExplainPanel.tsx           # Annotation cards, follow-up chat, lightbox
│   ├── ConceptSidebar.tsx         # Collapsible concept list
│   └── SelectionPopover.tsx       # "Explain this ↗" floating button
├── hooks/
│   ├── useSession.ts              # All session state (annotations, PDF, model)
│   ├── useTextSelection.ts        # Captures window.getSelection() inside PDF pane
│   └── useRegionDrag.ts           # Alt+drag → canvas crop → base64 PNG
├── lib/
│   ├── prompts.ts                 # System prompts and prompt builders
│   └── session-utils.ts           # makeLabel() helper
├── types/
│   └── session.ts                 # TypeScript types (Annotation, SessionState, etc.)
└── __tests__/
    ├── prompts.test.ts
    ├── session-utils.test.ts
    └── stream-parser.test.ts
```

---

## Running tests

```bash
npm test
```

Uses Node.js's built-in `node:test` runner with `tsx` for TypeScript. No Jest or additional test framework needed.

---

## TypeScript check

```bash
npx tsc --noEmit
```

---

## Limitations

- **Browser only** — this is a local web app, not a standalone desktop application. The dev server must be running while you use it.
- **`window.find()` for PDF highlighting** — the "view in PDF ↩" feature uses the non-standard `window.find()` API. Works in Chrome and Firefox; not supported in Safari.
- **No OCR** — text selection only works on PDFs with a real embedded text layer. Scanned PDFs won't support text selection, though you can still capture regions as images using Alt+drag.
- **Session file size** — saved sessions embed the full PDF as base64. A 10 MB PDF becomes roughly a 14 MB JSON file.
- **Requires Claude Code CLI** — the `claude` binary must be in your system PATH and authenticated. The app does not use the Anthropic API directly.
