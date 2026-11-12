// Vite fills these values with this build's complete app shell and assets.
const BASE = "__LIBRIS_BASE__";
const REVISION = "__LIBRIS_REVISION__";
const SHELL = "__LIBRIS_SHELL__";
const PRECACHE = ["__LIBRIS_PRECACHE__"];
const PREFIX = "libris-offline:";
const CACHE = `${PREFIX}${BASE}:${REVISION}`;
const ASSETS = new Set(PRECACHE);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload" })));
      for (const path of [BASE, `${BASE}index.html`]) {
        const page = await cache.match(path);
        if (!page || await page.text() !== SHELL) throw new Error("The app changed during download; retry the update online.");
      }
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
  // Wait for existing tabs to close before replacing their complete cached build.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) =>
      (key.startsWith(`${PREFIX}${BASE}:`) || /^libris-focus-pages-v\d+$/.test(key)) && key !== CACHE,
    ).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function navigation(request) {
  const cache = await caches.open(CACHE);
  const shell = await cache.match(BASE);
  try {
    const response = await fetch(request);
    if (!response.ok) return shell || response;
    // A newer index may reference bundles belonging to a waiting worker. Keep
    // this build together until that worker can activate after old tabs close.
    if (shell && await response.clone().text() !== await shell.clone().text()) return shell;
    return response;
  } catch (error) {
    if (shell) return shell;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  if (request.mode === "navigate" && (url.pathname === BASE || url.pathname === `${BASE}index.html`)) {
    event.respondWith(navigation(request));
    event.waitUntil(self.registration.update().catch(() => undefined));
    return;
  }
  // Only cache this build's explicit static files. Missing assets and other
  // routes always use the network and never receive HTML in place of a script.
  if (!ASSETS.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) =>
    await cache.match(url.pathname) || fetch(request),
  ));
});
