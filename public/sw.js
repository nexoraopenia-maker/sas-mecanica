/* Service Worker de Mecania (sin dependencias).
 *
 * - Archivos estáticos de la app (JS/CSS/íconos): se sirven de la caché (cache-first).
 * - Navegaciones: primero la red (con tiempo límite); si falla, la última copia del mostrador (/app/pos) o la
 *   página «sin conexión». Los datos del negocio NUNCA se guardan aquí: el catálogo y las ventas pendientes
 *   viven en IndexedDB y se envían con /api/pos/sync.
 * - /api/*, acciones de servidor y cualquier POST: siempre a la red.
 */
const VERSION = "v1";
const STATIC_CACHE = `mecania-static-${VERSION}`;
const PAGES_CACHE = `mecania-pages-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/aima-logo.png"];
/** Pantallas que se pueden abrir sin conexión (el mostrador). */
const OFFLINE_PAGES = ["/app/pos"];
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("mecania-") && key !== STATIC_CACHE && key !== PAGES_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  // Al cerrar sesión o cambiar de usuario se borran las páginas guardadas (pueden mostrar datos del negocio).
  if (event.data && event.data.type === "CLEAR_PRIVATE_CACHES") {
    event.waitUntil(caches.delete(PAGES_CACHE));
  }
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/aima-logo.png"
  );
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function navigate(request) {
  const url = new URL(request.url);
  const cacheable = OFFLINE_PAGES.includes(url.pathname);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    // Solo se guarda una respuesta HTML correcta y directa (no una redirección al login).
    if (
      cacheable &&
      response.ok &&
      !response.redirected &&
      (response.headers.get("content-type") || "").includes("text/html")
    ) {
      const cache = await caches.open(PAGES_CACHE);
      await cache.put(url.pathname, response.clone());
    }
    return response;
  } catch {
    if (cacheable) {
      // Next marca sus respuestas con `Vary` (RSC, estado del router): para abrir sin conexión basta la ruta.
      const page = await caches.match(url.pathname, {
        cacheName: PAGES_CACHE,
        ignoreVary: true,
        ignoreSearch: true,
      });
      if (page) return page;
    }
    const fallback = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
    return (
      fallback ||
      new Response("Sin conexión", { status: 503, headers: { "content-type": "text/plain" } })
    );
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Navegaciones y precargas del documento HTML (no las peticiones RSC de Next, que piden otro tipo).
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
  if (request.mode === "navigate" || (wantsHtml && !request.headers.get("rsc"))) {
    event.respondWith(navigate(request));
  }
});
