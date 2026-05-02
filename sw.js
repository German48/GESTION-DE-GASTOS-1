const CACHE_NAME = 'gestion-madera-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './css/style.css',
    './js/script.js',
    './js/supabase-config.js',
    './js/supabase-client.js',
    './assets/icons.svg',
    './assets/icon-192.png',
    './assets/icon-512.png',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js'
];

// Instalación: Cachear activos estáticos
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Cacheando activos estáticos');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Activación: Limpiar caches antiguos
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Borrando cache antigua:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch: Estrategia Network First con fallback a Cache
// Excepto para llamadas a la API de Supabase que deberían ser siempre Network First
self.addEventListener('fetch', (event) => {
    // Omitir peticiones externas que no queremos cachear o que son dinámicas (ej: Supabase API)
    if (event.request.url.includes('supabase.co')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Clonar la respuesta para guardarla en cache
                const resClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, resClone);
                });
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
