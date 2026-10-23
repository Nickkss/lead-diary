// Reminder timing: each owner gets their own leads' reminders once; closed leads never notify; morning summary once a day per person.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ld-push-"));
const webpush = (await import("web-push")).default;
const sent = []; webpush.sendNotification = async (sub, payload) => { sent.push({ to: sub.endpoint, ...JSON.parse(payload) }); };
const { putLead, putSettings, getLead, DEFAULT_SETTINGS } = await import("../server/db.js");
const { createUser } = await import("../server/auth.js");
const push = await import("../server/push.js");
const pad = n => String(n).padStart(2, "0");
const loc = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nick = createUser({ name: "Nick", username: "nick", password: "secret123", role: "admin" });
const ravi = createUser({ name: "Ravi", username: "ravi", password: "secret123", role: "member" });

test("reminders go to the lead's owner", async () => {
  putSettings({ ...DEFAULT_SETTINGS, calendar: { enabled: true, reminder: 10, duration: 15 }, digestHour: -1 });
  push.subscribe({ endpoint: "https://push.example/nick", keys: { p256dh: "x", auth: "y" } }, "Mac", nick.id);
  push.subscribe({ endpoint: "https://push.example/ravi", keys: { p256dh: "x", auth: "y" } }, "iPhone", ravi.id);
  const now = new Date(2030, 0, 15, 15, 0);
  putLead("a", { name: "Due", owner: ravi.id, status: "demo", nextAt: loc(new Date(now.getTime() + 5 * 6e4)), notes: [] });
  putLead("b", { name: "Later", owner: nick.id, status: "demo", nextAt: loc(new Date(now.getTime() + 60 * 6e4)), notes: [] });
  putLead("c", { name: "Won", owner: nick.id, status: "won", nextAt: loc(now), notes: [] });
  putLead("d", { name: "Old", owner: nick.id, status: "new", nextAt: loc(new Date(now.getTime() - 9 * 3600e3)), notes: [] });
  await push.tick(now);
  assert.deepEqual(sent.map(s => [s.title, s.to]), [["Follow up: Due", "https://push.example/ravi"]]);
  assert.equal(getLead("d").pushedFor, getLead("d").nextAt, "stale reminder is skipped and marked");
  await push.tick(now); assert.equal(sent.length, 1, "no repeat");
  await push.tick(new Date(now.getTime() + 55 * 6e4)); assert.deepEqual([sent.at(-1).title, sent.at(-1).to], ["Follow up: Later", "https://push.example/nick"]);
  putLead("a", { ...getLead("a"), nextAt: loc(new Date(now.getTime() + 2 * 864e5)) });
  await push.tick(new Date(now.getTime() + 2 * 864e5 - 5 * 6e4)); assert.equal(sent.at(-1).title, "Follow up: Due", "rescheduled lead notifies again");
});

test("morning summary once a day, per person", async () => {
  sent.length = 0;
  putSettings({ ...DEFAULT_SETTINGS, digestHour: 9 });
  putLead("e", { name: "Today", owner: ravi.id, status: "contacted", nextAt: loc(new Date(2030, 0, 20, 17, 0)), notes: [] });
  await push.tick(new Date(2030, 0, 20, 9, 1)); await push.tick(new Date(2030, 0, 20, 9, 30));
  const digests = sent.filter(s => s.tag === "digest");
  const forRavi = digests.filter(d => d.to.endsWith("ravi"));
  assert.equal(forRavi.length, 1); assert.match(forRavi[0].body, /1 due today/); assert.match(forRavi[0].title, /Ravi/);
});
