/* Lead Diary runtime: connects the app to its own server.
   It offers the same small interface the app was written against (window.claude.use("db" | "sample" | "downloads")),
   plus window.LD for server-only features (login, Google Calendar status, phone notifications). */
(function () {
  "use strict";
  const CACHE_KEY = "ld.cache.v1";
  let leads = new Map(), settings = null, server = { ai: false, google: {}, push: {} };
  const leadSubs = new Set(), settingsSubs = new Set(), serverSubs = new Set();
  let readyResolve; const ready = new Promise(r => (readyResolve = r));

  /* ---------- http ---------- */
  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, { method, credentials: "same-origin", headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch { throw { code: "unavailable", message: "No connection. Check your internet and try again." }; }
    const isJson = (r.headers.get("content-type") || "").includes("json");
    const j = isJson ? await r.json().catch(() => null) : null;
    if (r.status === 401 && url !== "/api/login" && !url.startsWith("/api/password")) { showAuth(false); throw { code: "not_signed_in", message: "Please sign in again." }; }
    if (!r.ok) throw { code: j?.code || "unavailable", message: j?.message || "Server error " + r.status };
    return j;
  }

  /* ---------- local cache so the app opens instantly, even offline ---------- */
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ leads: [...leads].map(([id, d]) => ({ id, ...d })), settings, server, at: Date.now() })); } catch {}
  }
  function loadCache() {
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (c) { applyState(c, false); } } catch {}
  }
  function applyState(s, cache = true) {
    leads = new Map((s.leads || []).map(({ id, ...d }) => [id, d]));
    settings = s.settings || settings; if (s.server) server = s.server;
    emitLeads(); emitSettings(); emitServer(); if (cache) saveCache();
  }
  const freeze = o => Object.freeze(JSON.parse(JSON.stringify(o)));
  const snapDocs = () => [...leads].map(([id, d]) => ({ id, exists: true, data: () => freeze(d), metadata: { fromCache: false, hasPendingWrites: false } }));
  function emitLeads() { const docs = snapDocs(); leadSubs.forEach(f => f({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} })); }
  function emitSettings() { if (!settings) return; settingsSubs.forEach(f => f({ id: "main", exists: true, data: () => freeze(settings) })); }
  function emitServer() { serverSubs.forEach(f => { try { f(server); } catch {} }); }
  let cacheTimer; const cacheSoon = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(saveCache, 400); };

  /* ---------- live updates ---------- */
  let es = null, hadError = false;
  function connectEvents() {
    if (es) es.close();
    es = new EventSource("/api/events");
    es.onopen = () => { if (hadError) { hadError = false; refresh(); } };
    es.onerror = () => { hadError = true; };
    es.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "lead") { leads.set(m.id, m.data); emitLeads(); cacheSoon(); }
      else if (m.t === "del") { leads.delete(m.id); emitLeads(); cacheSoon(); }
      else if (m.t === "settings") { settings = m.data; emitSettings(); cacheSoon(); }
      else if (m.t === "server") { server = m.data; emitServer(); }
      else if (m.t === "reload") refresh();
    };
  }
  async function refresh() { try { applyState(await api("GET", "/api/state")); } catch {} }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && authed) refresh(); });

  /* ---------- db (the subset the app uses) ---------- */
  // fields only the server writes (calendar + reminder state); never overwrite them locally from the page's copy
  const SERVER_FIELDS = ["calEventId", "calKey", "calErr", "pushedFor"];
  const own = d => { const o = { ...d }; SERVER_FIELDS.forEach(k => delete o[k]); return o; };
  const leadRef = id => ({
    id,
    async set(d) { await api("PUT", "/api/leads/" + encodeURIComponent(id), d); leads.set(id, { ...(leads.get(id) || {}), ...own(d) }); emitLeads(); cacheSoon(); },
    async update(p) { await api("PATCH", "/api/leads/" + encodeURIComponent(id), p); if (leads.has(id)) { leads.set(id, { ...leads.get(id), ...own(p) }); emitLeads(); cacheSoon(); } },
    async delete() { const r = await api("DELETE", "/api/leads/" + encodeURIComponent(id)); leads.delete(id); emitLeads(); cacheSoon(); return r; },
  });
  const db = Object.freeze({
    collection(path) {
      if (path !== "leads") throw new TypeError("Only the leads collection exists");
      return { doc: id => leadRef(id), onSnapshot(next) { leadSubs.add(next); setTimeout(() => next({ docs: snapDocs(), size: leads.size, empty: !leads.size, docChanges: () => [], metadata: {} }), 0); return () => leadSubs.delete(next); } };
    },
    doc(path) {
      if (path !== "config/main") throw new TypeError("Unknown document " + path);
      return {
        onSnapshot(next) { settingsSubs.add(next); if (settings) setTimeout(() => next({ id: "main", exists: true, data: () => freeze(settings) }), 0); return () => settingsSubs.delete(next); },
        async set(s) { await api("PUT", "/api/settings", s); settings = s; cacheSoon(); },
      };
    },
  });

  /* ---------- AI ---------- */
  async function aiFetch(input, opts, json) {
    let r;
    try {
      r = await fetch("/api/ai", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, tier: opts?.modelTier || "default", json }), signal: opts?.signal });
    } catch (e) { throw { code: e?.name === "AbortError" ? "cancelled" : "upstream_error", message: "No connection." }; }
    if (r.status === 401) { showAuth(false); throw { code: "not_signed_in" }; }
    if (!r.ok && (r.headers.get("content-type") || "").includes("json")) { const j = await r.json().catch(() => ({})); throw { code: j.code || "upstream_error", message: j.message || "" }; }
    return r;
  }
  async function sample(input, opts = {}) {
    const r = await aiFetch(input, opts, false);
    const reader = r.body.getReader(), dec = new TextDecoder(); let text = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      let delta = dec.decode(value, { stream: true });
      const z = delta.indexOf("\u0000");
      if (z >= 0) { const code = delta.slice(z + 1).trim() || "upstream_error"; delta = delta.slice(0, z); if (delta) { text += delta; opts.onText?.({ text, delta }); } throw { code, message: "", text: text || undefined }; }
      if (delta) { text += delta; opts.onText?.({ text, delta }); }
    }
    if (!text.trim()) throw { code: "empty_completion", message: "" };
    return { text, truncated: false, modelTierApplied: opts.modelTier || "default" };
  }
  sample.json = async (input, opts = {}) => { const r = await aiFetch(input, opts, true); return (await r.json()).value; };
  sample.limits = async () => ({ maxPromptBytes: 300000 });

  /* ---------- downloads ---------- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      return { status: "saved" };
    },
  });

  window.claude = Object.freeze({ use: name => ready.then(() => name === "sample" ? (server.ai ? sample : null) : ({ db, downloads })[name] ?? null) });

  /* ---------- phone notifications ---------- */
  const isStandalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function b64ToBytes(s) { const p = "=".repeat((4 - (s.length % 4)) % 4), b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)); }
  async function pushState() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      return isIOS() && !isStandalone() ? "needs-install" : "unsupported";
    if (Notification.permission === "denied") return "denied";
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    return sub ? "on" : "off";
  }
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw { code: "denied" };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(server.push.publicKey) });
    const name = isIOS() ? "iPhone" : /Mac/.test(navigator.userAgent) ? "Mac" : "Browser";
    await api("POST", "/api/push/subscribe", { subscription: sub.toJSON(), device: name });
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  /* ---------- sign-in screen ---------- */
  let authed = false;
  function showAuth(needsSetup) {
    authed = false;
    const el = document.getElementById("auth"); if (!el) return;
    el.hidden = false; document.body.classList.add("auth-open");
    el.querySelector("#authSetup").hidden = !needsSetup;
    el.querySelector("#authTitle").textContent = needsSetup ? "Set up Lead Diary" : "Welcome back";
    el.querySelector("#authSub").textContent = needsSetup ? "Enter the setup code from the install, then choose your password." : "Sign in to see your leads.";
    el.querySelector("#authBtn").textContent = needsSetup ? "Create password" : "Sign in";
    el.querySelector("#authPw").autocomplete = needsSetup ? "new-password" : "current-password";
    el.dataset.mode = needsSetup ? "setup" : "login";
    setTimeout(() => el.querySelector(needsSetup ? "#authCode" : "#authPw")?.focus(), 50);
  }
  async function onSignedIn() {
    authed = true;
    const el = document.getElementById("auth"); if (el) el.hidden = true; document.body.classList.remove("auth-open");
    applyState(await api("GET", "/api/state"));
    connectEvents(); readyResolve();
  }
  document.addEventListener("submit", async e => {
    if (e.target.id !== "authForm") return;
    e.preventDefault();
    const el = document.getElementById("auth"), btn = el.querySelector("#authBtn"), err = el.querySelector("#authErr");
    const pw = el.querySelector("#authPw").value, code = el.querySelector("#authCode").value;
    err.textContent = ""; btn.disabled = true;
    try {
      if (el.dataset.mode === "setup") await api("POST", "/api/setup", { code, password: pw });
      else await api("POST", "/api/login", { password: pw });
      el.querySelector("#authPw").value = ""; await onSignedIn();
    } catch (x) { err.textContent = x.message || "Couldn't sign in."; }
    btn.disabled = false;
  });

  async function boot() {
    loadCache();
    try {
      const s = await api("GET", "/api/session");
      if (s.authed) await onSignedIn(); else showAuth(s.needsSetup);
    } catch { if (leads.size) { readyResolve(); } }   // offline: show cached data read-only
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  window.LD = {
    api, server: () => server, onServer: f => { serverSubs.add(f); return () => serverSubs.delete(f); },
    pushState, enablePush, disablePush, isStandalone, isIOS,
    async logout() { await api("POST", "/api/logout").catch(() => {}); try { localStorage.removeItem(CACHE_KEY); } catch {} location.reload(); },
  };
})();
