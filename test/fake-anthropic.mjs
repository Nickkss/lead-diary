// Stand-in for the Anthropic Messages API (streaming), used only by the tests.
import http from "node:http";
const answers = p => {
  if (p.includes("You read a new sales lead")) return JSON.stringify({ name: "Sunita Rao", company: "BioGen Labs", phone: "+91 98765 11111", email: "", category: "LIMS", source: "Instagram ad", need: "LIMS for 3 labs", value: 400000, temp: "hot", followUp: "2030-01-15T15:00", note: "Wants LIMS for three labs.", details: "", req: { modules: ["Sample management"], sites: "3 labs" } });
  if (p.includes("clean CRM entry")) return JSON.stringify({ type: "Call", note: "Spoke. Demo on Monday 4 PM.", status: "demo", followUp: "2030-01-20T16:00", temp: "hot", value: 200000, need: "", req: { users: "25" } });
  if (p.includes("close deals")) return JSON.stringify({ summary: "Interested.", next: "Confirm demo.", message: "Hi Sunita, confirming the demo." });
  return "1. Sunita Rao — demo — confirm\nTip: call hot leads first.";
};
export function startFakeAnthropic(port) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const j = JSON.parse(body || "{}"); calls.push({ url: req.url, headers: req.headers, body: j });
      const prompt = j.messages.map(m => typeof m.content === "string" ? m.content : "").join("\n");
      const text = answers(prompt);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (let i = 0; i < text.length; i += 20) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 20) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
      ev("message_stop", {});
      res.end();
    });
  });
  srv.listen(port);
  return { calls, close: () => srv.close() };
}
