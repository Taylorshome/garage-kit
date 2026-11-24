// Push service worker. Pushes carry no payload: on each push we fetch the newest notifications with the signed-in
// cookie and show them (tag = id, so a repeat replaces instead of stacking). A push must always show something
// (iOS revokes the subscription otherwise), so a fetch failure still shows a generic notice.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    try {
      const r = await fetch('/api/notifications/recent', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      const { notifications = [] } = await r.json();
      if (!notifications.length) throw new Error('none');
      for (const n of notifications.slice(0, 3).reverse()) {
        await self.registration.showNotification(n.title, { body: n.body || '', tag: `garage-${n.id}`, data: { url: n.url || '#/' }, icon: '/icon-192.png', badge: '/icon-192.png' });
      }
    } catch {
      await self.registration.showNotification('Garage', { body: 'Something in your garage needs a look.', tag: 'garage-generic', data: { url: '#/' }, icon: '/icon-192.png' });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL('/' + String(event.notification.data?.url || '#/').replace(/^\/?/, ''), self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if (new URL(w.url).origin === self.location.origin) { await w.navigate(url).catch(() => {}); return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
