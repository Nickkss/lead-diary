// The mic button must never trap the page: iPhone hands over to keyboard dictation; elsewhere a second tap always stops.
import { createRequire } from "node:module"; import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(path.join(process.env.G || "", "playwright"))); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ld-mic-")), PORT = 3996, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/server.js"], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PUBLIC_URL: BASE }, stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms)); await sleep(1200);
const res = []; const ok = (c, m) => res.push((c ? "PASS " : "FAIL ") + m);
const b = await chromium.launch();
async function signIn(p, first) {
  await p.goto(BASE); await sleep(500);
  if (first) { await p.fill("#authCode", fs.readFileSync(path.join(DATA, "setup-code.txt"), "utf8").trim()); await p.fill("#authName", "Nick"); }
  await p.fill("#authUser", "nick"); await p.fill("#authPw", "secret123"); await p.click("#authBtn"); await sleep(800);
}
// iPhone
const iphone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
await iphone.addInitScript(() => { window.SpeechRecognition = window.webkitSpeechRecognition = function () { this.start = () => {}; this.stop = () => {}; this.abort = () => {}; }; });
const p = await iphone.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message));
await signIn(p, true);
await p.click(".fab"); await sleep(300); await p.click('[data-mic="raw"]'); await sleep(200);
ok((await p.textContent("#micHint-raw")).includes("tap 🎤 on your keyboard"), "iPhone: mic shows how to use keyboard dictation");
ok(await p.evaluate(() => document.activeElement.id) === "raw", "iPhone: the text box is ready for dictation");
ok(!(await p.locator(".mic.rec").count()), "iPhone: no stuck 'listening' state");
await p.screenshot({ path: path.join(DATA, "iphone-mic.png") });
// already typing, then tap the mic: the box must stay focused (keyboard stays open)
await p.click("#raw"); await p.keyboard.type("Rahul from Apex"); await p.click('[data-mic="raw"]'); await sleep(200);
ok(await p.evaluate(() => document.activeElement.id) === "raw", "iPhone: tapping mic while typing keeps the keyboard open");
await p.evaluate(() => document.activeElement.blur()); await sleep(100);
ok(!(await p.textContent("#micHint-raw")).trim(), "iPhone: the tip goes away when you're done");
await p.click("#sheetX"); await sleep(300); await p.click("#sheetX").catch(() => {}); await sleep(300);
ok(!(await p.locator("#leadForm").count()), "iPhone: Close works");
// Mac/Chrome with a recognizer that never reports back
const mac = await b.newContext({ viewport: { width: 1280, height: 800 } });
await mac.addInitScript(() => { window.SpeechRecognition = window.webkitSpeechRecognition = function () { this.start = () => {}; this.stop = () => {}; this.abort = () => { window.__aborted = (window.__aborted || 0) + 1; }; }; });
const m = await mac.newPage(); m.on("pageerror", e => errs.push(e.message));
await signIn(m, false);
await m.click(".rail-new"); await sleep(300); await m.click('[data-mic="raw"]'); await sleep(200);
ok(await m.locator(".mic.rec").count() === 1, "Mac: listening starts");
await m.click('[data-mic="raw"]'); await sleep(200);
ok(!(await m.locator(".mic.rec").count()) && await m.evaluate(() => window.__aborted) === 1, "Mac: second tap stops at once, even if the recognizer never answers");
await m.click('[data-mic="raw"]'); await sleep(200); await m.click("#sheetX"); await sleep(300);
ok(!(await m.locator("#leadForm").count()) && await m.evaluate(() => window.__aborted) === 2, "Mac: Close works while listening and stops the mic");
ok(errs.length === 0, "no page errors " + errs.join(" | "));
await b.close(); srv.kill();
console.log(res.join("\n"));
if (res.some(r => r.startsWith("FAIL"))) process.exitCode = 1;
