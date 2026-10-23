// Single-owner login. The first account is created with a one-time setup code printed by the installer,
// so nobody who finds the URL first can claim the app.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, kvGet, kvSet, DATA_DIR } from "./db.js";

const COOKIE = "ld_session";
const SESSION_DAYS = 180;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function checkPassword(pw, rec) {
  if (!rec) return false;
  const { hash } = hashPassword(pw, rec.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(rec.hash, "hex"));
}

export const hasOwner = () => !!kvGet("owner");

/* setup code: from env, else generated once and saved next to the database */
export function setupCode() {
  if (hasOwner()) return null;
  if (process.env.SETUP_CODE) return process.env.SETUP_CODE;
  const file = path.join(DATA_DIR, "setup-code.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const code = String(crypto.randomInt(100000, 999999));
  fs.writeFileSync(file, code + "\n", { mode: 0o600 });
  return code;
}

export function setPassword(pw) {
  kvSet("owner", hashPassword(pw));
  db.prepare("DELETE FROM sessions").run();           // log out every device
  try { fs.unlinkSync(path.join(DATA_DIR, "setup-code.txt")); } catch {}
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function startSession(req, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const exp = Date.now() + SESSION_DAYS * 864e5;
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at, device) VALUES (?, ?, ?, ?)")
    .run(sha(token), new Date().toISOString(), exp, String(req.headers["user-agent"] || "").slice(0, 200));
  const secure = (process.env.PUBLIC_URL || "").startsWith("https://");
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}

export function endSession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(t));
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function isAuthed(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return false;
  const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(sha(t));
  return !!row && row.expires_at > Date.now();
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ code: "not_signed_in", message: "Please sign in." });
}

/* simple in-memory throttle: 8 attempts per 10 minutes per IP */
const attempts = new Map();
export function throttled(req) {
  const ip = req.ip || "?", now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 10 * 6e4);
  list.push(now); attempts.set(ip, list);
  return list.length > 8;
}

export { checkPassword };
