// SQLite storage (built into Node 22). Leads are JSON documents; small key/value table for everything else.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "lead-diary.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, device TEXT);
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL, device TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
    pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, lead_id TEXT, lead_name TEXT, detail TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
`);
// columns added after the first release
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
if (!hasCol("sessions", "user_id")) db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT");
if (!hasCol("push_subs", "user_id")) db.exec("ALTER TABLE push_subs ADD COLUMN user_id TEXT");

const q = {
  kvGet: db.prepare("SELECT value FROM kv WHERE key = ?"),
  kvSet: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  kvDel: db.prepare("DELETE FROM kv WHERE key = ?"),
  leadAll: db.prepare("SELECT id, data FROM leads"),
  leadGet: db.prepare("SELECT data FROM leads WHERE id = ?"),
  leadPut: db.prepare("INSERT INTO leads (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"),
  leadDel: db.prepare("DELETE FROM leads WHERE id = ?"),
};

export function kvGet(key, fallback = null) {
  const row = q.kvGet.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export const kvSet = (key, value) => q.kvSet.run(key, JSON.stringify(value));
export const kvDel = key => q.kvDel.run(key);

export function allLeads() {
  return q.leadAll.all().map(r => ({ id: r.id, ...JSON.parse(r.data) }));
}
export function getLead(id) {
  const row = q.leadGet.get(id);
  return row ? JSON.parse(row.data) : null;
}
export function putLead(id, data) {
  q.leadPut.run(id, JSON.stringify(data), new Date().toISOString());
  return data;
}
export function deleteLead(id) { q.leadDel.run(id); }

export const DEFAULT_SETTINGS = {
  categories: [], focus: [], focusOnly: false, defaultHour: 11,
  calendar: { enabled: true, reminder: 10, duration: 15 },
  lastBackupAt: "", digestHour: 9, speechLang: "en-IN",
};
export function getSettings() {
  const s = kvGet("settings", {});
  return { ...DEFAULT_SETTINGS, ...s, calendar: { ...DEFAULT_SETTINGS.calendar, ...(s.calendar || {}) } };
}
export const putSettings = s => kvSet("settings", s);

/* ---------- activity log: who did what ---------- */
const actIns = db.prepare("INSERT INTO activity (at, user_id, lead_id, lead_name, detail) VALUES (?, ?, ?, ?, ?)");
export function logActivity(userId, leadId, leadName, detail) {
  const at = new Date().toISOString();
  const r = actIns.run(at, userId || null, leadId || null, String(leadName || "").slice(0, 120), String(detail).slice(0, 300));
  return { id: Number(r.lastInsertRowid), at, userId, leadId, leadName, detail };
}
export function recentActivity(limit = 60, userId = null) {
  const rows = userId
    ? db.prepare("SELECT * FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit)
    : db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map(r => ({ id: r.id, at: r.at, userId: r.user_id, leadId: r.lead_id, leadName: r.lead_name, detail: r.detail }));
}

export { DATA_DIR };
