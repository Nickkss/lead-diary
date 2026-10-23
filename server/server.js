// Lead Diary server: login, lead storage with live sync, AI, Google Calendar and phone reminders.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allLeads, getLead, putLead, deleteLead, getSettings, putSettings } from "./db.js";
import { hasOwner, setupCode, setPassword, startSession, endSession, isAuthed, requireAuth, throttled, checkPassword } from "./auth.js";
import { kvGet } from "./db.js";
import { sseHandler, broadcast } from "./bus.js";
import { aiHandler, aiConfigured } from "./ai.js";
import * as google from "./google.js";
import * as push from "./push.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT || 3000);
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join("; "));
  next();
});

/* fields the server owns; the page can't overwrite them */
const SERVER_FIELDS = ["calEventId", "calKey", "calErr", "pushedFor"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const calRelevant = (a, b) => ["nextAt", "status", "name", "company"].some(k => (a?.[k] ?? "") !== (b?.[k] ?? ""));
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/* ---------- auth ---------- */
app.get("/api/session", (req, res) => res.json({ authed: isAuthed(req), needsSetup: !hasOwner() }));
app.post("/api/setup", (req, res) => {
  if (hasOwner()) return res.status(409).json({ code: "already_set_up", message: "The app is already set up. Sign in instead." });
  if (throttled(req)) return res.status(429).json({ code: "rate_limited", message: "Too many tries. Wait 10 minutes." });
  const { code, password } = req.body || {};
  if (String(code || "").trim() !== setupCode()) return res.status(403).json({ code: "bad_code", message: "That setup code is wrong. It was shown at the end of the install." });
  if (String(password || "").length < 8) return res.status(400).json({ code: "weak_password", message: "Use at least 8 characters." });
  setPassword(String(password)); startSession(req, res); res.json({ ok: true });
});
app.post("/api/login", (req, res) => {
  if (throttled(req)) return res.status(429).json({ code: "rate_limited", message: "Too many tries. Wait 10 minutes." });
  if (!checkPassword(String(req.body?.password || ""), kvGet("owner"))) return res.status(401).json({ code: "bad_password", message: "Wrong password." });
  startSession(req, res); res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { endSession(req, res); res.json({ ok: true }); });
app.post("/api/password", requireAuth, (req, res) => {
  const { current, password } = req.body || {};
  if (!checkPassword(String(current || ""), kvGet("owner"))) return res.status(401).json({ code: "bad_password", message: "Your current password is wrong." });
  if (String(password || "").length < 8) return res.status(400).json({ code: "weak_password", message: "Use at least 8 characters." });
  setPassword(String(password)); startSession(req, res); res.json({ ok: true });
});

/* ---------- data ---------- */
app.use("/api", (req, res, next) => (req.path.startsWith("/google/callback") ? next() : requireAuth(req, res, next)));

const serverInfo = () => ({ ai: aiConfigured(), google: google.googleStatus(), push: { publicKey: push.publicKey(), devices: push.subCount() }, tz: process.env.TZ || "Asia/Kolkata" });
app.get("/api/state", (req, res) => res.json({ leads: allLeads(), settings: getSettings(), server: serverInfo() }));
app.get("/api/events", sseHandler);

app.put("/api/leads/:id", (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id) || !isObj(req.body)) return res.status(400).json({ code: "invalid_argument" });
  const prev = getLead(id) || {};
  const data = { ...req.body };
  SERVER_FIELDS.forEach(k => { if (k in prev) data[k] = prev[k]; else delete data[k]; });
  putLead(id, data); broadcast({ t: "lead", id, data });
  if (calRelevant(prev, data)) google.queueSync(id);
  res.json({ ok: true });
});
app.patch("/api/leads/:id", (req, res) => {
  const { id } = req.params, prev = getLead(id);
  if (!prev) return res.status(404).json({ code: "invalid_argument", message: "That lead no longer exists." });
  if (!isObj(req.body)) return res.status(400).json({ code: "invalid_argument" });
  const patch = { ...req.body }; SERVER_FIELDS.forEach(k => delete patch[k]);
  const data = { ...prev, ...patch };
  putLead(id, data); broadcast({ t: "lead", id, data });
  if (calRelevant(prev, data)) google.queueSync(id);
  res.json({ ok: true });
});
app.delete("/api/leads/:id", async (req, res) => {
  const { id } = req.params, prev = getLead(id);
  const removed = await google.deleteEventFor(prev);
  deleteLead(id); broadcast({ t: "del", id });
  res.json({ ok: true, calendarRemoved: removed });
});
app.put("/api/settings", (req, res) => {
  if (!isObj(req.body)) return res.status(400).json({ code: "invalid_argument" });
  const prev = getSettings();
  putSettings(req.body); broadcast({ t: "settings", data: getSettings() });
  const c0 = prev.calendar, c1 = getSettings().calendar;
  if (c0.reminder !== c1.reminder || c0.duration !== c1.duration || c0.enabled !== c1.enabled) google.syncAll();
  res.json({ ok: true });
});

