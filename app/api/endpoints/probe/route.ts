import { getEndpoint, normalizeBaseUrl } from "@/lib/endpoints";
import { parseEndpointModels, probeEndpointModels } from "@/lib/model-catalog";
import { customComplete } from "@/lib/providers";
import { isModelId } from "@/lib/model-spec";

export const runtime = "nodejs";

// The endpoint dialog's "Load models" and "Test": tries an endpoint as typed,
// before it is saved. For an endpoint being edited the saved key is used when
// none is typed, so it never has to come back to the browser.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const saved = await getEndpoint(body.id);
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!baseUrl) return Response.json({ ok: false, error: "Enter a base URL starting with http:// or https://." }, { status: 400 });
  const format = body.format === "anthropic" ? "anthropic" : "openai";
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : saved?.apiKey ?? "";
  const started = Date.now();
  try {
    const models = parseEndpointModels(await probeEndpointModels({ baseUrl, apiKey, format }), { id: saved?.id ?? "new", vision: body.vision === true });
    return Response.json({ ok: true, models: models.map(({ id, label, vision, efforts }) => ({ id, label, vision, efforts })), ms: Date.now() - started });
  } catch (error) {
    const status = (error as { status?: number }).status;
    // Some servers have no model list at all: then the test is one tiny
    // question to the model that was typed
    if ((status === 404 || status === 405) && isModelId(body.model)) {
      try {
        const reply = await customComplete({ baseUrl, apiKey, format, model: body.model, maxTokens: 16 }, [{ role: "user", content: "Reply with the single word: ready" }]);
        return Response.json({ ok: true, models: [], answered: reply.slice(0, 80), ms: Date.now() - started });
      } catch (second) {
        return Response.json({ ok: false, error: second instanceof Error ? second.message : String(second) });
      }
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
