// Google Calendar: each team member connects their own Google account (OAuth, offline access).
// Every open lead with a follow-up date gets one event in its owner's calendar; the server keeps it in step.
import crypto from "node:crypto";
import { kvGet, kvSet, kvDel, getLead, putLead, allLeads, getSettings } from "./db.js";
import { broadcast } from "./bus.js";
import { adminId } from "./auth.js";

const ID = process.env.GOOGLE_CLIENT_ID, SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TZ = process.env.TZ || "Asia/Kolkata";
const redirectUri = () => `${(process.env.PUBLIC_URL || "").replace(/\/$/, "")}/api/google/callback`;
const SCOPE = "openid email https://www.googleapis.com/auth/calendar.events";
const OPEN = s => s !== "won" && s !== "lost";
const key = uid => "google:" + uid;

export const googleConfigured = () => !!(ID && SECRET && process.env.PUBLIC_URL);
export function googleStatus(uid) {
  const t = kvGet(key(uid));
  return { configured: googleConfigured(), connected: !!t?.refresh_token, email: t?.email || "" };
}
export const connectedUsers = (uids) => uids.filter(u => !!kvGet(key(u))?.refresh_token);

export function connectUrl(uid) {
  const state = crypto.randomBytes(16).toString("hex");
  kvSet("google_state:" + state, { uid, exp: Date.now() + 10 * 6e4 });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({ client_id: ID, redirect_uri: redirectUri(), response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
  return u.toString();
}

async function tokenRequest(body) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ID, client_secret: SECRET, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error || "Google token error"), { status: r.status, gcode: j.error });
  return j;
}

export async function handleCallback(query, uid) {
  const st = kvGet("google_state:" + query.state); kvDel("google_state:" + query.state);
  if (!st || st.exp < Date.now() || st.uid !== uid) throw new Error("The Google sign-in link expired. Try again.");
  if (query.error) throw new Error("Google sign-in was cancelled.");
  const t = await tokenRequest({ code: query.code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  let email = "";
  try { email = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email || ""; } catch {}
  const prev = kvGet(key(uid)) || {};
  kvSet(key(uid), { refresh_token: t.refresh_token || prev.refresh_token, access_token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000, email });
  syncAll();
}

export async function disconnect(uid) {
  const t = kvGet(key(uid));
  if (t?.refresh_token) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t.refresh_token), { method: "POST" }).catch(() => {});
  kvDel(key(uid));
  // events in that calendar can no longer be updated; forget them so they're recreated if the person reconnects
  for (const l of allLeads()) if (l.calUser === uid) save(l.id, { calEventId: "", calKey: "", calUser: "", calErr: "" });
}

async function accessToken(uid) {
  const t = kvGet(key(uid));
  if (!t?.refresh_token) return null;
  if (t.access_token && t.exp > Date.now()) return t.access_token;
  try {
    const n = await tokenRequest({ refresh_token: t.refresh_token, grant_type: "refresh_token" });
    kvSet(key(uid), { ...t, access_token: n.access_token, exp: Date.now() + (n.expires_in - 60) * 1000 });
    return n.access_token;
  } catch (e) {
    if (e.gcode === "invalid_grant") kvSet(key(uid), { ...t, refresh_token: "", access_token: "" });
    throw Object.assign(new Error("Google Calendar was disconnected. Connect it again in Settings."), { kind: "auth" });
  }
}

async function gcal(uid, method, path, body) {
  const token = await accessToken(uid);
  if (!token) throw Object.assign(new Error("Google Calendar isn't connected for this person."), { kind: "auth" });
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events" + path, {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || "Google Calendar error " + r.status), { status: r.status });
  return j;
}

const pad = n => String(n).padStart(2, "0");
const localStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

