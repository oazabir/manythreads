/*
 * The service worker for browser push (PLAN P14-09; docs/plugins/notifications.md). The browser wakes it when the server sends a push, even with
 * no tab open. A file of our own origin served as is (no build step), written in the plain `var` style of the other public scripts.
 *
 * What it does, and no more:
 *  - on a push: read the small JSON the server sent (a title, one line of body, a tag and a path), and show it as a system notification; if a tab of
 *    this site is open, visible and focused, show nothing (the page already tells the person);
 *  - on a click: close the notification and bring up the site at the path the push named, but only a path of this site that opens a message.
 * It caches nothing, intercepts no requests and keeps no data.
 */
(function () {
  'use strict';

  var asText = function (value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  };

  /** The push's JSON made safe: strings of bounded length, a path that is ours. */
  var read = function (data) {
    var raw = null;
    try {
      raw = data ? data.json() : null;
    } catch (e) {
      raw = null;
    }
    if (!raw || raw.v !== 1) return { title: 'manythreads', body: 'You have a new notification.', tag: 'manythreads', url: '/' };
    return {
      title: asText(raw.title, 200) || 'manythreads',
      body: asText(raw.body, 200),
      tag: asText(raw.tag, 80) || 'manythreads',
      url: openPath(asText(raw.url, 300)),
    };
  };

  /** Only `/open?...` of this site; anything else (another site, another path) becomes the home page. */
  var openPath = function (url) {
    try {
      var parsed = new URL(url, self.location.origin);
      if (parsed.origin !== self.location.origin || parsed.pathname !== '/open') return '/';
      return parsed.pathname + parsed.search;
    } catch (e) {
      return '/';
    }
  };

  self.addEventListener('install', function () {
    self.skipWaiting();
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener('push', function (event) {
    var note = read(event.data);
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
        var watching = windows.some(function (w) {
          return w.visibilityState === 'visible' && w.focused;
        });
        if (watching) return undefined;
        return self.registration.showNotification(note.title, { body: note.body, tag: note.tag, data: { url: note.url } });
      }),
    );
  });

  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var url = openPath(asText(event.notification.data && event.notification.data.url, 300));
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
        var open = windows.find(function (w) {
          return new URL(w.url).origin === self.location.origin;
        });
        if (open) {
          // the page opens the message inside the app, without a reload
          open.postMessage({ type: 'manythreads.open', url: url });
          return open.focus();
        }
        return self.clients.openWindow(url);
      }),
    );
  });
})();
