// Preloaded into the server during tests: answers Google OAuth + Calendar calls in memory.
import http from "node:http";
const events = new Map(); const log = [];
const real = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.startsWith("https://oauth2.googleapis.com/token")) {
    const idt = "x." + Buffer.from(JSON.stringify({ email: "owner@gmail.com" })).toString("base64url") + ".y";
    return J({ access_token: "at", refresh_token: "rt", expires_in: 3600, id_token: idt });
  }
  if (u.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
  if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
    const id = decodeURIComponent(u.split("/events")[1].replace(/^\//, ""));
    const body = opts.body ? JSON.parse(opts.body) : null;
    log.push([opts.method, id, body?.start?.dateTime || ""]);
    if (opts.method === "POST") { const nid = "ev" + (events.size + log.length); events.set(nid, body); return J({ id: nid }); }
    if (!events.has(id)) return J({ error: { message: "Not Found" } }, 404);
    if (opts.method === "PATCH") { events.set(id, body); return J({ id }); }
    if (opts.method === "DELETE") { events.delete(id); return new Response(null, { status: 204 }); }
  }
  return real(url, opts);
};
http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ events: [...events], log })); }).listen(Number(process.env.GMOCK_PORT || 4556));
