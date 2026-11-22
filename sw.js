/* Mariposa · deja abrir las apps sin internet (guarda una copia de los archivos).
   Primero intenta la red, para que las actualizaciones lleguen; si no hay red, usa la copia.
   Nunca guarda llamadas a la base de datos ni nada de otro sitio. */
var VERSION = 'mariposa-v4';
var SHELL = ['./', 'index.html', 'almacen.html', 'ventas.html', 'config.js', 'icon.svg',
  'tienda.webmanifest', 'css/tienda.css', 'css/panel.css', 'css/cierre.css', 'css/devolucion.css', 'css/almacen.css', 'css/ventas.css',
  'js/guard.js', 'js/api.js', 'js/ui.js', 'js/cierre.js', 'js/devolucion.js', 'js/tienda.js', 'js/almacen.js', 'js/ventas.js', 'js/vendor/supabase.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      });
    })
  );
});
