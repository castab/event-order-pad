import { self as worker } from '$app/service-worker';
import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { asset, resolve } from '$app/paths';

const cacheName = `order-pad-${version}`;
// Manifest paths are base-relative; the cache and fetch handler match
// root-absolute pathnames. `immutable` is typed as plain strings, which
// `resolve` would reject without the cast.
const pathname = (path: string) => resolve(path as '');
const precache = [
  ...new Set([
    ...immutable.map((entry) => pathname(entry.path)),
    ...assets.map((entry) => asset(entry.path)),
    ...prerendered.map((entry) => pathname(entry.path)),
    '/',
  ]),
];
// How long a navigation waits for the network before using the cached shell.
const navigationTimeoutMs = 3000;

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

// Prefer the live shell so a reload picks up a new deployment immediately;
// fall back to the cached shell when offline or the host is slow.
async function navigate(request: Request, cache: Cache): Promise<Response> {
  const network = fetch(request).then((response) => {
    if (!response.ok) throw new Error(`Navigation failed: ${response.status}`);
    return response;
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('Navigation timed out')),
      navigationTimeoutMs,
    ),
  );
  try {
    return await Promise.race([network, timeout]);
  } catch {
    // Keep a timed-out request from becoming an unhandled rejection.
    network.catch(() => undefined);
    const shell =
      (await cache.match(new URL(request.url).pathname)) ??
      (await cache.match('/'));
    return (
      shell ??
      new Response('Offline asset unavailable. Load this app online first.', {
        status: 503,
      })
    );
  }
}

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Printer status/outcomes must remain live even for navigation requests.
  if (url.pathname.startsWith('/api/')) return;
  // Only app assets: external printer/app traffic is never intercepted/cached.
  if (event.request.method !== 'GET' || url.origin !== worker.location.origin)
    return;
  const isNavigation = event.request.mode === 'navigate';
  if (!precache.includes(url.pathname) && !isNavigation) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      if (isNavigation) return navigate(event.request, cache);
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
