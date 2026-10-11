/// <reference lib="webworker" />
import { build, files, prerendered, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `order-pad-${version}`;
const assets = [...new Set([...build, ...files, ...prerendered, '/'])];

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
  // Deliberately do not skipWaiting: never replace a page's assets during a send.
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
  if (!assets.includes(url.pathname) && event.request.mode !== 'navigate')
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        if (event.request.mode === 'navigate') {
          const shell = await cache.match('/');
          if (shell) return shell;
        }
        return new Response(
          'Offline asset unavailable. Load this app online first.',
          { status: 503 },
        );
      }
    })(),
  );
});
