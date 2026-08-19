// The claude CLI reports text twice: as `stream_event` wrappers while it is
// being written, and again as a whole `assistant` message once each block is
// finished. The panel speaks the Anthropic event shape, so the wrappers are
// unwrapped into `content_block_delta` events it already understands, and a
// finished block is dropped once its text has been delivered that way.
//
// Reading a message only when it is complete is what made a stopped answer
// come back empty — the reply was written, just never sent. Dropping is
// conditional rather than unconditional so a CLI that emits no partials at all
// still comes through, whole, exactly as before.
type CliBlock = { type?: string; text?: string };
type CliEvent = {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: CliBlock[] };
};

export function unwrapPartials(source: ReadableStream): ReadableStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  let streamed = "";

  const handle = (line: string, out: (s: string) => void) => {
    let ev: CliEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      out(line);
      return;
    }

    if (ev.type === "stream_event") {
      const inner = ev.event;
      if (inner?.type === "message_start") streamed = "";
      if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
        const text = String(inner.delta.text ?? "");
        streamed += text;
        out(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }));
      }
      // Thinking deltas and block bookkeeping are not the answer
      return;
    }

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      const content = ev.message.content.filter(
        (b) => !(b?.type === "text" && typeof b.text === "string" && streamed.includes(b.text))
      );
      if (content.length === 0) return;
      out(JSON.stringify({ ...ev, message: { ...ev.message, content } }));
      return;
    }

    out(line);
  };

  return source.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        carry += decoder.decode(chunk as BufferSource, { stream: true });
        const lines = carry.split("\n");
        carry = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) handle(line, (t) => controller.enqueue(encoder.encode(t + "\n")));
        }
      },
      flush(controller) {
        if (carry.trim()) handle(carry, (t) => controller.enqueue(encoder.encode(t + "\n")));
      },
    })
  );
}
