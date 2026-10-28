import path from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeStream, codexStream, customAgentStream, customConfigFor, customStream, opencodeStream, resolveProvider, streamResponse } from "@/lib/providers";
import { conversationsOf, overviewSection, recentExchanges } from "@/lib/endpoint-context";
import { paperTextUpTo, runTool, toolSpecs } from "@/lib/endpoint-tools";
import { effortFor } from "@/lib/model-catalog";
import { createLineSplitter, parseJsonLine } from "@/lib/ndjson";
import { buildSessionBootstrap, buildAskMessage, wantsWholePaper } from "@/lib/prompts";
import {
  appendThread,
  readMindmapFile,
  readState,
  conversationEntries,
  readPaperText,
  hasPaperText,
  paperPathFor,
  pagesDirFor,
  countPageImages,
  readPageImageDataUrl,
  figuresDirFor,
  writeFigureImage,
  readFigureDataUrl,
  lastTurn,
  deleteFromThread,
  conversationTurns,
  furthestPageAsked,
} from "@/lib/session-store";
import { unwrapPartials } from "@/lib/claude-stream";
import { turnMarker } from "@/lib/citations";
import { selectedSkillPaths } from "@/lib/skills";
import { askGist, earlierConversation, earlierConversationSection, freshStartOnLostSession, LOST_SESSION, replayForEndpoint } from "@/lib/session-recovery";
import { decodeCodexSessionId } from "@/lib/codex-runtime";

export const runtime = "nodejs";

// Unified ask endpoint: every question about a paper — selection explains,
// figure captures, general questions, follow-ups — flows through ONE fused
// per-paper conversation. Agentic providers (claude/codex CLIs) bootstrap once
// with the mindmap + a pointer to paper.md (they read it with file tools; claude
// may also use Zotero MCP), then resume natively. Tool-less custom APIs get the
// context inline plus a replay of thread.jsonl.

type TeeOpts = { paperId: string; annotationId?: string; kind?: string; turn?: number };

// Pass the stream through unchanged while accumulating the assistant text,
// then append it to the paper's thread.jsonl
function teeToThread(source: ReadableStream, opts: TeeOpts): ReadableStream {
  const decoder = new TextDecoder();
  let acc = "";
  let resultText = "";
  const lines = createLineSplitter((line) => {
    const ev = parseJsonLine(line) as { type?: string; delta?: { type?: string; text?: string }; message?: { content?: { type?: string; text?: string }[] }; result?: unknown } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      acc += ev.delta.text ?? "";
    } else if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) if (b.type === "text") acc += b.text ?? "";
    } else if (ev?.type === "result" && typeof ev.result === "string") {
      resultText = ev.result;
    }
  });
  let persisted = false;
  const persist = () => {
    if (persisted) return;
    persisted = true;
    const finalText = acc || resultText;
    if (!finalText.trim()) return;
    appendThread(opts.paperId, {
      ts: Date.now(),
      role: "assistant",
      text: finalText,
      kind: opts.kind,
      annotationId: opts.annotationId,
      turn: opts.turn,
    }).catch(() => {});
  };
  // `cancel` is in the streams standard and in Node, but not yet in the
  // TypeScript lib types — declared here rather than dropped
  const transformer: Transformer & { cancel?: () => void } = {
      // The number this ask was given, sent ahead of the answer so the panel
      // can resolve a `turn:N` citation back to the message it points at
      start(controller) {
        if (opts.turn) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "turn", turn: opts.turn }) + "\n"));
        }
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
        lines.push(decoder.decode(chunk as BufferSource, { stream: true }));
      },
      flush() {
        lines.end();
        persist();
      },
      // Stopping an answer cancels this stream, and cancel is not flush — so
      // without this the part that did arrive is shown in the panel and then
      // missing from the thread on disk, which is the copy a reload reads back
      cancel() {
        persist();
      },
  };
  return source.pipeThrough(new TransformStream(transformer));
}

