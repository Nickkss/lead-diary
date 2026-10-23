// AI for the app: one endpoint that either streams plain text or returns parsed JSON.
// The page builds the prompts; the server holds the API key and picks the model.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.AI_MODEL || "claude-opus-5-5";
// Server-side fallback on a refusal is only accepted on some models; keep it opt-out.
const FALLBACK = process.env.AI_FALLBACK !== "off" && /^claude-(opus-5|opus-5-5|fable-5-1|sonnet-5-5)$/.test(MODEL);

let client = null;
export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY;
function getClient() {
  if (!client) client = new Anthropic();   // reads ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL) from the environment
  return client;
}

const JSON_RULE = "Your reply is parsed by a program. Output only the JSON value that was asked for, with no other text.";

function params({ input, tier, json }) {
  const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
  const p = {
    model: MODEL,
    max_tokens: 16000,
    messages,
    output_config: { effort: tier === "quick" ? "low" : "medium" },
  };
  if (json) p.system = JSON_RULE;
  if (FALLBACK) { p.betas = ["server-side-fallback-2026-07-01"]; p.fallbacks = "default"; }
  return p;
}

/* read a JSON value out of a reply: whole text, a fenced block, or first {/[ to last }/] */
export function parseLooseJSON(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw Object.assign(new Error("The AI reply was not valid JSON."), { code: "invalid_json" });
}

function mapError(e) {
  if (e?.code) return { status: 502, code: e.code, message: e.message };
  if (e instanceof Anthropic.AuthenticationError) return { status: 503, code: "ai_key_invalid", message: "The Anthropic API key on the server is not valid." };
  if (e instanceof Anthropic.PermissionDeniedError) return { status: 503, code: "ai_key_invalid", message: "The API key can't use this model." };
  if (e instanceof Anthropic.RateLimitError) return { status: 429, code: "rate_limited", message: "AI is busy. Try again in a minute." };
  if (e instanceof Anthropic.BadRequestError) return { status: 400, code: "invalid_request", message: e.message };
  if (e instanceof Anthropic.APIError) return { status: 502, code: "upstream_error", message: e.message };
  return { status: 502, code: "upstream_error", message: String(e?.message || e) };
}

export async function aiHandler(req, res) {
  if (!aiConfigured()) return res.status(503).json({ code: "ai_not_configured", message: "Add ANTHROPIC_API_KEY to the server's .env file to turn on AI." });
  const { input, tier = "default", json = false } = req.body || {};
  const ok = typeof input === "string" ? input.trim().length > 0
    : Array.isArray(input) && input.length && input.every(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content);
  if (!ok) return res.status(400).json({ code: "invalid_request", message: "Send a prompt string or a list of turns." });
  if (JSON.stringify(input).length > 300_000) return res.status(413).json({ code: "prompt_too_large", message: "That is too much text for one request." });

  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  try {
    const stream = getClient().beta.messages.stream(params({ input, tier, json }), { signal: abort.signal });
    if (json) {
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") return res.status(422).json({ code: "refused", message: "AI declined this request." });
      const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
      if (msg.stop_reason === "max_tokens") return res.status(502).json({ code: "invalid_json", message: "The AI reply was cut short." });
      return res.json({ value: parseLooseJSON(text) });
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    let any = false;
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { any = true; res.write(ev.delta.text); }
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal" && !any) { res.statusCode = 422; res.end("\u0000refused"); return; }
    res.end();
  } catch (e) {
    if (abort.signal.aborted) return;
    const m = mapError(e);
    console.error("[ai]", m.code, m.message);
    if (res.headersSent) { res.end("\u0000" + m.code); return; }   // stream already started: marker the page reads
    res.status(m.status).json({ code: m.code, message: m.message });
  }
}
