import { precacheAndRoute } from 'workbox-precaching'

precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let message = {}
  try { message = event.data?.json() || {} } catch { message = { body: event.data?.text() || '' } }
  event.waitUntil(self.registration.showNotification(message.title || 'StudentSend', {
    body: message.body || 'มีอัปเดตงานของคุณ',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: message.tag || 'studentsend-update',
    data: { url: message.url || '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.startsWith(self.location.origin))
    if (existing) { existing.focus(); return }
    return self.clients.openWindow(target)
  }))
})
