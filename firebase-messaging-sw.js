/* Soundcheck — Firebase Cloud Messaging service worker.
   Served from the site root so push notifications work when the app is
   closed/backgrounded. Keep the SDK version in sync with the app (10.12.0)
   and the config identical to firebaseConfig in the HTML. */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBzC67RTBTHDhUEn0Vxe1FWFrFBwq5UK2Q",
  authDomain: "soundcheck-1f16b.firebaseapp.com",
  projectId: "soundcheck-1f16b",
  storageBucket: "soundcheck-1f16b.firebasestorage.app",
  messagingSenderId: "720440182108",
  appId: "1:720440182108:web:48fd85d99bd4cc7da32d99"
});

// Background handler. FCM auto-displays messages that carry a `notification`
// payload (which our functions send), so this is mostly a safety net + logging.
const messaging = firebase.messaging();
messaging.onBackgroundMessage(function (payload) {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'Soundcheck', {
    body: n.body || '',
    icon: 'https://ofiralon10.github.io/soundcheck/icon-192.png',
    data: { link: (payload.fcmOptions && payload.fcmOptions.link) || 'https://ofiralon10.github.io/soundcheck/' }
  });
});

// Tapping the notification focuses/opens the app.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.link) || 'https://ofiralon10.github.io/soundcheck/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (const c of list) { if (c.url.indexOf(url) === 0 && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