export async function POST(req: Request) {
  const {
    paper_id, paper_title, kind, selected_text, question, page_number, read_up_to, current_page, card_page, replaces_turns,
    image_base64, annotation_id, model, effort, custom, session_id, skills,
  } = await req.json();

  if (!paper_id || typeof paper_id !== "string" || !kind) {
    return new Response("paper_id and kind are required", { status: 400 });
  }

  const provider = resolveProvider(model);
  const conversation = typeof annotation_id === "string" && annotation_id ? annotation_id : undefined;

  const last = await lastTurn(paper_id);
  // An edited question: its old version and what followed it in its
  // conversation are deleted from the thread first, so neither the record
  // nor a replay of it holds them — by conversation, from the edited turn
  // on, so a question there still unnumbered in the panel goes too. The
  // model is not told of the edit.
  const replaced = Array.isArray(replaces_turns) ? replaces_turns.filter((t): t is number => Number.isInteger(t) && t >= 1 && t <= last) : [];
  if (replaced.length) {
    await deleteFromThread(paper_id, conversation
      ? { turns: replaced, conversation, fromTurn: Math.min(...replaced) }
      : { turns: replaced });
  }

  // The thread runs in time order across every conversation about the paper,
  // so when another conversation has been asked in since, the question just
  // before this one is not its own. It names the one it follows on from.
  const turns = conversation ? await conversationTurns(paper_id, conversation) : null;
  const followsOn = turns?.previous && turns.previous.turn !== turns.latest
    ? { turn: turns.previous.turn, gist: askGist(turns.previous.text).gist }
    : undefined;

  // Where the reader is: the page of the card a follow-up is asked in (an
  // opening ask names its passage's page itself), the page in view, and how
  // far they have read — as far as this ask, or any question so far, reached:
  // looking back at page 2 has not unread pages 3 to 6
  const page = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined);
  const inView = page(current_page);
  const cardPage = kind === "followup" ? page(card_page) : undefined;
  const readUpTo = Math.max(page(read_up_to) ?? 0, cardPage ?? 0, inView ?? 0, (await furthestPageAsked(paper_id)) ?? 0) || undefined;

  let message = buildAskMessage({
    kind,
    selectedText: selected_text,
    question,
    pageNumber: page_number,
    readUpTo,
    currentPage: inView,
    cardPage,
    followsOn,
  });
  if (!message.trim() && !image_base64) return new Response("empty request", { status: 400 });

  // Web access is a capability of the reader, not a per-message mode. Agentic
  // providers always keep it available; custom HTTP endpoints have no tool
  // channel, so they remain grounded in the supplied paper context.
  if (provider !== "custom") {
    message += "\n\nLive web search is available. Use it whenever current or external information would improve the answer, and cite the sources you rely on.";
  }
  const skillPaths = await selectedSkillPaths(skills);
  if (provider !== "custom" && skillPaths.length) {
    message += `\n\nUse these user-selected skills when relevant. Read each SKILL.md completely before following it:\n${skillPaths.map((file) => `- ${file}`).join("\n")}`;
  }

  // Every ask is numbered, and the number travels on the message itself: on a
  // resumed session the bootstrap explaining the scheme is thousands of tokens
  // behind, but the marker is right there in front of the model
  const turn = last + 1;
  message = `${turnMarker(turn)} ${message}`;

  // Captured figures are stored once as files; the thread references the file
  // so history stays complete without re-sending image bytes on replays
  const figureFile = image_base64 ? await writeFigureImage(paper_id, String(image_base64)) : null;

  // What a custom endpoint is sent of this conversation is read BEFORE this
  // question is appended to it
  const ownEntries = provider === "custom" && conversation ? await conversationEntries(paper_id, conversation) : [];
  appendThread(paper_id, {
    ts: Date.now(),
    role: "user",
    text: message,
    kind,
    annotationId: annotation_id,
    hasImage: !!image_base64,
    imageFile: figureFile ?? undefined,
  }).catch(() => {});

  const requestedSession = typeof session_id === "string" && session_id ? session_id : undefined;
  const codexResumeId = provider === "codex" ? decodeCodexSessionId(requestedSession) : undefined;
  const isResume = provider !== "custom" && !!requestedSession && (provider !== "codex" || !!codexResumeId);

  // The first message of a provider session carries the bootstrap header —
  // and, when this paper has been talked about before, the record of that
  // conversation, so a provider whose own memory of it is gone (Claude Code
  // drops transcripts after 30 days; an id was lost; this is another
  // provider) goes on from the app's record. See lib/session-recovery.
  // opencode runs without file tools, so it can't open paper.md itself the
  // way the CLIs do — it gets the text inline instead, and the recent part
  // of the record rather than a pointer to its file.
  const agentic = provider !== "opencode";
  const freshPrompt = async (): Promise<string> => {
    const mindmap = await readMindmapFile(paper_id);
    const pagesCount = agentic ? await countPageImages(paper_id) : 0;
    const header = buildSessionBootstrap({
      title: typeof paper_title === "string" ? paper_title : "the paper",
      mindmapJson: mindmap ? JSON.stringify(mindmap) : undefined,
      paperPath: agentic && (await hasPaperText(paper_id)) ? paperPathFor(paper_id) : undefined,
      pagesDir: pagesCount > 0 ? pagesDirFor(paper_id) : undefined,
      pagesCount,
      figuresDir: agentic ? figuresDirFor(paper_id) : undefined,
      agentic,
      paperTextInline: agentic ? undefined : ((await readPaperText(paper_id)) || "").slice(0, 24000),
    });
    const earlier = await earlierConversation(paper_id, { beforeTurn: turn });
    const record = earlier ? `\n\n${earlierConversationSection(earlier, { agentic })}` : "";
    return `${header}${record}\n\n---\n\n${message}`;
  };
  let prompt = message;
  if (!isResume && provider !== "custom") prompt = await freshPrompt();

  const teeOpts: TeeOpts = { paperId: paper_id, annotationId: annotation_id, kind, turn };
  const base64Data = image_base64 ? String(image_base64).replace(/^data:image\/\w+;base64,/, "") : null;

  if (provider === "codex") {
    let images: string[] | undefined;
    let cleanup: (() => void) | undefined;
    if (base64Data) {
      const tmpPath = path.join(tmpdir(), `paper-reader-fig-${Date.now()}.png`);
      writeFileSync(tmpPath, Buffer.from(base64Data, "base64"));
      images = [tmpPath];
      cleanup = () => { try { unlinkSync(tmpPath); } catch {} };
    }
    // A session Codex no longer has is started again, seeded from the record
    const resumed = codexStream(prompt, { images, model, effort, resumeId: codexResumeId });
    return streamResponse(
      teeToThread(
        freshStartOnLostSession(resumed, async () => codexStream(await freshPrompt(), { images, model, effort }), LOST_SESSION.codex, cleanup),
        teeOpts
      )
    );
  }

  if (provider === "opencode") {
    const opencodeOpts = {
      images: image_base64 ? [{ mime: "image/png", dataUrl: String(image_base64) }] : undefined,
      model,
      effort,
      webSearch: true,
      title: typeof paper_title === "string" ? paper_title : undefined,
    };
    const resumed = opencodeStream(prompt, { ...opencodeOpts, resumeId: isResume ? session_id : undefined });
    return streamResponse(
      teeToThread(
        freshStartOnLostSession(resumed, async () => opencodeStream(await freshPrompt(), opencodeOpts), LOST_SESSION.opencode),
        teeOpts
      )
    );
  }

  if (provider === "custom") {
    // A saved endpoint, read here with its key; see lib/endpoints
    const cfg = await customConfigFor(model, custom);
    if (!cfg) return new Response("custom API is not configured", { status: 400 });
    const vision = !!cfg.vision;
    const wholePaper = wantsWholePaper(typeof question === "string" ? question : undefined);
    const mindmap = await readMindmapFile(paper_id);
    const conversations = conversationsOf(await readState(paper_id), conversation);

    // The question, with its figure and, for a model that reads images, the
    // page it is about — and the pages either side, when it has no tools to
    // look further itself
    const ask = async (tools: boolean) => {
      if (!vision) {
        // Text-only model: never send image payloads
        return { role: "user", content: image_base64 ? `${message}\n\n(A figure was attached, but this model is text-only — answer from the paper text and conversation context.)` : message };
      }
      const content: unknown[] = [];
      if (image_base64) content.push({ type: "image_url", image_url: { url: image_base64 } });
      if (typeof page_number === "number") {
        for (const n of tools ? [page_number] : [page_number - 1, page_number, page_number + 1]) {
          const img = await readPageImageDataUrl(paper_id, n);
          if (img) content.push({ type: "image_url", image_url: { url: img } });
        }
      }
      content.push({ type: "text", text: message });
      return { role: "user", content: content.length > 1 ? content : message };
    };
    // The paper's map and its conversations with what each worked out, then
    // this conversation's latest exchanges as they were had — its figures as
    // images, never paths — then the question. With tools the paper is read
    // on demand; without, the pages up to mine go inline.
    const build = async (tools: boolean) => {
      const header = buildSessionBootstrap({
        title: typeof paper_title === "string" ? paper_title : "the paper",
        mindmapJson: mindmap ? JSON.stringify(mindmap) : undefined,
        agentic: false,
        tools: tools ? { vision } : undefined,
        paperTextInline: tools ? undefined : paperTextUpTo((await readPaperText(paper_id)) || "", wholePaper ? undefined : readUpTo, 24000),
      });
      const overview = overviewSection(conversations, { tools });
      const history = await replayForEndpoint(recentExchanges(ownEntries, tools ? 12000 : 20000), {
        vision,
        annotationId: conversation,
        readFigure: (ref) => readFigureDataUrl(paper_id, ref),
      });
      return [{ role: "system", content: overview ? `${header}\n\n${overview}` : header }, ...history, await ask(tools)];
    };

    const config = { ...cfg, effort: effortFor(model, effort) };
    if (cfg.tools === false) return streamResponse(teeToThread(customStream(config, await build(false)), teeOpts));
    const toolContext = { paperId: paper_id, readUpTo, wholePaper, vision, conversations };
    const tools = { specs: toolSpecs({ vision }), run: (name: string, args: unknown) => runTool(name, args, toolContext) };
    return streamResponse(teeToThread(customAgentStream(config, await build(true), tools, () => build(false)), teeOpts));
  }

  // claude CLI. A session the CLI no longer has — its transcript cleaned up,
  // the id stale — is started again, seeded from the record; the failed start
  // is never shown
  let stderr = "";
  const runClaude = (text: string, resume: boolean) =>
    claudeStream(text, {
      model,
      effort,
      resumeId: resume ? session_id : undefined,
      imageBase64: base64Data,
      onStderr: (chunk) => { stderr = (stderr + chunk).slice(-2000); },
      signal: req.signal,
    });
  const stream = freshStartOnLostSession(runClaude(prompt, isResume), async () => runClaude(await freshPrompt(), false), (output) => LOST_SESSION.claude(output, stderr));
  return streamResponse(teeToThread(unwrapPartials(stream), teeOpts));
}
