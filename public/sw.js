/* Lead Diary service worker: opens fast and offline (app shell), shows reminders, opens the right lead on tap. */
const SHELL = "ld-shell-v1";
const FILES = ["/", "/index.html", "/runtime.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // network first so updates show up straight away; cache when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && (FILES.includes(url.pathname) || url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/icons/"))) {
      const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match("/index.html"))));
});

self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Lead Diary", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Lead Diary", {
    body: d.body || "", tag: d.tag, renotify: !!d.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(location.origin)) { c.postMessage({ type: "open", url }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
