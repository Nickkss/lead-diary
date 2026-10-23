// Upgrading from the single-owner version keeps the password, leads, Google connection and devices.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import crypto from "node:crypto";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ld-mig-"));
const { db, kvSet, kvGet, putLead, getLead } = await import("../server/db.js");
const salt = "abcd", hash = crypto.scryptSync("oldpass123", salt, 64).toString("hex");
kvSet("owner", { salt, hash });
kvSet("google", { refresh_token: "rt", email: "me@gmail.com" });
db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES ('t', 'x', ?)").run(Date.now() + 1e9);
putLead("L1", { name: "Old lead", status: "new", calEventId: "ev1", notes: [{ at: "2026-10-01T10:00:00Z", type: "Call", text: "hi" }] });
const auth = await import("../server/auth.js");

test("single owner becomes the admin", () => {
  auth.migrateSingleOwner();
  const [u] = auth.listUsers();
  assert.equal(u.username, "admin"); assert.equal(u.role, "admin");
  assert.ok(auth.checkLogin("admin", "oldpass123"), "old password still works");
  const l = getLead("L1");
  assert.equal(l.owner, u.id); assert.equal(l.notes[0].by, u.id); assert.equal(l.calUser, u.id);
  assert.equal(kvGet("google:" + u.id).email, "me@gmail.com"); assert.equal(kvGet("google"), null);
  assert.equal(db.prepare("SELECT user_id FROM sessions WHERE token_hash='t'").get().user_id, u.id, "existing sign-ins keep working");
  auth.migrateSingleOwner(); assert.equal(auth.listUsers().length, 1, "runs once");
});
