// Live updates to every open app (phone, laptop) over Server-Sent Events.
const clients = new Set();

export function sseHandler(req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  const client = { res };
  clients.add(client);
  const beat = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(beat); clients.delete(client); });
}

export function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.res.write(line);
}
