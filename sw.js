// FlotaControl Service Worker
// Estrategia: NETWORK-FIRST para HTML/JS/CSS (siempre intenta traer fresh
// y cae al caché si no hay red). Esto resuelve el problema de "los choferes
// no ven los cambios después de un push" — el problema clásico del cache
// agresivo en PWAs.
//
// Cuando hay actualización del HTML, se renueva en cuanto el chofer abre
// la app con red. Si está offline, sigue funcionando con la copia cacheada.
//
// IMPORTANTE: bumpear CACHE cada vez que haya un cambio mayor para forzar
// limpieza de versiones anteriores.

const CACHE = 'flotacontrol-v11';
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE_URLS).catch(() => null))
  );
  self.skipWaiting();
});

// ── ACTIVATE ── (limpia caches viejos)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH ── network-first con fallback a cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Sólo gestionamos peticiones del mismo origen; las externas (Firebase,
  // Traccar, etc.) las dejamos pasar directo a la red sin cachear.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Si la red respondió OK, actualizamos el cache y devolvemos.
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request)) // sin red → usa lo cacheado
  );
});
