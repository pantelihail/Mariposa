/* Evita que otra página meta esta en un marco (clickjacking). */
(function () {
  var c = window.MARIPOSA_CONFIG || {};
  if (c.demo) return;
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location.href = window.self.location.href; } catch (e) {}
  }
})();