function eventBody(l, s) {
  const cat = (s.categories || []).find(c => c.id === l.category)?.name || "No category";
  const start = new Date(l.nextAt), end = new Date(start.getTime() + (Number(s.calendar.duration) || 15) * 6e4);
  const last = (l.notes || [])[0];
  const digits = String(l.phone || "").replace(/\D/g, ""), wa = digits.length >= 10 ? "https://wa.me/" + (digits.length === 10 ? "91" + digits : digits) : "";
  const app = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/?open=${encodeURIComponent(l.id)}` : "";
  const lines = [l.company && `Company: ${l.company}`, l.phone && `Phone: ${l.phone}`, `Category: ${cat}`, `Stage: ${l.status}`,
    l.need && `Needs: ${l.need}`, last && `Last update (${last.type}): ${last.text}`, wa && `WhatsApp: ${wa}`, app && `Open in Lead Diary: ${app}`].filter(Boolean);
  return {
    summary: `Follow up: ${l.name}${l.company ? " · " + l.company : ""}`,
    description: lines.join("\n"),
    start: { dateTime: localStr(start), timeZone: TZ },
    end: { dateTime: localStr(end), timeZone: TZ },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: Number(s.calendar.reminder) || 0 }] },
  };
}

function save(id, patch) {
  const cur = getLead(id); if (!cur) return;
  const next = { ...cur, ...patch };
  putLead(id, next); broadcast({ t: "lead", id, data: next });
}

const queues = new Map();
/* one sync at a time per lead; always reads the latest copy */
export function queueSync(id) {
  if (!googleConfigured()) return Promise.resolve();
  const p = (queues.get(id) || Promise.resolve()).then(() => syncLead(id)).catch(() => {});
  queues.set(id, p);
  return p;
}

async function removeEvent(uid, eventId) {
  try { await gcal(uid, "DELETE", "/" + encodeURIComponent(eventId)); }
  catch (e) { if (e.status !== 404 && e.status !== 410 && e.kind !== "auth") throw e; }
}

async function syncLead(id) {
  const l = getLead(id); if (!l) return;
  const s = getSettings(), owner = l.owner || adminId();
  const ownerConnected = !!kvGet(key(owner))?.refresh_token;
  const wants = OPEN(l.status) && !!l.nextAt && ownerConnected;
  if (wants && !s.calendar.enabled) return;                    // sync off: never create or move events
  const k = wants ? [owner, l.nextAt, l.name, l.company, l.status, s.calendar.reminder, s.calendar.duration].join("|") : "";
  if (k === (l.calKey || "") && !l.calErr) return;
  try {
    if (l.calEventId && l.calUser && l.calUser !== owner) {      // lead moved to someone else: take it out of the old calendar
      await removeEvent(l.calUser, l.calEventId);
      save(id, { calEventId: "", calUser: "" });
      return syncLead(id);
    }
    if (wants) {
      const body = eventBody({ ...l, id }, s);
      if (l.calEventId) {
        try { await gcal(owner, "PATCH", "/" + encodeURIComponent(l.calEventId), body); return save(id, { calKey: k, calErr: "", calUser: owner }); }
        catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }   // deleted in Calendar: make a new one
      }
      const ev = await gcal(owner, "POST", "", body);
      save(id, { calEventId: ev.id || "", calUser: owner, calKey: k, calErr: "" });
    } else if (l.calEventId) {
      await removeEvent(l.calUser || owner, l.calEventId);
      save(id, { calEventId: "", calUser: "", calKey: "", calErr: "" });
    } else if (l.calKey || l.calErr) save(id, { calKey: "", calErr: "" });
  } catch (e) {
    console.error("[calendar]", id, e.message);
    save(id, { calErr: e.kind === "auth" ? e.message : "Couldn't update Google Calendar: " + e.message.slice(0, 140) });
  }
}

/* remove an event when its lead is deleted */
export async function deleteEventFor(lead) {
  if (!lead?.calEventId) return true;
  try { await removeEvent(lead.calUser || lead.owner || adminId(), lead.calEventId); return true; }
  catch { return false; }
}

export function syncAll() {
  for (const l of allLeads()) if ((OPEN(l.status) && l.nextAt) || l.calEventId) queueSync(l.id);
}
