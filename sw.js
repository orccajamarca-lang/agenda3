/* Mi Agenda v4.0.0 — Service Worker */
const CACHE = 'mi-agenda-v7';
const CORE = [
  '/',
  '/index.html',
  '/app.js',
  '/config.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Red primero (siempre la última versión); caché solo si no hay conexión
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('/') : Response.error()))
      )
  );
});

function avisarCliente(tipo, data, urlParam) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    if (clients.length) {
      clients[0].postMessage({ type: tipo, id: data.id, kind: data.kind || 'tarea' });
      return clients[0].focus();
    }
    return self.clients.openWindow('/?' + urlParam + '=' + encodeURIComponent(data.id || '') +
      '&kind=' + encodeURIComponent(data.kind || 'tarea'));
  });
}

self.addEventListener('notificationclick', e => {
  const data = e.notification.data || {};
  e.notification.close();

  if (e.action === 'snooze') { e.waitUntil(avisarCliente('SNOOZE_ALARM', data, 'snooze')); return; }
  if (e.action === 'done')   { e.waitUntil(avisarCliente('DONE_ALARM', data, 'done')); return; }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});

// Compatibilidad: la página también puede pedir la notificación por mensaje
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'SHOW_ALARM') return;
  const d = e.data;
  e.waitUntil(
    self.registration.showNotification(d.title || 'Alarma', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32.png',
      tag: d.tag || ('alarm-' + (d.id || Date.now())),
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 120, 300, 120, 300, 120, 500],
      data: { id: d.id, kind: d.kind || 'tarea' },
      actions: [
        { action: 'done', title: '✓ Hecha' },
        { action: 'snooze', title: '⏱ +10 min' }
      ]
    })
  );
});
