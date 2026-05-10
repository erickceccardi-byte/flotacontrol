// FlotaControl Service Worker
// Estrategia: NETWORK-FIRST para HTML/JS/CSS (siempre intenta traer fresh
// y cae al caché si no hay red). Esto resuelve el problema de "los choferes
// no ven los cambios después de un push" — el problema clásico del cache
// agresivo en PWAs.
//
// Cuando hay actualización del HTML, se renueva en cuanto el chofer abre
// la app con red. Si está offline, sigue funcionando con la copia cacheada.
//
// Background Sync: cuando el chofer registra una carrera offline (o el
// push falla), la carrera queda en IndexedDB con synced=0. La página
// llama a reg.sync.register('sync-trips') y este SW se queda escuchando.
// Cuando el navegador detecta conexión (incluso con la app cerrada), nos
// despierta y subimos las carreras pendientes. Soportado en Chrome/Edge
// Android. iOS Safari no lo soporta — esos siguen el flujo de auto-sync
// dentro de la página.
//
// IMPORTANTE: bumpear CACHE cada vez que haya un cambio mayor para forzar
// limpieza de versiones anteriores.

const CACHE = 'flotacontrol-v58';
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

// ════════════════════════════════════════════════════════════════════
// BACKGROUND SYNC: subir carreras pendientes aunque la app esté cerrada
// ════════════════════════════════════════════════════════════════════
const PB_URL = 'https://ecocargo.app';
const DB_NAME = 'flotacontrol_db';
const DB_VER = 2;

function _swOpenDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onsuccess = e => res(e.target.result);
    req.onerror = () => rej(req.error);
  });
}

function _swGetUnsynced(db) {
  return new Promise((res, rej) => {
    let tx;
    try { tx = db.transaction('trips', 'readonly'); }
    catch(e) { return res([]); }
    const idx = tx.objectStore('trips').index('synced');
    const req = idx.getAll(0);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

function _swSaveTrip(db, trip) {
  return new Promise((res, rej) => {
    const tx = db.transaction('trips', 'readwrite');
    const req = tx.objectStore('trips').put(trip);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

async function _swPbReq(path, opts) {
  const r = await fetch(PB_URL + path, {
    ...(opts || {}),
    headers: { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('PB ' + r.status + ': ' + txt.substring(0, 200));
  }
  return r.status === 204 ? null : r.json();
}

// Buscar trip existente por (date, trip_id) — claves de negocio del polyfill
async function _swPbFindOne(date, tripId) {
  const filter = `date='${String(date).replace(/'/g, "\\'")}' && trip_id='${String(tripId).replace(/'/g, "\\'")}'`;
  const params = new URLSearchParams({ page: '1', perPage: '1', filter });
  const r = await _swPbReq('/api/collections/trips/records?' + params.toString());
  return (r && r.items && r.items[0]) || null;
}

function _swStripPb(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const k of Object.keys(rec)) {
    if (['id','created','updated','collectionId','collectionName'].indexOf(k) >= 0) continue;
    out[k] = rec[k];
  }
  return out;
}

async function _swPushTrip(trip) {
  const stripped = _swStripPb({ ...trip, synced: 1, trip_id: trip.id });
  if (stripped.audioB64 && stripped.audioB64.length > 500000) {
    stripped.audioB64 = '[audio-local-only]';
  }
  // Si ya existe en PB → patch; si no → create
  const existing = await _swPbFindOne(trip.date, trip.id);
  if (existing) {
    return _swPbReq('/api/collections/trips/records/' + existing.id, {
      method: 'PATCH', body: JSON.stringify(stripped)
    });
  }
  return _swPbReq('/api/collections/trips/records', {
    method: 'POST', body: JSON.stringify(stripped)
  });
}

async function _swSyncAllPending() {
  let db;
  try { db = await _swOpenDb(); }
  catch(e) { console.warn('[SW Sync] open DB failed:', e.message); return { ok: 0, fail: 0 }; }
  const pending = await _swGetUnsynced(db);
  if (!pending.length) {
    console.log('[SW Sync] no pending trips');
    return { ok: 0, fail: 0 };
  }
  let ok = 0, fail = 0, lastError = null;
  for (const trip of pending) {
    try {
      await _swPushTrip(trip);
      await _swSaveTrip(db, { ...trip, synced: 1 });
      ok++;
      console.log('[SW Sync] uploaded', trip.id);
    } catch(e) {
      lastError = e;
      console.warn('[SW Sync] failed for', trip.id, e.message);
      fail++;
    }
  }
  console.log(`[SW Sync] done: ok=${ok} fail=${fail}`);
  // Notificar a las páginas abiertas (si hay) para que refresquen
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'sync-done', ok, fail }));
  } catch(e) {}
  // Si todas fallaron, throw para que el navegador retry
  if (fail > 0 && ok === 0 && lastError) {
    throw lastError;
  }
  return { ok, fail };
}

// ── Background Sync event ── (Chrome/Edge Android)
self.addEventListener('sync', event => {
  if (event.tag !== 'sync-trips') return;
  console.log('[SW Sync] sync event triggered');
  event.waitUntil(_swSyncAllPending().catch(e => {
    console.error('[SW Sync] error:', e);
    throw e; // hace que el browser reintente
  }));
});

// ── Periodic Background Sync ── (requiere PWA instalada + permission)
self.addEventListener('periodicsync', event => {
  if (event.tag !== 'periodic-sync-trips') return;
  console.log('[SW Sync] periodic sync triggered');
  event.waitUntil(_swSyncAllPending().catch(e => console.error('[SW Sync] error:', e)));
});

// ── Mensajes desde la página: trigger sync manual ──
self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'force-sync') {
    event.waitUntil(_swSyncAllPending().catch(e => console.error('[SW Sync] error:', e)));
  }
});
