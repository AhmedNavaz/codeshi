// Remote access's service worker. It's here only for lock-screen notifications (#23): it caches nothing and handles
// no requests, so the page still loads fresh from the network every time. Your computer encrypts each notification
// for this browser, and it says only what happened and in which workspace.
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* Shown as a plain notice below. */ }
  const title = typeof message.title === 'string' && message.title ? message.title.slice(0, 80) : 'Codeshi';
  const projectId = typeof message.projectId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(message.projectId) ? message.projectId : null;
  // Every push shows a notification: iPhone stops delivering to a page that receives pushes silently.
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof message.body === 'string' ? message.body.slice(0, 120) : '',
    tag: typeof message.tag === 'string' ? message.tag.slice(0, 160) : undefined,
    icon: '/icon-192.png', badge: '/icon-192.png',
    data: { projectId },
  }));
});

// A tap opens Codeshi at that workspace. An approval is never answered from the notification itself.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const projectId = event.notification.data?.projectId || null;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) {
      if (projectId) open.postMessage({ type: 'codeshi-open-workspace', projectId });
      return open.focus();
    }
    return self.clients.openWindow(projectId ? `/?workspace=${encodeURIComponent(projectId)}` : '/');
  })());
});
