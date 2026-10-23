// End-to-end test: real server + fake Anthropic + fake Google, driven in a real browser (Playwright).
//   node test/e2e.mjs        (needs Playwright with Chromium installed)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(path.join(process.env.G || "", "playwright"))); }

const PORT = 3998, AN_PORT = 4555, GM_PORT = 4556, BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ld-e2e-"));
const results = []; const ok = (c, m) => { results.push((c ? "PASS " : "FAIL ") + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const anthropic = startFakeAnthropic(AN_PORT);
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "./test/google-mock.mjs", "server/server.js"], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PUBLIC_URL: BASE, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${AN_PORT}`,
    GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", GMOCK_PORT: String(GM_PORT), TZ: "Asia/Kolkata" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = ""; server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
for (let i = 0; i < 50 && !serverLog.includes("running on port"); i++) await sleep(100);
const gstate = async () => (await fetch(`http://127.0.0.1:${GM_PORT}/`)).json();

const browser = await chromium.launch();
const errs = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => { if (m.type() === "error" && !/401|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE); await sleep(500);
  ok(await p.isVisible("#authSetup"), "first visit asks for the setup code");
  await p.screenshot({ path: path.join(DATA, "01-setup.png") });
  await p.fill("#authCode", "000000"); await p.fill("#authName", "Nick Chouhan"); await p.fill("#authUser", "nick"); await p.fill("#authPw", "secret123"); await p.click("#authBtn"); await sleep(300);
  ok((await p.textContent("#authErr")).includes("wrong"), "wrong setup code is refused");
  const code = fs.readFileSync(path.join(DATA, "setup-code.txt"), "utf8").trim();
  await p.fill("#authCode", code); await p.fill("#authName", "Nick Chouhan"); await p.fill("#authUser", "nick"); await p.fill("#authPw", "secret123"); await p.click("#authBtn"); await sleep(700);
  ok(!(await p.isVisible("#auth")), "setup with the right code signs in");
  ok(!fs.existsSync(path.join(DATA, "setup-code.txt")), "setup code is used up");

  // categories
  await p.click('[data-tab="prefs"]'); await sleep(200);
  await p.fill("#newCat", "LIMS"); await p.click("#catForm button"); await sleep(300);
  await p.fill("#newCat", "ERP"); await p.click("#catForm button"); await sleep(300);
  ok((await (await fetch(BASE + "/api/state")).status) === 401, "API is closed without a session");
  // connect Google (simulate the redirect round trip with the browser's cookie)
  const cookies = await ctx.cookies(); const cookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const r1 = await fetch(BASE + "/api/google/connect", { headers: { cookie }, redirect: "manual" });
  const loc = new URL(r1.headers.get("location"));
  ok(loc.host === "accounts.google.com" && loc.searchParams.get("redirect_uri") === BASE + "/api/google/callback", "Connect sends you to Google with the right return address");
  await p.goto(`${BASE}/api/google/callback?code=abc&state=${loc.searchParams.get("state")}`); await sleep(800);
  ok((await p.textContent("#main")).includes("owner@gmail.com"), "Settings shows the connected Google account");
  await p.screenshot({ path: path.join(DATA, "02-settings.png"), fullPage: true });

  // add lead with AI
  await p.evaluate(() => document.activeElement?.blur());
  await p.click(".fab"); await sleep(300);
  await p.fill("#raw", "Hi I am Sunita from BioGen Labs, need LIMS for 3 labs, budget 4 lakh, call me 15 Jan 3pm");
  await p.click("#fillAI"); await sleep(600);
  ok((await p.inputValue("#fName")) === "Sunita Rao" && (await p.getAttribute('[data-pick]:has-text("LIMS")', "aria-pressed")) === "true", "AI fills the new-lead form");
  const aiCall = anthropic.calls.at(-1);
  ok((aiCall.headers["x-api-key"] === "test-key" || aiCall.headers.authorization === "Bearer test-key") && aiCall.body.model === "claude-opus-5-5" && aiCall.body.output_config?.effort === "low", "server calls Claude with the key, model and effort");
  ok(aiCall.body.fallbacks === "default" && String(aiCall.headers["anthropic-beta"]).includes("server-side-fallback-2026-07-01"), "refusal fallback is on");
  await p.click("#leadForm button[type=submit]"); await sleep(1200);
  let g = await gstate();
  ok(g.events.length === 1 && g.events[0][1].start.dateTime === "2030-01-15T15:00:00" && g.events[0][1].start.timeZone === "Asia/Kolkata", "a Google Calendar event is created at the right time");
  const st = await p.evaluate(() => fetch("/api/state").then(r => r.json()));
  const lead = st.leads[0];
  ok(lead.calEventId && !lead.calErr, "lead remembers its calendar event");

  // second device sees it live
  const p2 = await ctx.newPage(); await p2.goto(BASE + "/?x=1"); await sleep(800);
  await p2.click('[data-tab="leads"]'); await sleep(200);
  ok(await p2.locator("#leadList .row").count() === 1, "second device shows the lead");

  // open lead, voice update with AI
  await p.click('[data-tab="leads"]'); await sleep(200);
  await p.click("#leadList [data-open]"); await sleep(400);
  const fuText = await p.textContent(".fu");
  ok(fuText.includes("In Google Calendar"), "lead shows it is in Google Calendar · " + fuText.replace(/\s+/g, " ").slice(0, 160));
  await p.fill("#upd", "haan baat hui, monday 4 baje demo, 25 users"); await p.click("#saveAI"); await sleep(1500);
  const l2 = (await p.evaluate(() => fetch("/api/state").then(r => r.json()))).leads[0];
  ok(l2.status === "demo" && l2.nextAt === "2030-01-20T16:00" && l2.notes.length === 2 && l2.req?.users === "25", "Save with AI sets stage, date, requirements and note");
  g = await gstate();
  ok(g.events.length === 1 && g.events[0][1].start.dateTime === "2030-01-20T16:00:00", "calendar event moved (no duplicate)");
  await p2.click(`#leadList [data-open="${lead.id}"]`); await sleep(400);
  ok((await p2.textContent(".timeline")).includes("Demo on Monday"), "update appears live on the second device");
  await p2.close();

  // next step streaming text + plan
  await p.click("#nextAI"); await sleep(800);
  ok(await p.locator("#msgTxt").count() === 1, "Next step suggestion works");
  await p.screenshot({ path: path.join(DATA, "03-lead.png") });

  // deep link from a notification
  await p.goto(`${BASE}/?open=${lead.id}`); await sleep(900);
  ok(await p.locator(".sheet .hero h2").count() === 1, "a notification link opens that lead");

  // close deal -> event removed
  await p.selectOption("#dStatus", "won"); await sleep(1200);
  g = await gstate();
  ok(g.events.length === 0, "winning the deal deletes the calendar event");
  await p.click("#sheetX"); await sleep(200);

  // Today plan (streaming text)
  await p.click('[data-tab="today"]'); await sleep(200);
  await p.click(".fab"); await sleep(250); await p.fill("#fName", "Ramesh"); await p.click('[data-pick]:has-text("ERP")');
  await p.click("#leadForm button[type=submit]"); await sleep(1000);
  await p.click("#planBtn"); await sleep(800);
  ok((await p.textContent("#planOut")).includes("Tip:"), "Plan my day streams text");
  await p.screenshot({ path: path.join(DATA, "04-today.png") });

  // delete lead removes its event
  g = await gstate(); const before = g.events.length;
  await p.click('.group [data-open]'); await sleep(300); await p.click("#delBtn"); await p.click("#delBtn"); await sleep(1000);
  g = await gstate();
  ok(before === 1 && g.events.length === 0, "deleting a lead deletes its calendar event");
  await p.evaluate(() => document.activeElement?.blur());

  // backup and restore
  const exp = await p.evaluate(() => fetch("/api/export.json").then(r => r.json()));
  ok(exp.leads.length === 1 && exp.settings.categories.length === 2, "full backup contains leads and settings");
  const imp = await p.evaluate(b => fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leads: [{ id: "Limported1", name: "Imported", status: "new", notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], settings: b.settings }) }).then(r => r.json()), exp);
  ok(imp.added === 1, "restore adds leads from a backup");
  await sleep(800);
  await p.click('[data-tab="leads"]'); await sleep(300);
  ok(await p.locator("#leadList .row").count() === 2, "restored lead appears without reload");

  // server-owned fields can't be overwritten from the page
  await p.evaluate(() => fetch("/api/leads/Limported1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calEventId: "hack" }) }));
  const st3 = await p.evaluate(() => fetch("/api/state").then(r => r.json()));
  ok(!st3.leads.find(l => l.id === "Limported1").calEventId, "page can't overwrite calendar fields");

  // Excel export
  await p.click('[data-tab="prefs"]'); await sleep(300);
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 8000 }).catch(() => null), p.click("#expBtn")]);
  ok(dl && dl.suggestedFilename().endsWith(".xlsx"), "Excel export downloads a file");

  // sign out / wrong password / sign in
  await p.click("#logout"); await sleep(800);
  ok(await p.isVisible("#auth") && !(await p.isVisible("#authSetup")), "sign out shows the sign-in screen");
  await p.fill("#authUser", "nick"); await p.fill("#authPw", "wrongpass1"); await p.click("#authBtn"); await sleep(300);
  ok((await p.textContent("#authErr")).includes("Wrong"), "wrong password is refused");
  await p.fill("#authUser", "nick"); await p.fill("#authPw", "secret123"); await p.click("#authBtn"); await sleep(800);
  ok(!(await p.isVisible("#auth")), "right password signs back in");

  // ---------- team ----------
  await p.click('[data-tab="prefs"]'); await sleep(500);
  await p.fill("#nuName", "Ravi Sharma"); await p.fill("#nuUser", "Ravi"); await p.fill("#nuPass", "ravipass1"); await p.click("#userForm button[type=submit]"); await sleep(700);
  ok((await p.textContent("#teamCard")).includes("Ravi Sharma"), "admin adds a team member");
  const adminLead = (await p.evaluate(() => fetch("/api/state").then(r => r.json()))).leads.find(l => l.status !== "won");
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const r = await ctx2.newPage(); r.on("pageerror", e => errs.push("ravi: " + e.message));
  await r.goto(BASE); await sleep(500);
  ok(!(await r.isVisible("#authSetup")), "second person sees a normal sign-in (no setup code)");
  await r.fill("#authUser", "ravi"); await r.fill("#authPw", "ravipass1"); await r.click("#authBtn"); await sleep(900);
  ok(!(await r.isVisible("#auth")), "team member signs in with username + password");
  await r.click('[data-tab="leads"]'); await sleep(300);
  await r.click('[data-fown=""]').catch(() => {}); await sleep(200);
  ok(await r.locator("#leadList .row").count() >= 2, "team member sees everyone's leads");
  await r.click(`#leadList [data-open="${adminLead.id}"]`); await sleep(400);
  ok(await r.isDisabled("#dStatus") && !(await r.locator("#delBtn").count()) && !(await r.locator("#editBtn").count()), "on someone else's lead: stage locked, no edit, no delete");
  await r.fill("#upd", "Called from Ravi's side, wants brochure"); await r.click("#savePlain"); await sleep(700);
  let st4 = await r.evaluate(() => fetch("/api/state").then(x => x.json()));
  const ravi = st4.users.find(u => u.name === "Ravi Sharma");
  const al = st4.leads.find(l => l.id === adminLead.id);
  ok(al.notes[0].text.includes("brochure") && al.notes[0].by === ravi.id, "member can add an update on any lead, signed with their name");
  ok((await r.textContent(".timeline")).includes("You"), "update shows who wrote it");
  const api = (pg, m, u, b) => pg.evaluate(([m, u, b]) => fetch(u, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(x => x.status), [m, u, b]);
  ok(await api(r, "PATCH", "/api/leads/" + adminLead.id, { status: "lost" }) === 403, "server refuses stage change on someone else's lead");
  ok(await api(r, "DELETE", "/api/leads/" + adminLead.id) === 403, "server refuses delete by a member");
  ok(await api(r, "PATCH", "/api/leads/" + adminLead.id, { notes: [] }) === 403, "server refuses wiping someone's updates");
  ok(await api(r, "PUT", "/api/settings", { categories: [] }) === 403 && await api(r, "GET", "/api/users") === 403, "settings and team are admin-only");
  await r.click("#sheetX"); await sleep(200);
  // member adds their own lead and changes its stage
  await r.click(".fab"); await sleep(250); await r.fill("#fName", "Ravi's Client"); await r.click('[data-pick]:has-text("LIMS")');
  ok(!(await r.locator("#fOwner").count()), "member doesn't get the 'assign to' choice");
  await r.click("#leadForm button[type=submit]"); await sleep(700);
  st4 = await r.evaluate(() => fetch("/api/state").then(x => x.json()));
  const rl = st4.leads.find(l => l.name === "Ravi's Client");
  ok(rl.owner === ravi.id && rl.createdBy === ravi.id, "member's new lead is theirs");
  ok(await api(r, "PATCH", "/api/leads/" + rl.id, { status: "demo" }) === 200, "member can change their own lead");
  await r.click('[data-tab="today"]'); await sleep(300);
  ok(await r.locator('[data-scope="mine"][aria-pressed="true"]').count() === 1, "Today shows 'My follow-ups' by default");
  await r.screenshot({ path: path.join(DATA, "06-member-today.png") });
  await r.click('[data-tab="prefs"]'); await sleep(300);
  ok(!(await r.isVisible("#catForm")) && !(await r.locator("#userForm").count()), "member settings hide admin sections");
  // admin sees attribution
  await p.click('[data-tab="dash"]'); await sleep(900);
  const dashText = await p.textContent("#main");
  ok(dashText.includes("Ravi Sharma") && dashText.includes("Recent activity"), "dashboard shows the team table");
  ok((await p.textContent("#actList")).includes("Ravi"), "activity feed shows Ravi's work: " + (await p.textContent("#actList")).replace(/\s+/g, " ").slice(0, 120));
  await p.screenshot({ path: path.join(DATA, "07-admin-dash.png"), fullPage: true });
  // admin reassigns a lead to Ravi
  ok(await api(p, "PATCH", "/api/leads/" + adminLead.id, { owner: ravi.id }) === 200, "admin can assign a lead");
  // turning Ravi off signs him out
  await p.click('[data-tab="prefs"]'); await sleep(600);
  await p.click(`[data-act="${ravi.id}"]`); await p.click(`[data-act="${ravi.id}"]`); await sleep(700);
  ok(await api(r, "GET", "/api/state") === 401, "turned-off member is signed out");
  await ctx2.close();

  // desktop + dark screenshot
  await p.setViewportSize({ width: 1280, height: 820 }); await p.emulateMedia({ colorScheme: "dark" });
  await p.click('[data-tab="dash"]'); await sleep(400); await p.screenshot({ path: path.join(DATA, "05-desk.png") });
} finally {
  ok(errs.length === 0, "no page errors " + errs.slice(0, 3).join(" | "));
  await browser.close(); server.kill(); anthropic.close();
  console.log(results.join("\n"));
  console.log(`\n${results.filter(r => r.startsWith("PASS")).length}/${results.length} passed · screenshots in ${DATA}`);
  if (results.some(r => r.startsWith("FAIL"))) { console.log("\nserver log:\n" + serverLog.slice(-3000)); process.exitCode = 1; }
}
