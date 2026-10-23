// Lead Diary server: team logins, lead storage with live sync, permissions, activity log, AI, Google Calendar and phone reminders.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allLeads, getLead, putLead, deleteLead, getSettings, putSettings, logActivity, recentActivity } from "./db.js";
import {
  hasUsers, setupCode, finishSetup, createUser, updateUser, listUsers, getUser, checkLogin, setUserPassword, migrateSingleOwner,
  startSession, endSession, sessionUser, requireAuth, requireAdmin, throttled, adminId,
} from "./auth.js";
import { sseHandler, broadcast } from "./bus.js";
import { aiHandler, aiConfigured } from "./ai.js";
import * as google from "./google.js";
import * as push from "./push.js";

migrateSingleOwner();

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
const SERVER_FIELDS = ["calEventId", "calKey", "calErr", "calUser", "pushedFor", "createdBy", "updatedBy"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPEN = s => s !== "won" && s !== "lost";
const STAGES = { new: "New", contacted: "Contacted", interested: "Interested", demo: "Demo", proposal: "Proposal", hold: "On hold", won: "Won", lost: "Lost" };
const calRelevant = (a, b) => ["nextAt", "status", "name", "company", "owner"].some(k => (a?.[k] ?? "") !== (b?.[k] ?? ""));
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const isAdmin = u => u?.role === "admin";
const ownerOf = l => l?.owner || adminId();
const nameOf = id => getUser(id)?.name || "someone";
const publicUsers = () => listUsers().map(({ id, name, role, active }) => ({ id, name, role, active }));
const fail = (res, status, code, message) => res.status(status).json({ code, message });
const fmtWhen = s => { const d = new Date(s); if (isNaN(d)) return s; let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${d.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]}, ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`; };

/* new updates are signed with the author; earlier updates can't be changed except by an admin */
function stampNotes(prevNotes, nextNotes, user) {
  if (!Array.isArray(nextNotes)) return { error: "Updates must be a list." };
  const added = nextNotes.length - prevNotes.length;
  if (!isAdmin(user)) {
    if (added < 0) return { error: "You can't remove updates." };
    const tail = nextNotes.slice(added).map(({ by, ...n }) => n), was = prevNotes.map(({ by, ...n }) => n);
    if (JSON.stringify(tail) !== JSON.stringify(was)) return { error: "You can't change updates that are already saved." };
    return { notes: [...nextNotes.slice(0, added).map(n => ({ ...n, by: user.id })), ...prevNotes], added };
  }
  return { notes: nextNotes.map((n, i) => (i < Math.max(added, 0) ? { ...n, by: n.by && getUser(n.by) ? n.by : user.id } : n)), added };
}

function describe(prev, next) {
  const bits = [], added = (next.notes || []).length - (prev.notes || []).length;
  for (const n of (next.notes || []).slice(0, Math.max(0, added))) bits.push(`logged ${n.type}${n.text ? ": " + String(n.text).slice(0, 90) : ""}`);
  if (prev.status !== next.status) bits.push(`moved to ${STAGES[next.status] || next.status}`);
  if ((prev.nextAt || "") !== (next.nextAt || "") && OPEN(next.status)) bits.push(next.nextAt ? `set the follow-up to ${fmtWhen(next.nextAt)}` : "cleared the follow-up");
  if ((prev.owner || "") !== (next.owner || "") && prev.owner) bits.push(`assigned it to ${nameOf(next.owner)}`);
  if (["name", "company", "phone", "email", "category", "source", "need", "value", "req", "temp"].some(k => JSON.stringify(prev[k] ?? "") !== JSON.stringify(next[k] ?? ""))) bits.push("edited the details");
  if ((prev.prio || "") !== (next.prio || "") && next.prioBy !== "ai") bits.push(next.prio ? `set priority to ${next.prio}` : "set priority to automatic");
  return bits.join(" · ");
}
function record(user, id, lead, detail) {
  if (!detail) return;
  broadcast({ t: "activity", item: logActivity(user.id, id, lead?.name, detail) });
}

/* ---------- sign-in ---------- */
app.get("/api/session", (req, res) => {
  const u = sessionUser(req);
  res.json({ authed: !!u, needsSetup: !hasUsers(), user: u ? { id: u.id, name: u.name, username: u.username, role: u.role } : null });
});
app.post("/api/setup", (req, res) => {
  if (hasUsers()) return fail(res, 409, "already_set_up", "The app is already set up. Sign in instead.");
  if (throttled(req)) return fail(res, 429, "rate_limited", "Too many tries. Wait 10 minutes.");
  const { code, name, username, password } = req.body || {};
  if (String(code || "").trim() !== setupCode()) return fail(res, 403, "bad_code", "That setup code is wrong. It was shown at the end of the install.");
  try {
    const u = createUser({ name, username, password, role: "admin" });
    finishSetup(); startSession(req, res, u.id); res.json({ ok: true });
  } catch (e) { fail(res, 400, e.code || "invalid_argument", e.message); }
});
app.post("/api/login", (req, res) => {
  if (throttled(req)) return fail(res, 429, "rate_limited", "Too many tries. Wait 10 minutes.");
  const u = checkLogin(req.body?.username, String(req.body?.password || ""));
  if (!u) return fail(res, 401, "bad_password", "Wrong username or password.");
  startSession(req, res, u.id); res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { endSession(req, res); res.json({ ok: true }); });

/* ---------- everything below needs a signed-in user ---------- */
app.get("/api/google/callback", async (req, res) => {
  const u = sessionUser(req);
  if (!u) return res.redirect("/?google=signin");
  try { await google.handleCallback(req.query, u.id); broadcast({ t: "server" }); res.redirect("/?google=connected"); }
  catch (e) { console.error("[google]", e.message); res.redirect("/?google=error&msg=" + encodeURIComponent(e.message)); }
});
app.use("/api", requireAuth);

app.post("/api/password", (req, res) => {
  const { current, password } = req.body || {};
  if (!checkLogin(req.user.username, String(current || ""))) return fail(res, 401, "bad_password", "Your current password is wrong.");
  try { setUserPassword(req.user.id, password); startSession(req, res, req.user.id); res.json({ ok: true }); }
  catch (e) { fail(res, 400, e.code || "invalid_argument", e.message); }
});

const serverInfo = user => ({
  ai: aiConfigured(), google: google.googleStatus(user.id),
  push: { publicKey: push.publicKey(), devices: push.subCount(user.id) }, tz: process.env.TZ || "Asia/Kolkata",
  me: { id: user.id, name: user.name, username: user.username, role: user.role },
  calendarPeople: google.connectedUsers(listUsers().map(u => u.id)),
});
app.get("/api/state", (req, res) => res.json({ leads: allLeads(), settings: getSettings(), users: publicUsers(), server: serverInfo(req.user) }));
app.get("/api/server", (req, res) => res.json(serverInfo(req.user)));
app.get("/api/events", sseHandler);
app.get("/api/activity", (req, res) => res.json({ items: recentActivity(Math.min(Number(req.query.limit) || 80, 300), req.query.user || null) }));

/* ---------- team (admin) ---------- */
app.get("/api/users", requireAdmin, (req, res) => res.json({ users: listUsers() }));
app.post("/api/users", requireAdmin, (req, res) => {
  try { const u = createUser(req.body || {}); broadcast({ t: "users", data: publicUsers() }); logActivity(req.user.id, null, "", `added ${u.name} to the team`); res.json({ user: u }); }
  catch (e) { fail(res, 400, e.code || "invalid_argument", e.message); }
});
app.patch("/api/users/:id", requireAdmin, (req, res) => {
  try {
    const { name, role, active, password } = req.body || {};
    const u = updateUser(req.params.id, { name, role, active, password });
    broadcast({ t: "users", data: publicUsers() }); if (u.id === req.user.id) broadcast({ t: "server" }); res.json({ user: u });
  } catch (e) { fail(res, e.code === "not_found" ? 404 : 400, e.code || "invalid_argument", e.message); }
});

/* ---------- leads ---------- */
app.put("/api/leads/:id", (req, res) => {
  const { id } = req.params, user = req.user;
  if (!ID_RE.test(id) || !isObj(req.body)) return fail(res, 400, "invalid_argument", "Bad lead.");
  const prev = getLead(id);
  if (prev && !isAdmin(user)) return fail(res, 403, "not_your_lead", "That lead already exists.");
  const data = { ...req.body };
  SERVER_FIELDS.forEach(k => { if (prev && k in prev) data[k] = prev[k]; else delete data[k]; });
  if (!prev) {
    data.createdBy = user.id;
    data.owner = isAdmin(user) && data.owner && getUser(data.owner) ? data.owner : user.id;
    data.notes = (Array.isArray(data.notes) ? data.notes : []).map(n => ({ ...n, by: user.id }));
  }
  data.updatedBy = user.id;
  putLead(id, data); broadcast({ t: "lead", id, data });
  record(user, id, data, prev ? describe(prev, data) : `added the lead${data.owner !== user.id ? " for " + nameOf(data.owner) : ""}`);
  if (calRelevant(prev, data)) google.queueSync(id);
  res.json({ ok: true });
});
app.patch("/api/leads/:id", (req, res) => {
  const { id } = req.params, user = req.user, prev = getLead(id);
  if (!prev) return fail(res, 404, "invalid_argument", "That lead no longer exists.");
  if (!isObj(req.body)) return fail(res, 400, "invalid_argument", "Bad update.");
  const patch = { ...req.body }; SERVER_FIELDS.forEach(k => delete patch[k]);
  if (!isAdmin(user)) {
    const mine = ownerOf(prev) === user.id;
    const extra = Object.keys(patch).filter(k => !["notes", "updatedAt"].includes(k));
    if (!mine && extra.length) return fail(res, 403, "not_your_lead", `Only ${nameOf(ownerOf(prev))} or an admin can change this lead. You can still add an update.`);
    if ("owner" in patch && patch.owner !== prev.owner) return fail(res, 403, "admin_only", "Only an admin can assign leads.");
  } else if ("owner" in patch && !getUser(patch.owner)) return fail(res, 400, "invalid_argument", "Pick a person from the team.");
  if ("notes" in patch) {
    const r = stampNotes(prev.notes || [], patch.notes, user);
    if (r.error) return fail(res, 403, "notes_locked", r.error);
    patch.notes = r.notes;
  }
  const data = { ...prev, ...patch, updatedBy: user.id };
  putLead(id, data); broadcast({ t: "lead", id, data });
  record(user, id, data, describe(prev, data));
  if (calRelevant(prev, data)) google.queueSync(id);
  res.json({ ok: true });
});
app.delete("/api/leads/:id", requireAdmin, async (req, res) => {
  const { id } = req.params, prev = getLead(id);
  const removed = await google.deleteEventFor(prev);
  deleteLead(id); broadcast({ t: "del", id });
  if (prev) record(req.user, id, prev, "deleted the lead");
  res.json({ ok: true, calendarRemoved: removed });
});

/* ---------- settings (admin) ---------- */
app.put("/api/settings", requireAdmin, (req, res) => {
  if (!isObj(req.body)) return fail(res, 400, "invalid_argument", "Bad settings.");
  const prev = getSettings();
  putSettings(req.body); broadcast({ t: "settings", data: getSettings() });
  const c0 = prev.calendar, c1 = getSettings().calendar;
  if (c0.reminder !== c1.reminder || c0.duration !== c1.duration || c0.enabled !== c1.enabled) google.syncAll();
  res.json({ ok: true });
});

app.get("/api/export.json", requireAdmin, (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="lead-diary-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: "lead-diary", version: 2, exportedAt: new Date().toISOString(), settings: getSettings(), users: publicUsers(), leads: allLeads() });
});
app.post("/api/import", requireAdmin, (req, res) => {
  const { leads, settings, replaceSettings } = req.body || {};
  if (!Array.isArray(leads)) return fail(res, 400, "invalid_argument", "This file has no leads list.");
  let added = 0, updated = 0;
  for (const raw of leads) {
    if (!isObj(raw)) continue;
    const { id, ...data } = raw;
    if (!ID_RE.test(String(id || ""))) continue;
    ["calEventId", "calKey", "calErr", "calUser", "pushedFor"].forEach(k => delete data[k]);
    if (!data.owner || !getUser(data.owner)) data.owner = req.user.id;
    if (!data.createdBy || !getUser(data.createdBy)) data.createdBy = data.owner;
    data.notes = (data.notes || []).map(n => ({ ...n, by: n.by && getUser(n.by) ? n.by : data.owner }));
    const prev = getLead(id);
    if (prev && (prev.updatedAt || "") >= (data.updatedAt || "")) continue;   // keep the newer copy
    putLead(id, { ...data, ...(prev ? Object.fromEntries(["calEventId", "calKey", "calUser", "pushedFor"].filter(k => k in prev).map(k => [k, prev[k]])) : {}) });
    prev ? updated++ : added++;
  }
  if (isObj(settings) && (replaceSettings || !getSettings().categories.length)) putSettings(settings);
  broadcast({ t: "reload" }); google.syncAll();
  logActivity(req.user.id, null, "", `restored a backup (${added} new, ${updated} updated)`);
  res.json({ ok: true, added, updated });
});

/* ---------- AI ---------- */
app.post("/api/ai", aiHandler);

/* ---------- Google Calendar (each person connects their own) ---------- */
app.get("/api/google/connect", (req, res) => {
  if (!google.googleConfigured()) return res.status(503).send("Google Calendar isn't set up on the server yet. See README: Google Calendar.");
  res.redirect(google.connectUrl(req.user.id));
});
app.post("/api/google/disconnect", async (req, res) => { await google.disconnect(req.user.id); broadcast({ t: "server" }); res.json({ ok: true }); });
app.post("/api/cal/retry/:id", (req, res) => {
  const l = getLead(req.params.id); if (!l) return fail(res, 404, "invalid_argument", "That lead no longer exists.");
  putLead(req.params.id, { ...l, calErr: l.calErr || "retry" });
  google.queueSync(req.params.id).then(() => res.json({ ok: true }));
});

/* ---------- push (per person) ---------- */
app.post("/api/push/subscribe", (req, res) => {
  try { push.subscribe(req.body?.subscription, req.body?.device, req.user.id); res.json({ ok: true }); }
  catch { fail(res, 400, "invalid_argument", "Bad subscription."); }
});
app.post("/api/push/unsubscribe", (req, res) => { push.unsubscribe(String(req.body?.endpoint || "")); res.json({ ok: true }); });
app.post("/api/push/test", async (req, res) => res.json({ sent: await push.sendTo(req.user.id, { title: "Lead Diary", body: "Notifications are working on this device.", url: "/", tag: "test" }) }));

/* ---------- app ---------- */
app.use("/api", (req, res) => fail(res, 404, "not_found", "Not found."));
app.use(express.static(PUBLIC, {
  setHeaders(res, file) {
    if (/(index\.html|sw\.js|manifest\.webmanifest|runtime\.js)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=604800");
  },
}));
app.get("*", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

setInterval(() => push.tick().catch(e => console.error("[push tick]", e.message)), 30000);

app.listen(PORT, () => {
  console.log(`Lead Diary running on port ${PORT} (${process.env.PUBLIC_URL || "no PUBLIC_URL set"})`);
  if (!hasUsers()) console.log(`\n  First-time setup code: ${setupCode()}\n  Open the app and enter this code to create the admin account.\n`);
  console.log(`  AI: ${aiConfigured() ? "on (" + (process.env.AI_MODEL || "claude-opus-5-5") + ")" : "off - add ANTHROPIC_API_KEY"} · Google Calendar: ${google.googleConfigured() ? "ready" : "not set up"}`);
});
