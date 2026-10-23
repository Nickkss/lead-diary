// Users and sign-in. The first account (the admin) is created with a one-time setup code printed by the installer,
// so nobody who finds the URL first can claim the app. The admin then creates logins for the team.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, kvGet, kvDel, DATA_DIR, allLeads, putLead } from "./db.js";

const COOKIE = "ld_session";
const SESSION_DAYS = 180;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function checkHash(pw, rec) {
  if (!rec?.salt) return false;
  const { hash } = hashPassword(pw, rec.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(rec.hash, "hex"));
}

/* ---------- users ---------- */
const rowToUser = r => r && ({ id: r.id, username: r.username, name: r.name, role: r.role, active: !!r.active, createdAt: r.created_at });
export const listUsers = () => db.prepare("SELECT * FROM users ORDER BY created_at").all().map(rowToUser);
export const getUser = id => rowToUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
const userRow = username => db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim().toLowerCase());
export const hasUsers = () => db.prepare("SELECT COUNT(*) n FROM users").get().n > 0;
export const adminId = () => db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at LIMIT 1").get()?.id || null;

export const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
export function createUser({ name, username, password, role }) {
  username = String(username || "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw Object.assign(new Error("Username: 3 to 30 letters or numbers (dots, dashes and underscores are fine)."), { code: "bad_username" });
  if (userRow(username)) throw Object.assign(new Error("That username is taken."), { code: "username_taken" });
  if (!String(name || "").trim()) throw Object.assign(new Error("Add the person's name."), { code: "bad_name" });
  if (String(password || "").length < 8) throw Object.assign(new Error("Use at least 8 characters for the password."), { code: "weak_password" });
  const id = "u_" + crypto.randomBytes(6).toString("hex");
  db.prepare("INSERT INTO users (id, username, name, role, pass, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .run(id, username, String(name).trim().slice(0, 60), role === "admin" ? "admin" : "member", JSON.stringify(hashPassword(String(password))), new Date().toISOString());
  return getUser(id);
}
export function updateUser(id, { name, role, active, password }) {
  const u = getUser(id); if (!u) throw Object.assign(new Error("No such user."), { code: "not_found" });
  const otherAdmins = listUsers().filter(x => x.id !== id && x.role === "admin" && x.active).length;
  if ((role === "member" || active === false) && u.role === "admin" && !otherAdmins)
    throw Object.assign(new Error("Keep at least one active admin."), { code: "last_admin" });
  if (name !== undefined) { if (!String(name).trim()) throw Object.assign(new Error("Add the person's name."), { code: "bad_name" }); db.prepare("UPDATE users SET name = ? WHERE id = ?").run(String(name).trim().slice(0, 60), id); }
  if (role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role === "admin" ? "admin" : "member", id);
  if (active !== undefined) { db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id); if (!active) endUserSessions(id); }
  if (password !== undefined) setUserPassword(id, password);
  return getUser(id);
}
export function setUserPassword(id, pw) {
  if (String(pw || "").length < 8) throw Object.assign(new Error("Use at least 8 characters for the password."), { code: "weak_password" });
  db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(JSON.stringify(hashPassword(String(pw))), id);
  endUserSessions(id);
}
export const endUserSessions = id => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
export function checkLogin(username, pw) {
  const r = userRow(username);
  if (!r || !r.active) { checkHash(pw, hashPassword("x")); return null; }   // same time either way
  try { return checkHash(pw, JSON.parse(r.pass)) ? rowToUser(r) : null; } catch { return null; }
}

/* ---------- one-time move from the single-owner version ---------- */
export function migrateSingleOwner() {
  const owner = kvGet("owner");
  if (!owner || hasUsers()) return;
  const id = "u_" + crypto.randomBytes(6).toString("hex");
  db.prepare("INSERT INTO users (id, username, name, role, pass, active, created_at) VALUES (?, 'admin', 'Admin', 'admin', ?, 1, ?)")
    .run(id, JSON.stringify(owner), new Date().toISOString());
  db.prepare("UPDATE sessions SET user_id = ? WHERE user_id IS NULL").run(id);
  db.prepare("UPDATE push_subs SET user_id = ? WHERE user_id IS NULL").run(id);
  const g = kvGet("google"); if (g) { db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run("google:" + id, JSON.stringify(g)); kvDel("google"); }
  for (const l of allLeads()) {
    const { id: lid, ...data } = l;
    putLead(lid, { ...data, owner: data.owner || id, createdBy: data.createdBy || id,
      notes: (data.notes || []).map(n => ({ ...n, by: n.by || id })), calUser: data.calEventId ? (data.calUser || id) : (data.calUser || "") });
  }
  kvDel("owner");
  console.log("Moved to team accounts: your login is now username 'admin' with your existing password.");
}

/* setup code: from env, else generated once and saved next to the database */
export function setupCode() {
  if (hasUsers()) return null;
  if (process.env.SETUP_CODE) return process.env.SETUP_CODE;
  const file = path.join(DATA_DIR, "setup-code.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const code = String(crypto.randomInt(100000, 999999));
  fs.writeFileSync(file, code + "\n", { mode: 0o600 });
  return code;
}
export function finishSetup() { try { fs.unlinkSync(path.join(DATA_DIR, "setup-code.txt")); } catch {} }

/* ---------- sessions ---------- */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
export function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const exp = Date.now() + SESSION_DAYS * 864e5;
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at, device, user_id) VALUES (?, ?, ?, ?, ?)")
    .run(sha(token), new Date().toISOString(), exp, String(req.headers["user-agent"] || "").slice(0, 200), userId);
  const secure = (process.env.PUBLIC_URL || "").startsWith("https://");
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}
export function endSession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(t));
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
export function sessionUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = db.prepare("SELECT expires_at, user_id FROM sessions WHERE token_hash = ?").get(sha(t));
  if (!row || row.expires_at <= Date.now()) return null;
  const u = getUser(row.user_id);
  return u && u.active ? u : null;
}
export function requireAuth(req, res, next) {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ code: "not_signed_in", message: "Please sign in." });
  req.user = u; next();
}
export function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  res.status(403).json({ code: "admin_only", message: "Only an admin can do this." });
}

/* simple in-memory throttle: 8 attempts per 10 minutes per IP */
const attempts = new Map();
export function throttled(req) {
  const ip = req.ip || "?", now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 10 * 6e4);
  list.push(now); attempts.set(ip, list);
  return list.length > 8;
}
