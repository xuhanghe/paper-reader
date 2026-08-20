import { buildTakeawaysPrompt } from "@/lib/prompts";
import { parseTakeaways } from "@/lib/takeaways";
import { completeWith } from "@/lib/providers";

export const runtime = "nodejs";

// Summarises one conversation into a few lines. Deliberately not part of the
// fused per-paper session: a summary is about the conversation, and asking for
// it inside would make the model's own notes part of what it remembers next.
export async function POST(req: Request) {
  const { label, messages, model, effort, custom } = await req.json();

  const history = Array.isArray(messages)
    ? messages
        .filter(
          (m) =>
            (m?.role === "user" || m?.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim()
        )
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }))
    : [];
  // Nothing has been established until something has been answered
  if (!history.some((m) => m.role === "assistant")) {
    return Response.json({ takeaways: [] });
  }

  try {
    const prompt = buildTakeawaysPrompt(typeof label === "string" ? label : "", history);
    const text = await completeWith(model, prompt, { effort, custom });
    return Response.json({ takeaways: parseTakeaways(text) });
  } catch (err) {
    console.error("[takeaways]", err);
    return Response.json({ error: "Could not summarise that conversation." }, { status: 500 });
  }
}
