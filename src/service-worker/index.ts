import { self as worker } from '$app/service-worker';
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { asset, resolve } from '$app/paths';

const cacheName = `order-pad-auth-${version}`;
// Manifest paths are base-relative; the cache and fetch handler match
// root-absolute pathnames. `immutable` is typed as plain strings, which
// `resolve` would reject without the cast.
const pathname = (path: string) => resolve(path as '');
const precache = [
  ...new Set([
    ...immutable.map((entry) => pathname(entry.path)),
    ...assets.map((entry) => asset(entry.path)),
  ]),
];
worker.addEventListener('install', (event) => {
  // `reload` bypasses the HTTP cache so a new version never precaches stale files.
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) =>
        cache.addAll(
          precache.map((path) => new Request(path, { cache: 'reload' })),
        ),
      ),
  );
  // Deliberately do not skipWaiting on install: never replace a page's assets
  // during a send. The page asks for activation when it is safe (SKIP_WAITING).
});
worker.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void worker.skipWaiting();
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('order-pad-') && key !== cacheName)
          await caches.delete(key);
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Printer status/outcomes must remain live even for navigation requests.
  if (url.pathname.startsWith('/api/')) return;
  // Only app assets: external printer/app traffic is never intercepted/cached.
  if (event.request.method !== 'GET' || url.origin !== worker.location.origin)
    return;
  // Navigations always reach the service authentication gate; never return an old page.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        () =>
          new Response('Connection unavailable. Reconnect to sign in.', {
            status: 503,
            headers: {
              'Content-Type': 'text/plain',
              'Cache-Control': 'no-store',
            },
          }),
      ),
    );
    return;
  }
  if (!precache.includes(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return new Response(
          'Offline asset unavailable. Load this app online first.',
          { status: 503 },
        );
      }
    })(),
  );
});
