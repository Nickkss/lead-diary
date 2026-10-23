// Reminder timing: due follow-ups notify once, early ones wait, closed leads never notify, morning summary once a day.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ld-push-"));
const webpush = (await import("web-push")).default;
const sent = []; webpush.sendNotification = async (sub, payload) => { sent.push(JSON.parse(payload)); };
const { putLead, putSettings, getLead, DEFAULT_SETTINGS } = await import("../server/db.js");
const push = await import("../server/push.js");
const pad = n => String(n).padStart(2, "0");
const loc = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

test("reminders", async () => {
  putSettings({ ...DEFAULT_SETTINGS, calendar: { enabled: true, reminder: 10, duration: 15 }, digestHour: -1 });
  push.subscribe({ endpoint: "https://push.example/1", keys: { p256dh: "x", auth: "y" } }, "iPhone");
  const now = new Date(2030, 0, 15, 15, 0);
  putLead("a", { name: "Due", status: "demo", nextAt: loc(new Date(now.getTime() + 5 * 6e4)), notes: [] });      // within 10 min
  putLead("b", { name: "Later", status: "demo", nextAt: loc(new Date(now.getTime() + 60 * 6e4)), notes: [] });   // an hour away
  putLead("c", { name: "Won", status: "won", nextAt: loc(now), notes: [] });
  putLead("d", { name: "Old", status: "new", nextAt: loc(new Date(now.getTime() - 9 * 3600e3)), notes: [] });     // 9h stale
  await push.tick(now);
  assert.deepEqual(sent.map(s => s.title), ["Follow up: Due"]);
  assert.equal(sent[0].url, "/?open=a");
  assert.equal(getLead("d").pushedFor, getLead("d").nextAt, "stale reminder is skipped and marked");
  await push.tick(now); assert.equal(sent.length, 1, "no repeat");
  await push.tick(new Date(now.getTime() + 55 * 6e4)); assert.equal(sent.at(-1).title, "Follow up: Later");
  putLead("a", { ...getLead("a"), nextAt: loc(new Date(now.getTime() + 2 * 864e5)) });                          // rescheduled
  await push.tick(new Date(now.getTime() + 2 * 864e5 - 5 * 6e4)); assert.equal(sent.at(-1).title, "Follow up: Due", "rescheduled lead notifies again");
});

test("morning summary once a day", async () => {
  sent.length = 0;
  putSettings({ ...DEFAULT_SETTINGS, digestHour: 9 });
  const morning = new Date(2030, 0, 20, 9, 1);
  putLead("e", { name: "Today", status: "contacted", nextAt: loc(new Date(2030, 0, 20, 17, 0)), notes: [] });
  await push.tick(morning); await push.tick(new Date(2030, 0, 20, 9, 30));
  const digests = sent.filter(s => s.tag === "digest");
  assert.equal(digests.length, 1); assert.match(digests[0].body, /1 due today/);
});
