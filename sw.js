// Service worker do SAMP: deixa o sistema instalável (PWA) e mostra a última versão salva se a rede cair.
// Estratégia "rede primeiro": com internet, sempre vale a versão mais nova (nada fica velho); os dados vêm do servidor e não são guardados aqui.
const VERSAO = 'samp-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;   // Supabase, bibliotecas externas etc. não passam por aqui
  e.respondWith(
    fetch(r).then((res) => {
      if (res.ok) { const c = res.clone(); caches.open(VERSAO).then((ca) => ca.put(r, c)); }
      return res;
    }).catch(() => caches.match(r).then((m) => m || caches.match('index.html')))
  );
});
