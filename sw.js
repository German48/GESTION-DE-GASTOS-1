const STATIC_CACHE = 'gestion-static-v1';
const DATA_CACHE   = 'gestion-data-v1';
const IMAGE_CACHE  = 'gestion-img-v1';
const SYNC_DB      = 'gestion-sync';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/script.js',
  './js/supabase-config.js',
  './js/supabase-client.js',
  './js/ocr-external-config.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://unpkg.com/tesseract.js@5.0.0/dist/tesseract.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js',
];

/* ---------- INSTALL ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

/* ---------- ACTIVATE ---------- */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => ![STATIC_CACHE, DATA_CACHE, IMAGE_CACHE].includes(n))
          .map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

/* ---------- FETCH ---------- */
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Supabase REST API
  if (url.hostname.includes('supabase.co')) {
    if (request.method === 'GET') {
      e.respondWith(networkFirst(request, DATA_CACHE));
    } else {
      e.respondWith(networkWithSyncFallback(request));
    }
    return;
  }

  // 2. Imágenes (facturas subidas, iconos…)
  if (request.destination === 'image') {
    e.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // 3. CSS / JS / HTML
  if (['style', 'script', 'document'].includes(request.destination)) {
    e.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // 4. Todo lo demás
  e.respondWith(networkFirst(request, DATA_CACHE));
});

/* ---------- SYNC (Background Sync) ---------- */
self.addEventListener('sync', (e) => {
  if (e.tag === 'sync-gastos') {
    e.waitUntil(flushSyncQueue());
  }
});

/* ---------- ESTRATEGIAS ---------- */

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const network = await fetch(request);
    cache.put(request, network.clone());
    return network;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Sin conexión ni cache');
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network);
}

/* ---------- OFFLINE SYNC ---------- */

async function networkWithSyncFallback(request) {
  try {
    return await fetch(request);
  } catch {
    // Guardar en IndexedDB para sincronizar después
    await queueRequest(request);
    return jsonResponse({
      ok: true,
      offline: true,
      message: 'Movimiento guardado localmente. Se sincronizará cuando haya conexión.',
    });
  }
}

async function queueRequest(request) {
  const db = await openDB(SYNC_DB, 1, (db) => {
    if (!db.objectStoreNames.contains('queue')) {
      db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    }
  });
  const clone = request.clone();
  const body = await clone.text().catch(() => null);
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  await store.add({
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body,
    timestamp: Date.now(),
  });
  db.close();
}

async function flushSyncQueue() {
  const db = await openDB(SYNC_DB, 1);
  const tx = db.transaction('queue', 'readonly');
  const store = tx.objectStore('queue');
  const items = await store.getAll();
  db.close();

  for (const item of items) {
    try {
      await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      // Borrar si tuvo éxito
      const db2 = await openDB(SYNC_DB, 1);
      const tx2 = db2.transaction('queue', 'readwrite');
      await tx2.objectStore('queue').delete(item.id);
      db2.close();
    } catch {
      // Dejar en cola para la próxima vez
    }
  }

  // Notificar a las pestañas abiertas
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((c) =>
    c.postMessage({ type: 'sync-complete', synced: items.length })
  );
}

/* ---------- UTILS ---------- */

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openDB(name, version, upgradeFn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      if (upgradeFn) upgradeFn(e.target.result);
    };
  });
}
