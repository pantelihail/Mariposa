/* =====================================================================
   MARIPOSA · piezas de pantalla compartidas (Almacén y Ventas)

   Todo el texto que viene de la base de datos se pone con textContent:
   nunca se arma HTML con datos de la tienda (así nadie puede colar código).
   Solo se usa innerHTML con marcas fijas escritas aquí (la mariposa, la X).

   UI.el(tag, cls, text)        crea un elemento
   UI.clear(node)               vacía un elemento
   UI.toast(msg, kind)          aviso breve ('ok' | 'bad' | nada)
   UI.modal.open(title, body)   ventana; UI.modal.close()
   UI.field(label, input, hint) campo con etiqueta y error: field.setError('texto')
   UI.input(type, value, max)   <input> listo
   UI.select(options, value)    options = [[valor, texto], ...]
   UI.armConfirm(btn, label, fn) primer toque arma, segundo (en 4 s) ejecuta
   UI.busy(btn, promise)        bloquea el botón mientras dura la promesa
   UI.header(opts)              barra superior con marca, nombre de la app y Salir
   UI.authGate(opts)            pantalla de entrar + verificación + permisos
   UI.registerSW()              deja la app instalable y abrible sin internet
   ===================================================================== */
(function (global) {
  'use strict';
  var M = global.Mariposa;
  var UI = {};
  global.UI = UI;

  UI.$ = function (id) { return document.getElementById(id); };
  UI.el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  UI.clear = function (n) { while (n.firstChild) n.removeChild(n.firstChild); return n; };

  var MARK = '<svg viewBox="0 0 32 24" aria-hidden="true" focusable="false"><g fill="currentColor">' +
    '<path d="M16 11 C11 1 1 2 3 10 C4 14 11 14 16 12 Z"/><path d="M16 12.5 C11 13 5 16 7 21 C9 24 14 20 16 14.5 Z"/>' +
    '<g transform="translate(32 0) scale(-1 1)"><path d="M16 11 C11 1 1 2 3 10 C4 14 11 14 16 12 Z"/><path d="M16 12.5 C11 13 5 16 7 21 C9 24 14 20 16 14.5 Z"/></g>' +
    '<rect x="15.1" y="7" width="1.8" height="14" rx="0.9"/></g>' +
    '<path d="M15.5 7.5 C15 4 13.5 2.5 11.5 2 M16.5 7.5 C17 4 18.5 2.5 20.5 2" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/></svg>';
  UI.markHtml = MARK;

  /* ---------- aviso breve ---------- */
  var toastTimer, toastEl;
  UI.toast = function (msg, kind) {
    if (!toastEl) { toastEl = UI.el('div', 'toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); document.body.appendChild(toastEl); }
    toastEl.className = 'toast' + (kind ? ' toast-' + kind : '');
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, kind === 'bad' ? 6000 : 3500);
  };

  /* ---------- ventana ---------- */
  var modalEl = null, returnFocus = null, onCloseCb = null;
  function buildModal() {
    modalEl = UI.el('div', 'modal');
    modalEl.hidden = true;
    var scrim = UI.el('div', 'modal-scrim');
    var card = UI.el('div', 'modal-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'modalTitle');
    var top = UI.el('div', 'modal-top');
    var h = UI.el('h2'); h.id = 'modalTitle';
    var x = UI.el('button', 'x-btn'); x.type = 'button'; x.setAttribute('aria-label', 'Cerrar');
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    x.addEventListener('click', function () { UI.modal.close(); });
    scrim.addEventListener('click', function () { UI.modal.close(); });
    top.appendChild(h); top.appendChild(x);
    var body = UI.el('div'); body.id = 'modalBody';
    card.appendChild(top); card.appendChild(body);
    modalEl.appendChild(scrim); modalEl.appendChild(card);
    modalEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(modalEl.querySelectorAll('a[href], button, input, select, textarea'), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modalEl.hidden) UI.modal.close(); });
    document.body.appendChild(modalEl);
  }
  UI.modal = {
    open: function (title, bodyEl, onClose) {
      if (!modalEl) buildModal();
      modalEl.querySelector('#modalTitle').textContent = title;
      var body = modalEl.querySelector('#modalBody');
      UI.clear(body); body.appendChild(bodyEl);
      onCloseCb = onClose || null;
      returnFocus = document.activeElement;
      modalEl.hidden = false;
      document.body.style.overflow = 'hidden';
      var first = body.querySelector('input:not([type=file]):not([type=hidden]), select, textarea, button');
      if (first) first.focus();
    },
    close: function () {
      if (!modalEl || modalEl.hidden) return;
      modalEl.hidden = true;
      UI.clear(modalEl.querySelector('#modalBody'));
      document.body.style.overflow = '';
      var cb = onCloseCb; onCloseCb = null;
      if (returnFocus && document.contains(returnFocus) && returnFocus.focus) returnFocus.focus();
      returnFocus = null;
      if (cb) cb();
    },
    isOpen: function () { return !!modalEl && !modalEl.hidden; }
  };

  /* ---------- formularios ---------- */
  var fid = 0;
  UI.field = function (label, input, hint) {
    var id = 'f' + (++fid);
    input.id = id;
    var w = UI.el('div', 'field');
    var l = UI.el('label', null, label); l.setAttribute('for', id);
    w.appendChild(l); w.appendChild(input);
    if (hint) w.appendChild(UI.el('p', 'hint', hint));
    var err = UI.el('p', 'err'); err.id = id + '-err'; err.hidden = true; err.setAttribute('role', 'alert');
    w.appendChild(err);
    input.setAttribute('aria-describedby', err.id);
    w.setError = function (msg) { err.textContent = msg || ''; err.hidden = !msg; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); };
    return w;
  };
  UI.input = function (type, value, max) {
    var i = UI.el('input'); i.type = type; i.value = value == null ? '' : value;
    if (max) i.maxLength = max;
    i.autocomplete = 'off';
    return i;
  };
  UI.select = function (options, value) {
    var s = UI.el('select');
    options.forEach(function (o) { var op = UI.el('option', null, o[1]); op.value = o[0]; s.appendChild(op); });
    if (value != null) s.value = value;
    return s;
  };
  UI.armConfirm = function (btn, armedLabel, action) {
    var orig = btn.textContent, armed = false, t;
    function reset() { armed = false; btn.textContent = orig; btn.classList.remove('armed'); }
    btn.addEventListener('click', function () {
      if (!armed) { armed = true; btn.textContent = armedLabel; btn.classList.add('armed'); t = setTimeout(reset, 4000); return; }
      clearTimeout(t); reset(); action();
    });
  };
  UI.busy = function (btn, promise) {
    btn.disabled = true;
    var done = function () { btn.disabled = false; };
    promise.then(done, done);
    return promise;
  };

  /* ---------- barra superior ---------- */
  // opts: { app: 'Almacén', session, onSignOut }
  UI.header = function (opts) {
    var bar = UI.el('header', 'topbar');
    var wrap = UI.el('div', 'wrap');
    var brand = UI.el('div', 'brand');
    brand.innerHTML = MARK;
    brand.appendChild(UI.el('span', 'brand-name', 'Mariposa'));
    brand.appendChild(UI.el('span', 'brand-app', opts.app));
    var who = UI.el('div', 'who');
    var s = opts.session;
    if (s) who.appendChild(UI.el('span', 'who-name', s.name || s.email));
    var out = UI.el('button', 'btn btn-sm btn-quiet', 'Salir'); out.type = 'button';
    out.addEventListener('click', function () { if (opts.onSignOut) opts.onSignOut(); });
    who.appendChild(out);
    wrap.appendChild(brand); wrap.appendChild(who);
    bar.appendChild(wrap);
    return bar;
  };

  /* ---------- entrar ----------
     opts: {
       root:    elemento donde se dibuja,
       api:     lo que devuelve Mariposa.open({staff:true,...}),
       title:   'Almacén' | 'Ventas',
       allow:   ['owner'] o ['owner','worker','assistant'],
       onReady: function (session) -> se llama cuando hay una sesión permitida,
       onSignedOut: function () -> opcional
     }
     Devuelve { signOut() }.  */
  UI.authGate = function (opts) {
    var root = opts.root, api = opts.api;
    var started = false;

    function frame(inner) {
      UI.clear(root);
      var box = UI.el('main', 'login');
      var card = UI.el('div', 'login-card');
      var brand = UI.el('div', 'login-brand');
      brand.innerHTML = MARK;
      brand.appendChild(UI.el('span', 'brand-name', 'Mariposa'));
      card.appendChild(brand);
      card.appendChild(UI.el('p', 'login-sub', opts.title));
      card.appendChild(inner);
      box.appendChild(card);
      root.appendChild(box);
      var first = card.querySelector('input, button');
      if (first) first.focus();
    }
    function note(text) {
      var d = UI.el('div', 'center-note'); d.appendChild(UI.el('div', 'spinner')); d.appendChild(UI.el('p', null, text));
      return d;
    }

    function allowed(s) { return !!s && opts.allow.indexOf(s.role) !== -1; }

    function ready(s) {
      started = true;
      UI.clear(root);
      opts.onReady(s);
    }
    function denied(s) {
      var box = UI.el('div');
      var msg = !s.role
        ? 'Esta cuenta todavía no tiene permisos. Pídele a la dueña que te dé acceso.'
        : 'Esta cuenta no puede entrar a esta parte. ' + (opts.title === 'Almacén' ? 'Solo la dueña configura el almacén.' : '');
      box.appendChild(UI.el('p', 'center-note', msg));
      var out = UI.el('button', 'btn btn-block', 'Salir'); out.type = 'button';
      out.addEventListener('click', function () { signOut(); });
      box.appendChild(out);
      frame(box);
    }
    function handle(s) { if (allowed(s)) ready(s); else denied(s); }

    function signOut() {
      var p = api.signOut();
      return Promise.resolve(p).then(function () { started = false; if (opts.onSignedOut) opts.onSignedOut(); showLogin(); });
    }

    function mfaForm(factorId) {
      var form = UI.el('form'); form.noValidate = true;
      form.appendChild(UI.el('p', 'hint', 'Escribe el código de 6 números de tu app de verificación.'));
      var code = UI.input('text', '', 8); code.inputMode = 'numeric'; code.autocomplete = 'one-time-code';
      var f = UI.field('Código', code);
      form.appendChild(f);
      var go = UI.el('button', 'btn btn-primary btn-block', 'Verificar'); go.type = 'submit';
      form.appendChild(go);
      var back = UI.el('button', 'link-btn', 'Volver'); back.type = 'button';
      back.addEventListener('click', function () { api.signOut(); showLogin(); });
      var line = UI.el('div', 'center-note'); line.style.padding = '12px 0 0'; line.appendChild(back);
      form.appendChild(line);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!code.value.trim()) { f.setError('Escribe el código.'); return; }
        f.setError('');
        UI.busy(go, api.verifyMfa(factorId, code.value).then(handle, function (er) { f.setError(M.errorText(er)); code.select(); }));
      });
      frame(form);
    }

    function showLogin(prefillError) {
      var form = UI.el('form'); form.noValidate = true;
      var email = UI.input('email', '', 120); email.autocomplete = 'username'; email.inputMode = 'email';
      var fe = UI.field('Correo', email);
      var pass = UI.input('password', '', 100); pass.autocomplete = 'current-password';
      var fp = UI.field('Contraseña', pass);
      form.appendChild(fe); form.appendChild(fp);
      var general = UI.el('p', 'err'); general.hidden = true; general.setAttribute('role', 'alert');
      form.appendChild(general);
      var go = UI.el('button', 'btn btn-primary btn-block', 'Entrar'); go.type = 'submit';
      form.appendChild(go);
      if (api.demoHint) form.appendChild(UI.el('p', 'login-hint', api.demoHint));
      if (prefillError) { general.textContent = prefillError; general.hidden = false; }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        fe.setError(email.value.trim() ? '' : 'Escribe tu correo.');
        fp.setError(pass.value ? '' : 'Escribe tu contraseña.');
        if (!email.value.trim() || !pass.value) return;
        general.hidden = true;
        UI.busy(go, api.signIn(email.value, pass.value).then(function (r) {
          if (r.mfaRequired) mfaForm(r.factorId); else handle(r.session);
        }, function (er) { general.textContent = M.errorText(er); general.hidden = false; pass.select(); }));
      });
      frame(form);
    }

    function failure(er) {
      var box = UI.el('div');
      box.appendChild(UI.el('p', 'center-note', M.errorText(er)));
      var again = UI.el('button', 'btn btn-primary btn-block', 'Reintentar'); again.type = 'button';
      again.addEventListener('click', start);
      box.appendChild(again);
      frame(box);
    }

    function start() {
      frame(note('Cargando…'));
      api.restore().then(function (s) { if (s) handle(s); else showLogin(); }, failure);
    }

    if (api.onAuthChange) {
      api.onAuthChange(function (event) { if (event === 'SIGNED_OUT' && started) { started = false; if (opts.onSignedOut) opts.onSignedOut(); showLogin('Tu sesión terminó. Entra otra vez.'); } });
    }
    start();
    return { signOut: signOut };
  };

  /* ---------- instalable y sin internet ---------- */
  UI.registerSW = function () {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(function () {});
  };
})(window);
