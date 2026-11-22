/* =====================================================================
   MARIPOSA · Tienda (página pública)
   Solo lectura. Todo lo que viene de la base de datos se escribe con
   textContent (nunca como HTML) y los enlaces se validan.
   Escrito sin ?. ni ?? para teléfonos viejos.
   ===================================================================== */
(function () {
  'use strict';

  var M = window.Mariposa;
  var POLL_MS = 60000;
  var PALETTES = { terracota: 1, nogal: 1, salvia: 1, porcelana: 1 };

  var data = null;            // { settings, categories, products, fromCache, fetchedAt }
  var lastSig = '';
  var view = { cat: 'all', sub: 'all', q: '' };
  var beltWidth = 0;
  var lastFetch = 0;
  var loading = false;
  var uid = 0;
  var CART_KEY = 'mariposa-cart-v1';
  var CART_MAX_LINES = 30, CART_MAX_QTY = 99;
  var cart = {};              // id del producto -> cantidad
  var cartOrder = [];         // orden en que se fue agregando
  var cartNote = '';          // aviso (por ejemplo: "quitamos lo que ya no hay")
  var cartUI = null;          // ventana del pedido, si está abierta
  var ctlBoxes = [];          // controles "Agregar al pedido" que están en pantalla

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function S() { return data ? data.settings : { name: 'Mariposa', place: '', whatsapp: [], address: '', hours: '', mapUrl: '', currency: '$', palette: '' }; }
  function cats() { return data ? data.categories : []; }
  function prods() { return data ? data.products : []; }
  function money(n) { return M.money(n, S().currency); }
  function fold(s) { return M.fold(s); }
  function tintOf(t) { return /^[a-z]{1,20}$/.test(String(t || '')) ? t : 'otros'; }

  function catById(id) {
    var c = cats();
    for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i];
    return { id: id, name: 'Otros', tint: 'otros', phrase: '', subs: [] };
  }
  // El catálogo público solo trae la cantidad total (p.total); no se sabe cuántas hay en tienda o en almacén.
  function total(p) { return p.total != null ? p.total | 0 : (p.store | 0) + (p.warehouse | 0); }

  /* ---------------------------- enlaces seguros ---------------------------- */
  function safeHttps(u) {
    try {
      var x = new URL(String(u), 'https://x.invalid');
      return x.protocol === 'https:' && x.hostname !== 'x.invalid' ? x.href : '';
    } catch (e) { return ''; }
  }
  // Los números cubanos tienen 8 dígitos: se les añade el +53.
  function waNumbers() {
    return (S().whatsapp || []).map(function (n) {
      var d = String(n).replace(/\D/g, '');
      if (d.length === 8) d = '53' + d;
      var shown = (d.indexOf('53') === 0 && d.length === 10) ? '+53 ' + d.slice(2, 6) + ' ' + d.slice(6) : '+' + d;
      return { digits: d, shown: shown };
    }).filter(function (x) { return x.digits.length >= 8 && x.digits.length <= 15; });
  }
  function waLink(w, msg) {
    return 'https://wa.me/' + w.digits + (msg ? '?text=' + encodeURIComponent(msg) : '');
  }
  function extLink(cls, text, href) {
    var a = el('a', cls, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  /* Un número: enlace directo. Dos o más: botón que abre una lista corta. */
  function waChooser(o) {
    var WA = waNumbers();
    if (!WA.length) return null;
    if (WA.length === 1) return extLink(o.btnCls, o.label, waLink(WA[0], o.message));
    var wrap = el('div', o.wrapCls);
    var id = 'wa-panel-' + (++uid);
    var btn = el('button', o.btnCls);
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    btn.appendChild(document.createTextNode(o.label));
    btn.appendChild(el('span', 'chev'));
    var panel = el('div', o.panelCls);
    panel.id = id;
    panel.hidden = true;
    panel.appendChild(el('p', 'choose-cap', o.caption));
    var list = el('div', o.listCls);
    WA.forEach(function (w) { list.appendChild(extLink(o.linkCls, w.shown, waLink(w, o.message))); });
    panel.appendChild(list);
    btn.addEventListener('click', function () {
      var open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    return wrap;
  }


  /* ------------------------------ pedido por WhatsApp ------------------------------
     El cliente arma su pedido en el catálogo y se envía como UN solo mensaje de WhatsApp
     a la tienda. No se guarda nada en la base de datos: la dueña solo confirma con el cliente.
     Solo se guardan en el teléfono del cliente los productos elegidos (localStorage, si se puede). */
  function round2(n) { return Math.round(n * 100) / 100; }
  function trunc(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function cartEnabled() { return waNumbers().length > 0; }
  function productById(id) {
    var l = prods();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function cartCount() { var n = 0; cartOrder.forEach(function (id) { n += cart[id]; }); return n; }
  function cartTotal() {
    var t = 0;
    cartOrder.forEach(function (id) { var p = productById(id); if (p) t += cart[id] * p.price; });
    return round2(t);
  }
  function maxQty(p) { return Math.max(0, Math.min(CART_MAX_QTY, total(p))); }
  function saveCart() {
    M.store.set(CART_KEY, { items: cartOrder.map(function (id) { return [id, cart[id]]; }) });
  }
  function loadCart() {
    cart = {}; cartOrder = [];
    var d = M.store.get(CART_KEY);
    if (!d || !Array.isArray(d.items)) return;
    d.items.slice(0, CART_MAX_LINES).forEach(function (it) {
      var id = Array.isArray(it) ? it[0] : null, q = Array.isArray(it) ? Number(it[1]) : 0;
      if (typeof id !== 'string' || id.length > 64 || cart[id] != null || !(q >= 1) || q > CART_MAX_QTY || q % 1 !== 0) return;
      cart[id] = q; cartOrder.push(id);
    });
  }
  // Ajusta el pedido a lo que hay ahora: quita lo que ya no existe o se agotó y baja lo que pasa de lo disponible.
  function reconcileCart() {
    if (!cartOrder.length || !data) return false;
    var removed = 0, lowered = 0;
    cartOrder = cartOrder.filter(function (id) {
      var p = productById(id);
      if (!p || maxQty(p) < 1) { delete cart[id]; removed++; return false; }
      if (cart[id] > maxQty(p)) { cart[id] = maxQty(p); lowered++; }
      return true;
    });
    if (!removed && !lowered) return false;
    cartNote = (removed ? 'Quitamos de tu pedido ' + (removed === 1 ? 'un producto que ya no está disponible' : removed + ' productos que ya no están disponibles') + '. ' : '') +
               (lowered ? 'Bajamos la cantidad de ' + (lowered === 1 ? 'un producto' : lowered + ' productos') + ' a lo que hay ahora.' : '');
    saveCart();
    return true;
  }
  var toastTimer = 0;
  function toast(msg) {
    var t = $('toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function setQty(id, q) {
    var p = productById(id);
    if (!p) return;
    q = Math.max(0, Math.min(maxQty(p), q | 0));
    if (q > 0 && cart[id] == null) {
      if (cartOrder.length >= CART_MAX_LINES) { toast('Un pedido puede tener hasta ' + CART_MAX_LINES + ' productos distintos. Envía este y haz otro.'); return; }
      cartOrder.push(id);
    }
    if (q === 0) { delete cart[id]; cartOrder = cartOrder.filter(function (x) { return x !== id; }); }
    else cart[id] = q;
    cartNote = '';
    saveCart();
    syncCtls(id);
    renderCart();
  }
  function clearCart() { cart = {}; cartOrder = []; cartNote = ''; saveCart(); syncCtls(null); renderCart(); }

  // Botón de cada tarjeta: "Agregar al pedido" y, una vez agregado, − cantidad +.
  function cartControl(p) {
    if (!cartEnabled() || maxQty(p) < 1) return null;
    var box = el('div', 'cart-ctl');
    box.setAttribute('data-id', p.id);
    var add = el('button', 'btn btn-sm cart-add', 'Agregar al pedido'); add.type = 'button';
    var step = el('div', 'cart-step'); step.setAttribute('role', 'group'); step.setAttribute('aria-label', 'Cantidad de ' + p.name + ' en tu pedido');
    var minus = el('button', 'cs-btn', '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'Quitar una unidad de ' + p.name);
    var qn = el('span', 'cs-qty'); qn.setAttribute('aria-live', 'polite');
    var plus = el('button', 'cs-btn', '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'Agregar una unidad de ' + p.name);
    step.appendChild(minus); step.appendChild(qn); step.appendChild(plus);
    var max = el('span', 'cart-max', 'Es todo lo que hay');
    box.appendChild(add); box.appendChild(step); box.appendChild(max);
    add.addEventListener('click', function () { setQty(p.id, 1); var b = box.querySelector('.cs-btn:last-child'); if (b && !step.hidden) b.focus(); });
    plus.addEventListener('click', function () { setQty(p.id, (cart[p.id] || 0) + 1); });
    minus.addEventListener('click', function () {
      setQty(p.id, (cart[p.id] || 0) - 1);
      if (!cart[p.id]) add.focus();
    });
    box._refs = { add: add, step: step, qn: qn, plus: plus, max: max, p: p };
    ctlBoxes.push(box);
    drawCtl(box);
    return box;
  }
  function drawCtl(box) {
    var r = box._refs, q = cart[r.p.id] || 0, mx = maxQty(r.p);
    r.add.hidden = q > 0; r.step.hidden = q === 0;
    r.qn.textContent = String(q);
    r.plus.disabled = q >= mx;
    r.max.hidden = !(q > 0 && q >= mx);
  }
  function syncCtls(id) {
    ctlBoxes.forEach(function (b) { if (!id || b.getAttribute('data-id') === id) drawCtl(b); });
  }

  /* Barra de abajo: aparece cuando hay algo en el pedido */
  function renderCart() {
    var bar = $('cartbar');
    var n = cartCount(), show = n > 0 && cartEnabled();
    bar.hidden = !show;
    document.body.classList.toggle('has-cart', show);
    if (show) {
      var b = $('cartBtn');
      b.textContent = '';
      b.appendChild(el('span', 'cb-n', String(n)));
      b.appendChild(el('span', 'cb-t', 'Ver mi pedido'));
      b.appendChild(el('span', 'cb-sum', money(cartTotal())));
      b.setAttribute('aria-label', 'Ver mi pedido: ' + (n === 1 ? '1 unidad' : n + ' unidades') + ', ' + money(cartTotal()));
    }
    if (cartUI) {
      if (!show) closeCart(); else drawSheet();
    }
  }

  function orderMessage(name, note) {
    var L = ['Hola, quisiera hacer este pedido en ' + S().name + ':', ''];
    cartOrder.forEach(function (id) {
      var p = productById(id); if (!p) return;
      L.push('• ' + cart[id] + ' × ' + trunc(p.name, 70) + (p.code ? ' (' + trunc(p.code, 20) + ')' : '') + ' — ' + money(round2(cart[id] * p.price)));
    });
    L.push('', 'Total: ' + money(cartTotal()));
    if (name) L.push('Nombre: ' + name);
    if (note) L.push('Nota: ' + note);
    L.push('', 'Espero su confirmación. ¡Gracias!');
    return L.join('\n');
  }

  function openCart() {
    if (cartUI || !cartOrder.length) return;
    var opener = document.activeElement;
    var root = el('div', 'sheet');
    var scrim = el('div', 'sheet-scrim');
    var card = el('div', 'sheet-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'cartTitle');
    var head = el('div', 'sheet-head');
    var h = el('h2', 'sheet-title', 'Tu pedido'); h.id = 'cartTitle';
    var x = el('button', 'sheet-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Cerrar');
    head.appendChild(h); head.appendChild(x); card.appendChild(head);
    card.appendChild(el('p', 'sheet-hint', 'Esto no reserva los productos: te escribimos por WhatsApp para confirmar que hay y cómo recogerlos. Los precios y las cantidades pueden cambiar.'));
    var note = el('p', 'sheet-warn'); note.hidden = true; note.setAttribute('role', 'status'); card.appendChild(note);
    var lines = el('ul', 'cart-lines'); card.appendChild(lines);
    var tot = el('div', 'cart-total'); card.appendChild(tot);

    var nameIn = el('input'); nameIn.type = 'text'; nameIn.maxLength = 60; nameIn.autocomplete = 'name'; nameIn.id = 'cartName';
    var fN = el('label', 'cart-field'); fN.htmlFor = 'cartName'; fN.appendChild(el('span', 'cf-l', 'Tu nombre (opcional)')); fN.appendChild(nameIn);
    var noteIn = el('input'); noteIn.type = 'text'; noteIn.maxLength = 200; noteIn.id = 'cartNote'; noteIn.autocomplete = 'off';
    noteIn.placeholder = 'Por ejemplo: lo recojo mañana por la tarde';
    var fT = el('label', 'cart-field'); fT.htmlFor = 'cartNote'; fT.appendChild(el('span', 'cf-l', 'Nota para la tienda (opcional)')); fT.appendChild(noteIn);
    card.appendChild(fN); card.appendChild(fT);

    var send = el('div', 'cart-send'); card.appendChild(send);
    var clear = el('button', 'btn btn-sm btn-danger cart-clear', 'Vaciar el pedido'); clear.type = 'button';
    clear.addEventListener('click', function () {
      if (!clear.classList.contains('armed')) {
        clear.classList.add('armed'); clear.textContent = 'Toca otra vez para vaciar';
        setTimeout(function () { clear.classList.remove('armed'); clear.textContent = 'Vaciar el pedido'; }, 3000);
        return;
      }
      clearCart();
    });
    card.appendChild(clear);

    root.appendChild(scrim); root.appendChild(card);
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';
    setBehindInert(true);

    function onKey(e) {
      if (e.key === 'Escape') { closeCart(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(card.querySelectorAll('button, input, a[href]'), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    scrim.addEventListener('click', closeCart);
    x.addEventListener('click', closeCart);
    nameIn.addEventListener('input', updateLinks);
    noteIn.addEventListener('input', updateLinks);
    cartUI = { root: root, lines: lines, tot: tot, send: send, note: note, nameIn: nameIn, noteIn: noteIn, onKey: onKey, opener: opener, links: [] };
    drawSheet();
    x.focus();
  }
  // Mientras el pedido está abierto, lo de atrás no se puede tocar ni leer con el lector de pantalla.
  function setBehindInert(on) {
    var sel = ['.banner', '.head', '.cats', 'main', '.cartbar', '.note'];
    sel.forEach(function (q) {
      var n = document.querySelectorAll(q);
      for (var i = 0; i < n.length; i++) { if (on) n[i].setAttribute('inert', ''); else n[i].removeAttribute('inert'); }
    });
  }
  function closeCart() {
    if (!cartUI) return;
    var u = cartUI; cartUI = null;
    document.removeEventListener('keydown', u.onKey);
    u.root.remove();
    document.body.style.overflow = '';
    setBehindInert(false);
    var back = $('cartBtn');
    try { (u.opener && document.body.contains(u.opener) ? u.opener : back).focus(); } catch (e) { /* nada */ }
  }
  function updateLinks() {
    if (!cartUI) return;
    var msg = orderMessage(cartUI.nameIn.value.trim().replace(/\s+/g, ' '), cartUI.noteIn.value.trim().replace(/\s+/g, ' '));
    var WA = waNumbers();
    cartUI.links.forEach(function (a, i) { if (WA[i]) a.href = waLink(WA[i], msg); });
  }
  function drawSheet() {
    var u = cartUI;
    u.note.textContent = cartNote; u.note.hidden = !cartNote;
    var keep = document.activeElement && u.lines.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    u.lines.textContent = '';
    cartOrder.forEach(function (id) {
      var p = productById(id); if (!p) return;
      var li = el('li', 'cl');
      var info = el('div', 'cl-info');
      info.appendChild(el('div', 'cl-name', p.name));
      info.appendChild(el('div', 'cl-sub', cart[id] + ' × ' + money(p.price) + ' = ' + money(round2(cart[id] * p.price))));
      var step = el('div', 'cart-step');
      var mn = el('button', 'cs-btn', '−'); mn.type = 'button'; mn.setAttribute('aria-label', 'Quitar una unidad de ' + p.name);
      var qn = el('span', 'cs-qty', String(cart[id]));
      var pl = el('button', 'cs-btn', '+'); pl.type = 'button'; pl.setAttribute('aria-label', 'Agregar una unidad de ' + p.name);
      pl.disabled = cart[id] >= maxQty(p);
      var rm = el('button', 'cs-btn cs-rm', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', 'Quitar ' + p.name + ' del pedido');
      mn.addEventListener('click', function () { setQty(id, cart[id] - 1); });
      pl.addEventListener('click', function () { setQty(id, cart[id] + 1); });
      rm.addEventListener('click', function () { setQty(id, 0); });
      step.appendChild(mn); step.appendChild(qn); step.appendChild(pl); step.appendChild(rm);
      li.appendChild(info); li.appendChild(step); u.lines.appendChild(li);
    });
    u.tot.textContent = '';
    u.tot.appendChild(el('span', null, 'Total'));
    u.tot.appendChild(el('strong', null, money(cartTotal())));
    // enlaces de WhatsApp: uno por número de la tienda
    u.send.textContent = ''; u.links = [];
    var WA = waNumbers();
    if (WA.length > 1) u.send.appendChild(el('p', 'choose-cap', 'Envía el pedido por WhatsApp al:'));
    WA.forEach(function (w) {
      var a = el('a', 'btn btn-primary cart-wa', WA.length === 1 ? 'Enviar el pedido por WhatsApp' : 'Enviar a ' + w.shown);
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      u.send.appendChild(a); u.links.push(a);
    });
    updateLinks();
    if (keep) {   // se vuelve a poner el cursor donde estaba (la lista se dibuja otra vez)
      var again = Array.prototype.filter.call(u.lines.querySelectorAll('button'), function (b) { return b.getAttribute('aria-label') === keep && !b.disabled; })[0];
      if (again) again.focus(); else u.root.querySelector('.sheet-x').focus();
    }
  }

  $('cartBtn').addEventListener('click', openCart);
  loadCart();

  /* ------------------------------ encabezado ------------------------------ */
  function setPop(btnId, popId, open) {
    var b = $(btnId), p = $(popId);
    if (!b || !p) return;
    p.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
  }
  function closePops() { setPop('whereBtn', 'wherePop', false); setPop('waBtn', 'waPop', false); }
  function togglePop(btnId, popId, otherBtn, otherPop) {
    var open = $(popId).hidden;
    setPop(otherBtn, otherPop, false);
    setPop(btnId, popId, open);
  }

  function renderTopbar() {
    var WA = waNumbers();
    var haveWa = WA.length > 0;
    var haveWhere = !!(S().address || S().hours);
    $('waBtn').hidden = !haveWa;
    $('whereBtn').hidden = !haveWhere;
    $('sep').hidden = !(haveWa && haveWhere);
    $('topbar').hidden = !(haveWa || haveWhere);
    $('placeLabel').textContent = S().place || 'Ubicación';

    var wp = $('waPop');
    wp.textContent = '';
    if (haveWa) {
      wp.appendChild(el('p', 'pop-title', 'Contactar por WhatsApp'));
      if (WA.length > 1) wp.appendChild(el('p', 'choose-cap', 'Elige a cuál escribir'));
      var list = el('div', 'choices');
      WA.forEach(function (w) {
        list.appendChild(extLink('choice', w.shown, waLink(w, 'Hola, vi el catálogo de ' + S().name + ' y quisiera consultar.')));
      });
      wp.appendChild(list);
    }
    var hp = $('wherePop');
    hp.textContent = '';
    if (haveWhere) {
      hp.appendChild(el('p', 'pop-title', 'Ubicación'));
      if (S().address) hp.appendChild(el('p', 'where-text', S().address));
      if (S().hours) hp.appendChild(el('p', 'where-text', 'Horario: ' + S().hours));
      if (S().address) {
        var map = safeHttps(S().mapUrl) || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(S().address));
        hp.appendChild(extLink('choice', 'Ver en el mapa', map));
      }
    }
    if (!haveWa) setPop('waBtn', 'waPop', false);
    if (!haveWhere) setPop('whereBtn', 'wherePop', false);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function renderHeader() {
    document.documentElement.setAttribute('data-palette', PALETTES[S().palette] ? S().palette : '');
    $('brand').textContent = S().name;
    document.title = S().name + (S().place ? ' · ' + S().place : '') + ' · Catálogo';
    var note = 'Precios y existencias pueden cambiar sin previo aviso.';
    if (data && data.fetchedAt) note += ' Actualizado a las ' + hhmm(data.fetchedAt) + '.';
    $('note').textContent = note;
    var offline = !!(data && data.fromCache);
    $('banner').hidden = !offline;
    if (offline) {
      $('bannerText').textContent = 'Sin conexión: te mostramos la lista guardada a las ' + hhmm(data.fetchedAt) + '. Las cantidades pueden haber cambiado.';
    }
    renderTopbar();
  }

  /* ------------------------------ categorías ------------------------------ */
  function syncChips() {
    var btns = $('chips').querySelectorAll('.cat-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-id') === view.cat));
    }
  }
  function syncSubs() {
    var btns = $('subChips').querySelectorAll('.sub-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-id') === view.sub));
    }
  }
  function renderPhrase() {
    var phrase = view.cat === 'all' ? '' : (catById(view.cat).phrase || '');
    $('sub').textContent = phrase;
    $('sub').hidden = !phrase;
  }
  function renderSubs() {
    var chips = $('subChips');
    chips.textContent = '';
    var c = view.cat === 'all' ? null : cats().filter(function (x) { return x.id === view.cat; })[0];
    var subs = c ? c.subs : [];
    if (view.sub !== 'all' && !subs.some(function (s) { return s.id === view.sub; })) view.sub = 'all';
    $('subs').hidden = !subs.length;
    if (!subs.length) return;
    [{ id: 'all', name: 'Todo' }].concat(subs).forEach(function (s) {
      var n = prods().filter(function (p) { return p.cat === c.id && (s.id === 'all' || p.sub === s.id); }).length;
      var b = el('button', 'sub-btn');
      b.type = 'button';
      b.setAttribute('data-id', s.id);
      b.appendChild(document.createTextNode(s.name));
      b.appendChild(el('span', 'n', String(n)));
      b.addEventListener('click', function () { view.sub = s.id; syncSubs(); renderGrid(); });
      chips.appendChild(b);
    });
    syncSubs();
  }
  function selectCat(id) {
    view.cat = id;
    view.sub = 'all';
    syncChips();
    renderSubs();
    renderPhrase();
    renderGrid();
  }

  /* La fila de categorías es una banda que se desliza con el dedo, el ratón o la rueda.
     Se repite hasta llenar la pantalla; si nadie la toca, avanza despacio sola. */
  function renderChips() {
    var belt = $('belt'), track = $('chips');
    track.textContent = '';
    if (view.cat !== 'all' && !cats().some(function (c) { return c.id === view.cat; })) view.cat = 'all';
    var items = [{ id: 'all', name: 'Todo' }].concat(cats());
    function makeGroup(real) {
      var g = el('div', real ? 'grp' : 'grp dup');
      if (!real) g.setAttribute('aria-hidden', 'true');
      items.forEach(function (c) {
        var n = c.id === 'all' ? prods().length : prods().filter(function (p) { return p.cat === c.id; }).length;
        var b = el('button', 'cat-btn');
        b.type = 'button';
        b.setAttribute('data-id', c.id);
        if (!real) b.tabIndex = -1;
        b.appendChild(document.createTextNode(c.name));
        b.appendChild(el('span', 'n', String(n)));
        b.addEventListener('click', function () { selectCat(c.id); });
        g.appendChild(b);
      });
      return g;
    }
    track.appendChild(makeGroup(true));
    var gw = track.firstChild.getBoundingClientRect().width;
    beltWidth = belt.clientWidth;
    drift.gw = 0;
    if (gw > 0 && !beltMotion.matches) {
      var copies = Math.ceil(beltWidth / gw) + 2;
      for (var i = 1; i < copies; i++) track.appendChild(makeGroup(false));
      drift.gw = gw;
    }
    setBeltPos(drift.gw);
    syncChips();
  }

  /* -------------------------------- tarjetas -------------------------------- */
  function stockPill(n) {
    var low = n <= 3;
    var s = el('span', 'st ' + (low ? 'low' : 'has'));
    s.appendChild(document.createTextNode((low ? 'Quedan ' : 'Disponibles ')));
    s.appendChild(el('b', null, String(n)));
    return s;
  }

  function card(p) {
    var c = catById(p.cat);
    var out = total(p) <= 0;
    var li = el('li');
    var art = el('article', 'card' + (out ? ' out' : ''));

    var tile = el('div', 'tile');
    tile.style.setProperty('--tint', 'var(--t-' + tintOf(c.tint) + ')');
    var code = el('span', 'code', p.code);
    var photo = p.photo && /^(https:\/\/|data:image\/)/i.test(p.photo) ? p.photo : '';
    if (photo) {
      var img = el('img');
      img.alt = p.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(code, img); });
      img.src = photo;
      tile.appendChild(img);
    } else {
      tile.appendChild(code);
    }
    if (out) tile.appendChild(el('span', 'badge', 'Agotado'));
    art.appendChild(tile);

    var meta = el('div', 'meta');
    meta.appendChild(el('h2', 'name', p.name));
    meta.appendChild(el('span', 'price', money(p.price)));
    art.appendChild(meta);

    if (p.desc) art.appendChild(el('p', 'desc', p.desc));

    if (!out) {
      var st = el('p', 'stock');
      st.appendChild(stockPill(total(p)));
      art.appendChild(st);
      var ctl = cartControl(p);
      if (ctl) art.appendChild(ctl);
      var ask = waChooser({
        label: 'Consultar',
        caption: 'Por WhatsApp, escribir al:',
        message: 'Hola, me interesa: ' + p.name + (p.code ? ' (' + p.code + ')' : ''),
        wrapCls: 'ask-wrap', btnCls: 'ask', panelCls: 'ask-panel', listCls: 'ask-list', linkCls: 'ask-link'
      });
      if (ask) art.appendChild(ask);
    }
    li.appendChild(art);
    return li;
  }

  function renderGrid() {
    var q = fold(view.q.trim());
    var list = prods().filter(function (p) {
      if (view.cat !== 'all' && p.cat !== view.cat) return false;
      if (view.cat !== 'all' && view.sub !== 'all' && p.sub !== view.sub) return false;
      if (!q) return true;
      return fold(p.name + ' ' + p.desc + ' ' + p.code).indexOf(q) !== -1;
    });
    // Primero lo que hay; lo agotado al final (se conserva el orden por nombre).
    var avail = list.filter(function (p) { return total(p) > 0; });
    var gone = list.filter(function (p) { return total(p) <= 0; });
    var grid = $('grid');
    grid.textContent = '';
    ctlBoxes = [];
    avail.concat(gone).forEach(function (p) { grid.appendChild(card(p)); });
    var none = $('empty');
    if (!list.length) {
      none.hidden = false;
      if (!prods().length) none.textContent = 'Pronto agregaremos productos aquí.';
      else if (q) none.textContent = 'No encontramos productos con esa búsqueda. Prueba con otra palabra o quita el filtro de categoría.';
      else none.textContent = 'Todavía no hay productos en esta sección.';
    } else {
      none.hidden = true;
    }
    $('count').textContent = prods().length ? list.length + (list.length === 1 ? ' producto' : ' productos') : '';
  }

  function renderAll() {
    renderHeader();
    renderChips();
    renderSubs();
    renderPhrase();
    renderGrid();
  }

  /* ----------------------- carga de datos y refresco ----------------------- */
  function showState(msg, retry) {
    var s = $('state');
    s.textContent = '';
    s.appendChild(el('p', null, msg));
    if (retry) {
      var b = el('button', 'btn btn-sm', 'Reintentar');
      b.type = 'button';
      b.addEventListener('click', function () { load(true); });
      s.appendChild(b);
    }
    s.hidden = false;
    $('skeleton').hidden = true;
  }

  function signature(d) {
    return JSON.stringify([d.settings, d.categories, d.products, !!d.fromCache]);
  }

  var api = null;
  function load(first) {
    if (loading || !api) return;
    loading = true;
    api.loadCatalog().then(function (d) {
      loading = false;
      lastFetch = Date.now();
      $('skeleton').hidden = true;
      $('state').hidden = true;
      var sig = signature(d);
      var changed = sig !== lastSig;
      data = d;
      lastSig = sig;
      var cartChanged = reconcileCart();
      if (first || changed) renderAll();
      else renderHeader();           // solo la hora y el aviso
      if (cartChanged || first || changed) renderCart();
    }, function (e) {
      loading = false;
      if (!data) showState(M.errorText(M.toError(e)), true);
    });
  }

  function tick() { if (!document.hidden) load(false); }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastFetch > 20000) load(false);
  });
  window.addEventListener('online', function () { load(false); });

  /* ------------------------ interacción del encabezado ------------------------ */
  $('whereBtn').addEventListener('click', function () { togglePop('whereBtn', 'wherePop', 'waBtn', 'waPop'); });
  $('waBtn').addEventListener('click', function () { togglePop('waBtn', 'waPop', 'whereBtn', 'wherePop'); });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && !t.closest('.topbar')) closePops();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePops(); });

  $('q').addEventListener('input', function (e) { view.q = e.target.value; renderGrid(); });

  /* ------------------------------ banda deslizante ------------------------------ */
  var beltEl = $('belt');
  var beltMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var drift = {
    gw: 0, pos: 0, expect: 0, moving: false, last: 0, touched: -10000,
    down: false, hover: false, focus: false, drag: null, dragged: false
  };
  function setBeltPos(x) {
    drift.pos = x;
    drift.expect = x;
    drift.moving = false;
    beltEl.scrollLeft = x;
  }
  function touchBelt() { drift.touched = performance.now(); }
  function driftTick(t) {
    var dt = drift.last ? Math.min(t - drift.last, 64) : 16;
    drift.last = t;
    var calm = !drift.down && !drift.hover && !drift.focus && drift.gw > 0 && !beltMotion.matches && (t - drift.touched) > 2500 && !document.hidden;
    if (calm) {
      if (!drift.moving) {
        var g = drift.gw;
        drift.pos = g + ((((beltEl.scrollLeft - g) % g) + g) % g);
        drift.moving = true;
      }
      drift.pos += dt * 0.036;
      if (drift.pos >= drift.gw * 2) drift.pos -= drift.gw;
      drift.expect = drift.pos;
      beltEl.scrollLeft = drift.pos;
    } else {
      drift.moving = false;
    }
    requestAnimationFrame(driftTick);
  }
  beltEl.addEventListener('scroll', function () {
    if (Math.abs(beltEl.scrollLeft - drift.expect) <= 1.5) return;
    drift.moving = false;
    touchBelt();
  }, { passive: true });
  beltEl.addEventListener('wheel', function (e) { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) touchBelt(); }, { passive: true });
  beltEl.addEventListener('pointerdown', function (e) {
    drift.down = true;
    touchBelt();
    if (e.pointerType === 'mouse' && e.button === 0) { drift.drag = { x: e.clientX, left: beltEl.scrollLeft }; drift.dragged = false; }
  });
  window.addEventListener('pointermove', function (e) {
    var d = drift.drag;
    if (!d) return;
    if (e.buttons === 0) { endPointer(); return; }
    var dx = e.clientX - d.x;
    if (!drift.dragged && Math.abs(dx) > 4) { drift.dragged = true; beltEl.classList.add('dragging'); }
    if (drift.dragged) { beltEl.scrollLeft = d.left - dx; touchBelt(); }
  });
  function endPointer() {
    if (!drift.down && !drift.drag) return;
    drift.down = false;
    drift.drag = null;
    touchBelt();
    if (drift.dragged) {
      beltEl.classList.remove('dragging');
      setTimeout(function () { drift.dragged = false; }, 0);
    }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  beltEl.addEventListener('click', function (e) { if (drift.dragged) { e.stopPropagation(); e.preventDefault(); } }, true);
  beltEl.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') drift.hover = true; });
  beltEl.addEventListener('pointerleave', function () { drift.hover = false; touchBelt(); });
  beltEl.addEventListener('focusin', function (e) {
    var fv = true;
    try { fv = e.target.matches(':focus-visible'); } catch (x) { /* navegador viejo */ }
    if (fv) { drift.focus = true; touchBelt(); }
  });
  beltEl.addEventListener('focusout', function () { drift.focus = false; touchBelt(); });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (data && beltEl.clientWidth !== beltWidth) renderChips(); }, 200);
  });

  /* ---------------------------------- inicio ---------------------------------- */
  // La tienda se puede instalar como app desde el navegador (Añadir a la pantalla de inicio).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  M.open().then(function (a) {
    api = a;
    load(true);
    setInterval(tick, POLL_MS);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (data) renderChips(); });
    if (window.requestAnimationFrame) requestAnimationFrame(driftTick);
  }, function (e) {
    showState(M.errorText(M.toError(e)), false);
  });
})();