app.get("/api/export.json", (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="lead-diary-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: "lead-diary", version: 1, exportedAt: new Date().toISOString(), settings: getSettings(), leads: allLeads() });
});
app.post("/api/import", (req, res) => {
  const { leads, settings, replaceSettings } = req.body || {};
  if (!Array.isArray(leads)) return res.status(400).json({ code: "invalid_argument", message: "This file has no leads list." });
  let added = 0, updated = 0;
  for (const raw of leads) {
    if (!isObj(raw)) continue;
    const { id, ...data } = raw;
    if (!ID_RE.test(String(id || ""))) continue;
    SERVER_FIELDS.forEach(k => delete data[k]);
    const prev = getLead(id);
    if (prev && (prev.updatedAt || "") >= (data.updatedAt || "")) continue;   // keep the newer copy
    putLead(id, { ...data, ...(prev ? Object.fromEntries(SERVER_FIELDS.filter(k => k in prev).map(k => [k, prev[k]])) : {}) });
    prev ? updated++ : added++;
  }
  if (isObj(settings) && (replaceSettings || !getSettings().categories.length)) putSettings(settings);
  broadcast({ t: "reload" }); google.syncAll();
  res.json({ ok: true, added, updated });
});

/* ---------- AI ---------- */
app.post("/api/ai", aiHandler);

/* ---------- Google Calendar ---------- */
app.get("/api/google/connect", (req, res) => {
  if (!google.googleConfigured()) return res.status(503).send("Google Calendar isn't set up on the server yet. See README: Google Calendar.");
  res.redirect(google.connectUrl());
});
app.get("/api/google/callback", async (req, res) => {
  if (!isAuthed(req)) return res.redirect("/?google=signin");
  try { await google.handleCallback(req.query); broadcast({ t: "server", data: serverInfo() }); res.redirect("/?google=connected"); }
  catch (e) { console.error("[google]", e.message); res.redirect("/?google=error&msg=" + encodeURIComponent(e.message)); }
});
app.post("/api/google/disconnect", async (req, res) => { await google.disconnect(); broadcast({ t: "server", data: serverInfo() }); res.json({ ok: true }); });
app.post("/api/cal/retry/:id", (req, res) => {
  const l = getLead(req.params.id); if (!l) return res.status(404).json({ code: "invalid_argument" });
  putLead(req.params.id, { ...l, calErr: l.calErr || "retry" });
  google.queueSync(req.params.id).then(() => res.json({ ok: true }));
});

/* ---------- push ---------- */
app.post("/api/push/subscribe", (req, res) => {
  try { push.subscribe(req.body?.subscription, req.body?.device); broadcast({ t: "server", data: serverInfo() }); res.json({ ok: true }); }
  catch { res.status(400).json({ code: "invalid_argument" }); }
});
app.post("/api/push/unsubscribe", (req, res) => { push.unsubscribe(String(req.body?.endpoint || "")); res.json({ ok: true }); });
app.post("/api/push/test", async (req, res) => res.json({ sent: await push.sendAll({ title: "Lead Diary", body: "Notifications are working on this device.", url: "/", tag: "test" }) }));

/* ---------- app ---------- */
app.use("/api", (req, res) => res.status(404).json({ code: "not_found" }));
app.use(express.static(PUBLIC, {
  setHeaders(res, file) {
    if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=604800");
  },
}));
app.get("*", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

setInterval(() => push.tick().catch(e => console.error("[push tick]", e.message)), 30000);

app.listen(PORT, () => {
  console.log(`Lead Diary running on port ${PORT} (${process.env.PUBLIC_URL || "no PUBLIC_URL set"})`);
  if (!hasOwner()) console.log(`\n  First-time setup code: ${setupCode()}\n  Open the app and enter this code to create your password.\n`);
  console.log(`  AI: ${aiConfigured() ? "on (" + (process.env.AI_MODEL || "claude-opus-5-5") + ")" : "off - add ANTHROPIC_API_KEY"} · Google Calendar: ${google.googleConfigured() ? "ready" : "not set up"}`);
});
