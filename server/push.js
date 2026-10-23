// Phone notifications (Web Push). Works on iPhone once the app is added to the Home Screen (iOS 16.4+).
// Each person gets reminders for the leads they own.
import webpush from "web-push";
import { db, kvGet, kvSet, allLeads, getLead, putLead, getSettings } from "./db.js";
import { broadcast } from "./bus.js";
import { adminId, listUsers } from "./auth.js";

let keys = kvGet("vapid");
if (!keys) { keys = webpush.generateVAPIDKeys(); kvSet("vapid", keys); }
webpush.setVapidDetails((process.env.PUBLIC_URL || "").startsWith("https://") ? process.env.PUBLIC_URL : "mailto:owner@lead-diary.app", keys.publicKey, keys.privateKey);

export const publicKey = () => keys.publicKey;
const OPEN = s => s !== "won" && s !== "lost";

export function subscribe(sub, device, userId) {
  if (!sub?.endpoint || !sub?.keys) throw new Error("bad subscription");
  db.prepare("INSERT INTO push_subs (endpoint, data, device, created_at, user_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data, device = excluded.device, user_id = excluded.user_id")
    .run(sub.endpoint, JSON.stringify(sub), String(device || "").slice(0, 120), new Date().toISOString(), userId);
}
export function unsubscribe(endpoint) { db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint); }
export const subCount = userId => (userId
  ? db.prepare("SELECT COUNT(*) n FROM push_subs WHERE user_id = ?").get(userId)
  : db.prepare("SELECT COUNT(*) n FROM push_subs").get()).n;

export async function sendTo(userId, payload) {
  const subs = db.prepare("SELECT endpoint, data FROM push_subs WHERE user_id = ?").all(userId);
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification(JSON.parse(s.data), JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint); else console.error("[push]", e.statusCode, e.body || e.message); }
  }));
  return sent;
}

const pad = n => String(n).padStart(2, "0");
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = d => { let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; };

/* every 30 seconds: remind owners about follow-ups that are due, and send each person's morning summary once a day */
export async function tick(now = new Date()) {
  if (!subCount()) return;
  const s = getSettings(), before = (Number(s.calendar.reminder) || 0) * 6e4, fallback = adminId();
  const leads = allLeads();
  for (const l of leads) {
    if (!OPEN(l.status) || !l.nextAt || l.pushedFor === l.nextAt) continue;
    const due = new Date(l.nextAt).getTime() - before;
    if (isNaN(due) || now.getTime() < due) continue;
    if (now.getTime() - due > 6 * 3600e3) { mark(l.id, l.nextAt); continue; }   // too old to be useful
    const last = (l.notes || [])[0];
    await sendTo(l.owner || fallback, {
      title: `Follow up: ${l.name}${l.company ? " · " + l.company : ""}`,
      body: `${timeStr(new Date(l.nextAt))}${last ? " · Last: " + String(last.text || last.type).slice(0, 90) : " · Not contacted yet"}`,
      url: `/?open=${encodeURIComponent(l.id)}`, tag: "lead-" + l.id,
    });
    mark(l.id, l.nextAt);
  }
  const hour = Number(s.digestHour);
  if (hour >= 0 && now.getHours() === hour && kvGet("digestDay") !== dayKey(now)) {
    kvSet("digestDay", dayKey(now));
    for (const u of listUsers().filter(u => u.active)) {
      const open = leads.filter(l => OPEN(l.status) && (l.owner || fallback) === u.id);
      const today = open.filter(l => l.nextAt && dayKey(new Date(l.nextAt)) === dayKey(now)).length;
      const missed = open.filter(l => l.nextAt && new Date(l.nextAt) < now && dayKey(new Date(l.nextAt)) !== dayKey(now)).length;
      const noDate = open.filter(l => !l.nextAt).length;
      if (!today && !missed && !noDate) continue;
      const bits = [today && `${today} due today`, missed && `${missed} missed`, noDate && `${noDate} without a date`].filter(Boolean);
      await sendTo(u.id, { title: `Good morning, ${u.name.split(" ")[0]}`, body: `Your follow-ups: ${bits.join(", ")}. Tap to plan your day.`, url: "/", tag: "digest" });
    }
  }
}
function mark(id, nextAt) {
  const cur = getLead(id); if (!cur) return;
  const next = { ...cur, pushedFor: nextAt };
  putLead(id, next); broadcast({ t: "lead", id, data: next });
}
