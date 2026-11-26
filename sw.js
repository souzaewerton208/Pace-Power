// Service worker do Pace & Power: deixa o app abrir sem internet.
// - A página (index.html) é sempre buscada na rede primeiro; a cópia guardada só é usada sem conexão.
//   Assim cada atualização publicada na Vercel chega na hora, sem ficar presa numa versão velha.
// - Arquivos fixos de terceiros (Firebase, fontes, bibliotecas) vêm da cópia guardada e se atualizam por trás.
// - Nada de dados: Firestore, login e a IA (/api) nunca passam por aqui.
const CACHE = "pp-v2";
const FIXOS = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-180.png"];
const CDN = /^https:\/\/(www\.gstatic\.com\/firebasejs\/|fonts\.googleapis\.com\/|fonts\.gstatic\.com\/|cdnjs\.cloudflare\.com\/)/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FIXOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// lembretes: mostra a notificação que o servidor mandou e, ao tocar, abre o app
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Pace & Power", {
    body: d.body || "", tag: d.tag || "pp", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // páginas do app: rede primeiro, cópia guardada se estiver sem internet
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put("/", c)); return r; })
        .catch(() => caches.match("/"))
    );
    return;
  }
  // ícones e manifesto do próprio site
  if (url.origin === location.origin && (url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest")) {
    e.respondWith(caches.match(req).then((m) => m || fetch(req)));
    return;
  }
  // Firebase, fontes e bibliotecas: cópia guardada na hora e atualização por trás
  if (CDN.test(req.url)) {
    e.respondWith(
      caches.match(req).then((m) => {
        const rede = fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(CACHE).then((k) => k.put(req, c)); } return r; }).catch(() => m);
        return m || rede;
      })
    );
  }
});
