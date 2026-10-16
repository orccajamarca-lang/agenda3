const CACHE = 'mi-agenda-v5';
const CORE = ['./', './app.js', './config.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./') : Response.error()))
    )
  );
});

// --- Alarmas / notificaciones ---
self.addEventListener('notificationclick', e => {
  const data = e.notification.data || {};
  e.notification.close();

  if (e.action === 'snooze') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length) {
          clients[0].postMessage({ type: 'SNOOZE_ALARM', id: data.id, kind: data.kind || 'tarea' });
          return clients[0].focus();
        }
        return self.clients.openWindow('./?alarm=' + encodeURIComponent(data.id || ''));
      })
    );
    return;
  }

  if (e.action === 'done') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length) {
          clients[0].postMessage({ type: 'DONE_ALARM', id: data.id, kind: data.kind || 'tarea' });
          return clients[0].focus();
        }
        return self.clients.openWindow('./?done=' + encodeURIComponent(data.id || ''));
      })
    );
    return;
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'SHOW_ALARM') return;
  const d = e.data;
  e.waitUntil(
    self.registration.showNotification(d.title || 'Alarma', {
      body: d.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/favicon-32.png',
      tag: d.tag || ('alarm-' + (d.id || Date.now())),
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 120, 300, 120, 300, 120, 500],
      silent: false,
      data: { id: d.id, kind: d.kind || 'tarea' },
      actions: [
        { action: 'done', title: '✓ Hecha' },
        { action: 'snooze', title: '⏱ +10 min' }
      ]
    })
  );
});
