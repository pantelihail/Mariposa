/* =====================================================================
   MARIPOSA · ALMACÉN (solo la dueña)

   - Ve todos los productos con "En tienda" y "En almacén".
   - Crea productos, mete mercancía, la pasa del almacén a la tienda y
     rebaja cantidades a mano (siempre con el motivo).
   - Revisa las ventas del trabajador, anula las que estén mal y descarga copias.
   - Configura categorías, datos de la tienda, accesos y verificación en dos pasos.

   Todo texto que viene de la base de datos se muestra con textContent.
   Nunca se arma HTML con datos de la tienda.
   ===================================================================== */
(function () {
  'use strict';
  var M = window.Mariposa, UI = window.UI;
  var el = UI.el;
  var root = UI.$('root');

  var POLL_MS = 60000;   // refresco automático
  var LOW = 3;           // "pocas unidades": 1 a 3 en total (tienda + almacén)

  var api = null, gate = null, session = null;
  var settings = { name: '', currency: '$', baseCurrency: '', mnPerUsd: 0 };
  var categories = [], products = [], byId = {}, catById = {};
  var fromCache = false, fetchedAt = 0, loaded = false, loadingCatalog = false, catalogError = '', catalogSig = '';
  var priv = {}, privLoaded = false, privError = '';   // costo y "avisar cuando queden" de cada producto (solo la dueña)
  var view = { tab: 'inv', q: '', cat: 'all', flt: 'all' };
  var movState = { list: null, loading: false, error: '', kind: 'all', q: '' };
  var salesState = { range: 'today', list: null, counts: [], loading: false, error: '', rangeKey: '', token: 0 };
  var setState = { team: null, teamError: '', mfa: null, mfaError: '', draftCats: null, mfaEnroll: null };
  var pollTimer = null, offOnline = null, onVis = null;
  var ui = {};

  var KIND_TEXT = { initial: 'Inicial', entry: 'Entrada', transfer: 'Traspaso', adjust: 'Ajuste', sale: 'Venta', 'void': 'Anulación', 'return': 'Devolución' };
  var KIND_BADGE = { initial: 'badge', entry: 'badge badge-ok', transfer: 'badge badge-accent', adjust: 'badge badge-warn', sale: 'badge', 'void': 'badge badge-bad', 'return': 'badge badge-accent' };
  var ROLE_TEXT = { owner: 'Dueña', worker: 'Trabajador (Ventas)', assistant: 'Asistente (Claude)' };

  /* ------------------------------------------------------------------
     Ayudas
     ------------------------------------------------------------------ */
  function fmt(n) { return M.money(n, settings.currency); }
  function amt(n, cur) { return M.money(n) + ' ' + cur; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); }
  function parseDecimal(s) {            // '12,5' -> 12.5 ; null si no vale
    s = String(s == null ? '' : s).replace(/\s/g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return null;
    return Number(s.replace(',', '.'));
  }
  function parseWhole(s, max) {         // entero >= 0 ; null si no vale
    s = String(s == null ? '' : s).replace(/\s/g, '');
    if (!/^\d{1,7}$/.test(s)) return null;
    var v = Number(s);
    return v <= (max || 1000000) ? v : null;
  }
  function fail(e) { UI.toast(M.errorText(M.toError(e)), 'bad'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function catName(id) { var c = catById[id]; return c ? c.name : 'Sin categoría'; }
  function totalOf(p) { return p.store + p.warehouse; }
  // "Pocas unidades": por defecto 3 o menos; cada producto puede tener su propio aviso (Editar → Avisarme cuando queden).
  function reorderOf(p) { var d = priv[p.id]; return d && d.reorderAt != null ? d.reorderAt : LOW; }
  function costOf(p) { var d = priv[p.id]; return d && d.cost != null ? d.cost : null; }
  function statusOf(p) { var t = totalOf(p); return t === 0 ? 'out' : (t <= reorderOf(p) ? 'low' : 'ok'); }
  function safeImg(u) { return typeof u === 'string' && /^(https:\/\/|data:image\/|blob:)/.test(u); }
  function baseText() {
    return settings.baseCurrency === 'usd' ? 'dólares (USD)' : settings.baseCurrency === 'mn' ? 'pesos (MN)' : '';
  }

  function indexData() {
    byId = {}; products.forEach(function (p) { byId[p.id] = p; });
    catById = {}; categories.forEach(function (c) { catById[c.id] = c; });
  }

  function formError() {
    var e = el('p', 'err'); e.hidden = true; e.setAttribute('role', 'alert');
    e.show = function (t) { e.textContent = t || ''; e.hidden = !t; };
    return e;
  }
  function emptyNote(text) { return el('p', 'empty', text); }
  function spinnerBox(text) {
    var d = el('div', 'center-note'); d.appendChild(el('div', 'spinner')); d.appendChild(el('p', null, text || 'Cargando…'));
    return d;
  }
  function chipRow(items, current, onPick) {
    var row = el('div', 'chips'); row.setAttribute('role', 'group');
    items.forEach(function (it) {
      var b = el('button', 'chip', it[1]); b.type = 'button'; b.setAttribute('aria-pressed', it[0] === current ? 'true' : 'false');
      b.addEventListener('click', function () { onPick(it[0]); });
      row.appendChild(b);
    });
    return row;
  }
  function refreshIcon() {
    var b = el('button', 'icon-btn'); b.type = 'button';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return b;
  }

  /* ------------------------------------------------------------------
     Estructura de la pantalla
     ------------------------------------------------------------------ */
  var TABS = [['inv', 'Inventario'], ['mov', 'Movimientos'], ['ventas', 'Ventas'], ['set', 'Ajustes']];

  function buildShell() {
    UI.clear(root);
    root.appendChild(UI.header({ app: 'Almacén', session: session, onSignOut: function () { if (gate) gate.signOut(); } }));
    ui.banner = el('div', 'banner'); ui.banner.hidden = true; root.appendChild(ui.banner);

    var bar = el('div', 'atabs'), bw = el('div', 'wrap'), tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    ui.tabBtns = {};
    TABS.forEach(function (t) {
      var b = el('button', 'tab', t[1]); b.type = 'button'; b.id = 'tab-' + t[0];
      b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'panel-' + t[0]);
      b.addEventListener('click', function () { showTab(t[0]); });
      b.addEventListener('keydown', function (e) {
        var i = TABS.map(function (x) { return x[0]; }).indexOf(t[0]), n = null;
        if (e.key === 'ArrowRight') n = TABS[(i + 1) % TABS.length][0];
        else if (e.key === 'ArrowLeft') n = TABS[(i + TABS.length - 1) % TABS.length][0];
        if (n) { e.preventDefault(); showTab(n); ui.tabBtns[n].focus(); }
      });
      ui.tabBtns[t[0]] = b; tabs.appendChild(b);
    });
    bw.appendChild(tabs); bar.appendChild(bw); root.appendChild(bar);

    var main = el('main', 'wrap amain');
    ui.panels = {};
    TABS.forEach(function (t) {
      var p = el('section', 'apanel'); p.id = 'panel-' + t[0]; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'tab-' + t[0]); p.hidden = true;
      ui.panels[t[0]] = p; main.appendChild(p);
    });
    root.appendChild(main);
    buildInventoryPanel(); buildMovPanel(); buildSalesPanel(); buildSettingsPanel();
  }

  function showTab(key) {
    view.tab = key;
    TABS.forEach(function (t) {
      var on = t[0] === key;
      ui.tabBtns[t[0]].setAttribute('aria-selected', on ? 'true' : 'false');
      ui.tabBtns[t[0]].tabIndex = on ? 0 : -1;
      ui.panels[t[0]].hidden = !on;
    });
    if (key === 'mov') loadMovements();
    else if (key === 'ventas') loadSales();
    else if (key === 'set') openSettings();
  }

  function renderBanner() {
    UI.clear(ui.banner);
    ui.banner.hidden = !(fromCache && loaded);
    if (ui.banner.hidden) return;
    var w = el('div', 'wrap');
    w.appendChild(el('span', null, 'Sin conexión. Se muestran los datos guardados a las ' + M.fmtTime(fetchedAt) + '. No se puede cambiar nada hasta que vuelva internet.'));
    var b = el('button', 'link-btn', 'Reintentar'); b.type = 'button';
    b.addEventListener('click', function () { refreshCatalog(true); });
    w.appendChild(b); ui.banner.appendChild(w);
  }

  /* ------------------------------------------------------------------
     Datos: se cargan solos cada minuto y al volver a la pantalla
     ------------------------------------------------------------------ */
  function refreshCatalog(manual) {
    if (loadingCatalog) return Promise.resolve();
    loadingCatalog = true;
    // El costo vive en una tabla aparte que solo la dueña puede leer; si no se puede leer, el resto sigue funcionando.
    var pvP = api.loadPrivate().then(function (d) { return { ok: true, d: d }; }, function (e) { return { ok: false, e: M.toError(e) }; });
    return Promise.all([api.loadCatalog(), pvP]).then(function (res) {
      var r = res[0], pv = res[1];
      if (pv.ok) { priv = pv.d; privLoaded = true; privError = ''; }
      else if (pv.e.code !== 'network') { privError = M.errorText(pv.e); }
      var sig = JSON.stringify([r.settings, r.categories, r.products, priv]);
      var changed = sig !== catalogSig || !loaded;
      catalogSig = sig;
      settings = r.settings; categories = r.categories; products = r.products;
      fromCache = !!r.fromCache; fetchedAt = r.fetchedAt || Date.now();
      loaded = true; catalogError = '';
      indexData();
      renderBanner();
      if (changed || manual) renderInv();
      if (manual) UI.toast(fromCache ? 'Sin conexión: se muestran datos guardados.' : 'Datos al día.', fromCache ? 'bad' : 'ok');
    }, function (e) {
      catalogError = M.errorText(M.toError(e));
      if (manual) UI.toast(catalogError, 'bad');
      if (!loaded) renderList();
    }).then(function () { loadingCatalog = false; }, function () { loadingCatalog = false; });
  }

  function tick() {
    if (document.hidden || !session) return;
    if (UI.modal.isOpen()) return;       // no se mueve nada mientras ella escribe
    refreshCatalog(false);
    if (view.tab === 'mov') loadMovements(true);
    else if (view.tab === 'ventas') loadSales(true);
  }

  /* ------------------------------------------------------------------
     INVENTARIO
     ------------------------------------------------------------------ */
  function buildInventoryPanel() {
    var p = ui.panels.inv;
    ui.stats = el('div', 'stats');
    p.appendChild(ui.stats);

    var bar = el('div', 'tools');
    ui.search = el('input', 'search'); ui.search.type = 'search'; ui.search.placeholder = 'Buscar…';
    ui.search.setAttribute('aria-label', 'Buscar producto por nombre o código'); ui.search.autocomplete = 'off'; ui.search.maxLength = 60;
    ui.search.addEventListener('input', function () { view.q = ui.search.value; renderList(); });
    var ref = refreshIcon(); ref.setAttribute('aria-label', 'Actualizar'); ref.title = 'Actualizar';
    ref.addEventListener('click', function () { UI.busy(ref, refreshCatalog(true)); });
    var add = el('button', 'btn btn-primary add-btn', '+ Nuevo producto'); add.type = 'button';
    add.addEventListener('click', function () { productForm(null); });
    bar.appendChild(ui.search); bar.appendChild(ref); bar.appendChild(add);
    p.appendChild(bar);

    ui.catChips = el('div', 'chiprow');
    ui.fltChips = el('div', 'chiprow');
    p.appendChild(ui.catChips); p.appendChild(ui.fltChips);
    ui.count = el('p', 'hint count-line');
    p.appendChild(ui.count);
    ui.list = el('div', 'alist-wrap');
    p.appendChild(ui.list);
  }

  function renderInv() { renderStats(); renderChips(); renderList(); renderTabCount(); }

  function renderTabCount() {
    var n = products.filter(function (p) { return statusOf(p) !== 'ok'; }).length;
    var b = ui.tabBtns.inv;
    b.textContent = 'Inventario';
    if (n > 0) { var c = el('span', 'count', String(n)); c.title = 'Agotados o con pocas unidades'; b.appendChild(c); }
  }

  function stat(label, value, sub, cls, onClick) {
    var s = el(onClick ? 'button' : 'div', 'stat' + (cls ? ' ' + cls : '') + (onClick ? ' stat-btn' : ''));
    if (onClick) { s.type = 'button'; s.addEventListener('click', onClick); }
    s.appendChild(el('div', 'stat-label', label));
    s.appendChild(el('div', 'stat-value', value));
    if (sub) s.appendChild(el('div', 'stat-sub', sub));
    return s;
  }

  function renderStats() {
    UI.clear(ui.stats);
    var inStore = 0, inWh = 0, out = 0, low = 0, hidden = 0, value = 0, noStore = 0, invest = 0, noCost = 0;
    products.forEach(function (p) {
      inStore += p.store; inWh += p.warehouse; value += p.price * (p.store + p.warehouse);
      var cp = costOf(p); if (cp == null) { if (totalOf(p) > 0) noCost++; } else invest += cp * totalOf(p);
      var st = statusOf(p); if (st === 'out') out++; else if (st === 'low') low++;
      if (!p.visible) hidden++;
      if (p.store === 0 && p.warehouse > 0) noStore++;
    });
    ui.stats.appendChild(stat('Productos', String(products.length), hidden ? plural(hidden, 'oculto', 'ocultos') : 'todos visibles'));
    ui.stats.appendChild(stat('En tienda', String(inStore), 'unidades'));
    ui.stats.appendChild(stat('En almacén', String(inWh), 'unidades'));
    ui.stats.appendChild(stat('Atención', String(out + low), plural(out, 'agotado', 'agotados') + ' · ' + plural(low, 'con pocas', 'con pocas') + (noStore ? ' · ' + noStore + ' sin tienda' : ''), out + low > 0 ? 'stat-warn' : '', restockDialog));
    if (products.length) ui.stats.appendChild(stat('Valor de la mercancía', fmt(round2(value)), 'a precio de venta'));
    if (products.length && priv && Object.keys(priv).some(function (k) { return priv[k].cost != null; })) {
      ui.stats.appendChild(stat('Lo que costó la mercancía', fmt(round2(invest)), noCost ? plural(noCost, 'producto sin costo', 'productos sin costo') + ' no se cuentan' : 'solo lo ves tú'));
    }
  }

  function renderChips() {
    UI.clear(ui.catChips); UI.clear(ui.fltChips);
    if (view.cat !== 'all' && !catById[view.cat]) view.cat = 'all';
    var cats = [['all', 'Todas']].concat(categories.map(function (c) { return [c.id, c.name]; }));
    ui.catChips.appendChild(chipRow(cats, view.cat, function (v) { view.cat = v; renderChips(); renderList(); }));
    var flt = [['all', 'Todos'], ['out', 'Agotados'], ['low', 'Pocas unidades'], ['nostore', 'Falta en tienda'], ['hidden', 'Ocultos']];
    ui.fltChips.appendChild(chipRow(flt, view.flt, function (v) { view.flt = v; renderChips(); renderList(); }));
  }

  function matches(p) {
    if (view.cat !== 'all' && p.cat !== view.cat) return false;
    if (view.flt === 'out' && statusOf(p) !== 'out') return false;
    if (view.flt === 'low' && statusOf(p) !== 'low') return false;
    if (view.flt === 'nostore' && !(p.store === 0 && p.warehouse > 0)) return false;
    if (view.flt === 'hidden' && p.visible) return false;
    var q = M.fold(view.q).trim();
    if (q && M.fold(p.name + ' ' + p.code + ' ' + catName(p.cat) + ' ' + p.sub).indexOf(q) === -1) return false;
    return true;
  }

  function renderList() {
    UI.clear(ui.list);
    if (!loaded) {
      ui.count.textContent = '';
      if (catalogError) {
        ui.list.appendChild(emptyNote(catalogError));
        var again = el('button', 'btn', 'Reintentar'); again.type = 'button';
        again.addEventListener('click', function () { UI.clear(ui.list); ui.list.appendChild(spinnerBox()); refreshCatalog(false); });
        ui.list.appendChild(again);
      } else ui.list.appendChild(spinnerBox());
      return;
    }
    if (!products.length) {
      ui.count.textContent = '';
      ui.list.appendChild(emptyNote('Todavía no hay productos. Crea el primero para empezar a llevar el inventario.'));
      var first = el('button', 'btn btn-primary', '+ Nuevo producto'); first.type = 'button';
      first.addEventListener('click', function () { productForm(null); });
      ui.list.appendChild(first);
      return;
    }
    var shown = products.filter(matches);
    ui.count.textContent = shown.length === products.length ? plural(products.length, 'producto', 'productos') : shown.length + ' de ' + products.length + ' productos';
    if (!shown.length) { ui.list.appendChild(emptyNote('Ningún producto coincide con lo que buscas.')); return; }

    var head = el('div', 'ahead');
    ['Producto', 'Existencias', '', ''].forEach(function (t, i) { head.appendChild(el('span', 'ahead-' + i, t)); });
    ui.list.appendChild(head);
    var ul = el('ul', 'alist');
    shown.forEach(function (p) { ul.appendChild(prodRow(p)); });
    ui.list.appendChild(ul);
  }

  function qtyBlock(label, n, cls) {
    var d = el('div', 'q ' + cls + (n === 0 ? ' q-zero' : ''));
    d.appendChild(el('span', 'q-label', label));
    d.appendChild(el('span', 'q-num num', String(n)));
    return d;
  }

  function prodRow(p) {
    var li = el('li', 'arow' + (p.visible ? '' : ' is-hidden'));

    var th = el('div', 'athumb');
    if (safeImg(p.photo)) { var im = el('img'); im.src = p.photo; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; th.appendChild(im); }
    else th.textContent = (p.name || '?').charAt(0).toUpperCase();
    li.appendChild(th);

    var body = el('div', 'abody');
    var top = el('div', 'aname-line');
    top.appendChild(el('span', 'aname', p.name));
    var st = statusOf(p);
    if (st === 'out') top.appendChild(el('span', 'badge badge-bad', 'Agotado'));
    else if (st === 'low') top.appendChild(el('span', 'badge badge-warn', 'Pocas'));
    else if (p.store === 0) top.appendChild(el('span', 'badge badge-warn', 'Falta en tienda'));
    if (!p.visible) top.appendChild(el('span', 'badge', 'Oculto'));
    body.appendChild(top);
    var meta = [p.code, catName(p.cat) + (p.sub ? ' · ' + p.sub : '')].filter(Boolean).join(' · ');
    body.appendChild(el('div', 'ameta', meta));
    body.appendChild(el('div', 'aprice num', fmt(p.price)));
    var cp = costOf(p);
    if (cp != null) body.appendChild(el('div', 'acost num', 'Costo ' + fmt(cp) + ' · gana ' + fmt(round2(p.price - cp))));
    li.appendChild(body);

    var q = el('div', 'aqty');
    q.appendChild(qtyBlock('En tienda', p.store, 'q-store'));
    q.appendChild(qtyBlock('En almacén', p.warehouse, 'q-wh'));
    li.appendChild(q);

    var act = el('div', 'aact');
    var bIn = el('button', 'btn btn-sm btn-primary', '+ Entrada'); bIn.type = 'button';
    bIn.addEventListener('click', function () { stockDialog('entry', p); });
    var bTr = el('button', 'btn btn-sm', 'Pasar a tienda'); bTr.type = 'button';
    bTr.addEventListener('click', function () { stockDialog('transfer', p, 'store'); });
    var bAd = el('button', 'btn btn-sm', 'Ajustar'); bAd.type = 'button';
    bAd.addEventListener('click', function () { stockDialog('adjust', p); });
    var bEd = el('button', 'btn btn-sm btn-quiet', 'Editar'); bEd.type = 'button';
    bEd.addEventListener('click', function () { productForm(p); });
    act.appendChild(bIn); act.appendChild(bTr); act.appendChild(bAd); act.appendChild(bEd);

    var more = el('details', 'more');
    more.appendChild(el('summary', 'btn btn-sm btn-quiet', 'Más'));
    var menu = el('div', 'more-menu');
    var bHist = el('button', 'btn btn-sm btn-quiet btn-block', 'Historial'); bHist.type = 'button';
    bHist.addEventListener('click', function () { historyDialog(p); });
    var bVis = el('button', 'btn btn-sm btn-quiet btn-block', p.visible ? 'Ocultar de la tienda' : 'Mostrar en la tienda'); bVis.type = 'button';
    bVis.addEventListener('click', function () {
      var next = {}; for (var k in p) next[k] = p[k]; next.visible = !p.visible;
      UI.busy(bVis, api.saveProduct(next).then(function (saved) {
        applyProduct(saved); UI.toast(saved.visible ? 'Ahora se ve en la tienda.' : 'Oculto: ya no se ve en la tienda.', 'ok');
      }, fail));
    });
    var bDel = el('button', 'btn btn-sm btn-danger btn-block', 'Eliminar'); bDel.type = 'button';
    UI.armConfirm(bDel, 'Toca otra vez para eliminar', function () {
      UI.busy(bDel, api.deleteProduct(p.id).then(function () {
        if (p.photoPath) api.removePhoto(p.photoPath);
        products = products.filter(function (x) { return x.id !== p.id; });
        delete priv[p.id];
        catalogSig = ''; indexData(); renderInv(); UI.toast('Producto eliminado.', 'ok');
      }, fail));
    });
    menu.appendChild(bHist); menu.appendChild(bVis); menu.appendChild(bDel);
    more.appendChild(menu);
    act.appendChild(more);
    li.appendChild(act);
    return li;
  }

  // Pone un producto (nuevo o cambiado) en la lista sin esperar a la próxima carga.
  function applyProduct(saved) {
    var found = false;
    products = products.map(function (x) { if (x.id === saved.id) { found = true; return saved; } return x; });
    if (!found) products.push(saved);
    products.sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
    catalogSig = '';
    indexData(); renderInv();
  }

  /* ------------------------------------------------------------------
     Ventanas: producto, cantidades e historial
     ------------------------------------------------------------------ */
  function subsOf(c) {
    var out = [];
    ((c && c.subs) || []).forEach(function (s) {
      var n = typeof s === 'string' ? s : (s && typeof s.name === 'string' ? s.name : '');
      if (n) out.push(n);
    });
    return out;
  }
  function amountText(v) { return v % 1 === 0 ? String(v) : v.toFixed(2); }

  function prodLine(p) {
    var d = el('div', 'dlg-prod');
    d.appendChild(el('strong', null, p.name));
    d.appendChild(el('span', 'muted', 'En tienda ' + p.store + ' · En almacén ' + p.warehouse));
    return d;
  }
  function buttonsRow(submitText) {
    var box = el('div', 'actions');
    var cancel = el('button', 'btn btn-quiet', 'Cancelar'); cancel.type = 'button';
    cancel.addEventListener('click', function () { UI.modal.close(); });
    var go = el('button', 'btn btn-primary push', submitText); go.type = 'submit';
    box.appendChild(cancel); box.appendChild(go);
    return { box: box, go: go };
  }

  /* ---------- Entrada · Pasar · Ajustar ---------- */
  function stockDialog(kind, p, preset) {
    var titles = { entry: 'Entrada de mercancía', transfer: 'Pasar mercancía', adjust: 'Ajustar cantidad' };
    var form = el('form'); form.noValidate = true;
    form.appendChild(prodLine(p));
    var dir = null, loc = null, mode = null;
    var info = el('p', 'hint info-line');
    var preview = el('p', 'preview'); preview.setAttribute('aria-live', 'polite');
    var err = formError();

    if (kind === 'entry') {
      form.appendChild(el('p', 'hint', 'La mercancía nueva entra al almacén. Después la pasas a la tienda cuando la pongas a la venta.'));
    }
    if (kind === 'transfer') {
      dir = UI.select([['store', 'Del almacén a la tienda'], ['warehouse', 'De la tienda al almacén']], preset || 'store');
      form.appendChild(UI.field('Mover', dir));
      form.appendChild(info);
    }
    if (kind === 'adjust') {
      loc = UI.select([['store', 'En la tienda'], ['warehouse', 'En el almacén']], 'store');
      mode = UI.select([['sub', 'Quitar (rebajar)'], ['add', 'Sumar']], 'sub');
      var r = el('div', 'row2'); r.appendChild(UI.field('Dónde', loc)); r.appendChild(UI.field('Qué hacer', mode));
      form.appendChild(r);
      form.appendChild(info);
    }
    var qty = UI.input('text', '', 7); qty.inputMode = 'numeric';
    var fQty = UI.field(kind === 'entry' ? 'Cantidad que entra' : 'Cantidad', qty);
    form.appendChild(fQty);

    var note = UI.input('text', '', 200);
    var fNote = UI.field(kind === 'adjust' ? 'Motivo (obligatorio)' : 'Nota (opcional)', note,
      kind === 'adjust' ? 'Queda guardado en Movimientos para que se sepa por qué cambió.' : (kind === 'entry' ? 'Por ejemplo: compra a proveedor, factura 123.' : ''));
    if (kind === 'adjust') {
      var reasons = el('div', 'chips reasons');
      ['Rotura', 'Pérdida', 'Uso propio', 'Regalo', 'Conteo de inventario', 'Corrección'].forEach(function (t) {
        var b = el('button', 'chip', t); b.type = 'button';
        b.addEventListener('click', function () { note.value = t; note.focus(); });
        reasons.appendChild(b);
      });
      form.appendChild(reasons);
    }
    form.appendChild(fNote);
    form.appendChild(preview);
    form.appendChild(err);
    var btns = buttonsRow(kind === 'entry' ? 'Registrar entrada' : kind === 'transfer' ? 'Pasar' : 'Guardar ajuste');
    form.appendChild(btns.box);

    function available() { return dir.value === 'store' ? p.warehouse : p.store; }
    function calc() {
      var q = parseWhole(qty.value);
      if (q === null || q < 1) return null;
      var s = p.store, w = p.warehouse, bad = '';
      if (kind === 'entry') w += q;
      else if (kind === 'transfer') {
        if (dir.value === 'store') { if (q > w) bad = 'En el almacén solo hay ' + w + '.'; s += q; w -= q; }
        else { if (q > s) bad = 'En la tienda solo hay ' + s + '.'; s -= q; w += q; }
      } else {
        var d = mode.value === 'sub' ? -q : q;
        if (loc.value === 'store') { s += d; if (s < 0) bad = 'En la tienda solo hay ' + p.store + '.'; }
        else { w += d; if (w < 0) bad = 'En el almacén solo hay ' + p.warehouse + '.'; }
      }
      return { q: q, s: s, w: w, bad: bad };
    }
    function update() {
      if (kind === 'transfer') info.textContent = 'Disponibles para pasar: ' + available() + '.';
      if (kind === 'adjust') info.textContent = 'Ahora hay ' + (loc.value === 'store' ? p.store + ' en la tienda' : p.warehouse + ' en el almacén') + '.';
      var c = calc();
      preview.className = 'preview' + (c && c.bad ? ' preview-bad' : '');
      preview.textContent = !c ? '' : (c.bad ? c.bad : 'Quedará: En tienda ' + c.s + ' · En almacén ' + c.w);
    }
    [qty, dir, loc, mode].forEach(function (n) { if (n) { n.addEventListener('input', update); n.addEventListener('change', update); } });
    update();

    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.show('');
      var c = calc();
      if (!c) { fQty.setError('Escribe cuántas unidades (un número entero, 1 o más).'); return; }
      fQty.setError('');
      if (c.bad) { fQty.setError(c.bad); return; }
      var n = note.value.trim();
      if (kind === 'adjust' && !n) { fNote.setError('Escribe el motivo del ajuste.'); return; }
      fNote.setError('');
      var call;
      if (kind === 'entry') call = api.stockEntry(p.id, c.q, n);
      else if (kind === 'transfer') call = api.stockTransfer(p.id, dir.value, c.q, n);
      else call = api.stockAdjust(p.id, loc.value, mode.value === 'sub' ? -c.q : c.q, n);
      UI.busy(btns.go, call.then(function (res) {
        p.store = res.store; p.warehouse = res.warehouse;
        catalogSig = ''; renderInv(); UI.modal.close();
        UI.toast((kind === 'entry' ? 'Entrada registrada. ' : kind === 'transfer' ? 'Listo. ' : 'Ajuste guardado. ') + 'En tienda ' + res.store + ' · En almacén ' + res.warehouse + '.', 'ok');
      }, function (er) { err.show(M.errorText(M.toError(er))); }));
    });
    UI.modal.open(titles[kind], form);
  }

  /* ---------- Historial de un producto ---------- */
  function historyDialog(p) {
    var box = el('div'); box.appendChild(prodLine(p));
    var holder = el('div', 'hist'); holder.appendChild(spinnerBox());
    box.appendChild(holder);
    UI.modal.open('Historial', box);
    api.listMovements({ productId: p.id, limit: 100 }).then(function (list) {
      UI.clear(holder);
      if (!list.length) { holder.appendChild(emptyNote('Este producto todavía no tiene movimientos.')); return; }
      list.forEach(function (m) { holder.appendChild(movRow(m, true)); });
    }, function (e) { UI.clear(holder); holder.appendChild(emptyNote(M.errorText(M.toError(e)))); });
  }

  /* ---------- Por reponer: lo que se acabó o va a faltar ---------- */
  function restockGroups() {
    var byName = function (a, b) { return a.name.localeCompare(b.name, 'es'); };
    var out = [], low = [], move = [];
    products.forEach(function (p) {
      var st = statusOf(p);
      if (st === 'out') out.push(p);
      else if (st === 'low') low.push(p);
      else if (p.store === 0 && p.warehouse > 0) move.push(p);
    });
    out.sort(byName); move.sort(byName);
    low.sort(function (a, b) { return totalOf(a) - totalOf(b) || byName(a, b); });
    return { out: out, low: low, move: move };
  }
  function restockText(g) {
    var L = ['Por reponer' + (settings.name ? ' · ' + settings.name : '') + ' · ' + M.fmtDate(Date.now())];
    if (g.out.length) {
      L.push(''); L.push('AGOTADOS (hay que comprar)');
      g.out.forEach(function (p) { L.push('• ' + p.name + (p.code ? ' (' + p.code + ')' : '')); });
    }
    if (g.low.length) {
      L.push(''); L.push('QUEDAN POCOS');
      g.low.forEach(function (p) { L.push('• ' + p.name + (p.code ? ' (' + p.code + ')' : '') + ' — quedan ' + totalOf(p) + ' (tienda ' + p.store + ', almacén ' + p.warehouse + ')'); });
    }
    return L.join('\n');
  }
  function restockDialog() {
    var g = restockGroups();
    var box = el('div', 'restock');
    if (!g.out.length && !g.low.length && !g.move.length) {
      box.appendChild(el('p', 'empty', 'No falta nada por ahora: todo tiene existencias suficientes.'));
      var okb = el('button', 'btn btn-primary btn-block', 'Cerrar'); okb.type = 'button';
      okb.addEventListener('click', function () { UI.modal.close(); });
      box.appendChild(okb);
      UI.modal.open('Por reponer', box);
      return;
    }
    box.appendChild(el('p', 'hint', 'Productos agotados o con pocas unidades. Cada producto puede tener su propio aviso: en Editar, «Avisarme cuando queden».'));
    function group(title, list, note, buy) {
      if (!list.length) return;
      var h = el('h3', 'cz-h', title + ' (' + list.length + ')'); box.appendChild(h);
      if (note) box.appendChild(el('p', 'hint', note));
      var ul = el('ul', 'rs-list');
      list.forEach(function (p) {
        var li = el('li', 'rs-item');
        var info = el('div', 'rs-info');
        info.appendChild(el('div', 'rs-name', p.name));
        info.appendChild(el('div', 'rs-sub muted num', (p.code ? p.code + ' · ' : '') + 'En tienda ' + p.store + ' · En almacén ' + p.warehouse + (totalOf(p) > 0 ? ' · avisa a las ' + reorderOf(p) : '')));
        li.appendChild(info);
        var acts = el('div', 'rs-acts');
        if (p.store === 0 && p.warehouse > 0) {
          var mv = el('button', 'btn btn-sm', 'Pasar a tienda'); mv.type = 'button';
          mv.addEventListener('click', function () { UI.modal.close(); stockDialog('transfer', p, 'store'); });
          acts.appendChild(mv);
        }
        if (buy) {
          var en = el('button', 'btn btn-sm btn-primary', '+ Entrada'); en.type = 'button';
          en.addEventListener('click', function () { UI.modal.close(); stockDialog('entry', p); });
          acts.appendChild(en);
        }
        li.appendChild(acts); ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    group('Agotados', g.out, 'No queda ninguno, ni en tienda ni en almacén.', true);
    group('Quedan pocos', g.low, '', true);
    group('Hay en el almacén, pero no en la tienda', g.move, 'No hace falta comprar: solo pasarlos a la tienda para poder venderlos.');

    if (g.out.length || g.low.length) {
      var report = restockText(g);
      var acts2 = el('div', 'actions');
      var cp = el('button', 'btn', 'Copiar lista'); cp.type = 'button';
      cp.addEventListener('click', function () {
        Cierre.copyText(report).then(function (ok) { UI.toast(ok ? 'Lista copiada.' : 'No se pudo copiar. Usa WhatsApp.', ok ? 'ok' : 'bad'); });
      });
      var wa = el('a', 'btn btn-primary push', 'Enviar por WhatsApp');
      wa.href = 'https://wa.me/?text=' + encodeURIComponent(report); wa.target = '_blank'; wa.rel = 'noopener noreferrer';
      acts2.appendChild(cp); acts2.appendChild(wa); box.appendChild(acts2);
    }
    UI.modal.open('Por reponer', box);
  }

  /* ---------- Crear o editar producto ---------- */
  function productForm(p) {
    var isNew = !p;
    if (!categories.length) { UI.toast('Primero crea una categoría en Ajustes.', 'bad'); return; }
    var cur = p || { id: '', name: '', code: '', cat: (view.cat !== 'all' && catById[view.cat]) ? view.cat : categories[0].id,
                     sub: '', price: 0, desc: '', photoPath: '', photo: '', visible: true, store: 0, warehouse: 0 };
    var urls = [];
    var newBlob = null, removeOld = false;
    var form = el('form'); form.noValidate = true;

    var name = UI.input('text', cur.name, 80);
    var fName = UI.field('Nombre', name);
    form.appendChild(fName);

    var catSel = UI.select(categories.map(function (c) { return [c.id, c.name]; }), cur.cat);
    var subSel = el('select');
    var wantSub = cur.sub;
    var fCat = UI.field('Categoría', catSel), fSub = UI.field('Subcategoría', subSel);
    var r1 = el('div', 'row2'); r1.appendChild(fCat); r1.appendChild(fSub); form.appendChild(r1);
    function fillSubs() {
      var subs = subsOf(catById[catSel.value]);
      if (wantSub && subs.indexOf(wantSub) === -1 && catSel.value === cur.cat) subs = subs.concat([wantSub]);
      UI.clear(subSel);
      var o0 = el('option', null, 'Sin subcategoría'); o0.value = ''; subSel.appendChild(o0);
      subs.forEach(function (s) { var o = el('option', null, s); o.value = s; subSel.appendChild(o); });
      subSel.value = subs.indexOf(wantSub) !== -1 ? wantSub : '';
    }
    fillSubs();

    var code = UI.input('text', cur.code, 20);
    var codeTouched = !isNew;
    function autoCode() { code.value = M.nextCode(products, catName(catSel.value)); }
    if (isNew) autoCode();
    code.addEventListener('input', function () { codeTouched = true; });
    catSel.addEventListener('change', function () { wantSub = ''; fillSubs(); if (!codeTouched) autoCode(); });
    subSel.addEventListener('change', function () { wantSub = subSel.value; });

    var price = UI.input('text', isNew ? '' : amountText(cur.price), 12); price.inputMode = 'decimal';
    var bt = baseText();
    var fPrice = UI.field('Precio de venta', price, bt ? 'En ' + bt + '. El trabajador siempre cobra este precio.' : 'Aún no dijiste en qué moneda están los precios: puedes hacerlo en Ajustes → Datos de la tienda.');
    var fCode = UI.field('Código', code, isNew ? 'Se pone solo; puedes cambiarlo.' : '');
    var r2 = el('div', 'row2'); r2.appendChild(fPrice); r2.appendChild(fCode); form.appendChild(r2);

    // Costo y aviso de reposición: solo los ve la dueña (viven en una tabla aparte, la tienda pública nunca los recibe)
    var pv0 = priv[cur.id] || {};
    var costIn = UI.input('text', pv0.cost != null ? amountText(pv0.cost) : '', 12); costIn.inputMode = 'decimal';
    var reIn = UI.input('text', pv0.reorderAt != null ? String(pv0.reorderAt) : '', 5); reIn.inputMode = 'numeric'; reIn.placeholder = String(LOW);
    var fCost = UI.field('Costo de cada uno', costIn, 'Lo que te cuesta a ti. En la misma moneda del precio.');
    var fRe = UI.field('Avisarme cuando queden', reIn, 'Unidades en total (tienda + almacén). Si lo dejas vacío, aviso a las ' + LOW + '.');
    var privBox = el('div', 'privbox');
    privBox.appendChild(el('p', 'privhead', '🔒 Solo lo ves tú'));
    var rp = el('div', 'row2'); rp.appendChild(fCost); rp.appendChild(fRe); privBox.appendChild(rp);
    var profitHint = el('p', 'hint profit-hint'); profitHint.setAttribute('aria-live', 'polite');
    privBox.appendChild(profitHint);
    if (!privLoaded) {
      costIn.disabled = true; reIn.disabled = true;
      privBox.appendChild(el('p', 'hint', privError || 'Todavía no se pudo leer el costo guardado. Actualiza la pantalla e inténtalo otra vez.'));
    }
    form.appendChild(privBox);
    function showProfit() {
      var pr = parseDecimal(price.value), c = parseDecimal(costIn.value);
      if (pr === null || c === null || costIn.value.trim() === '') { profitHint.textContent = ''; return; }
      var g = round2(pr - c);
      profitHint.textContent = g >= 0
        ? 'Ganas ' + fmt(g) + ' por unidad' + (pr > 0 ? ' (' + Math.round(100 * g / pr) + '% del precio).' : '.')
        : 'Ojo: el costo es mayor que el precio. Pierdes ' + fmt(-g) + ' por unidad.';
    }
    price.addEventListener('input', showProfit); costIn.addEventListener('input', showProfit); showProfit();

    var desc = el('textarea'); desc.value = cur.desc; desc.maxLength = 300; desc.rows = 3;
    var fDesc = UI.field('Descripción (opcional)', desc, 'Se ve en la página de la tienda.');
    form.appendChild(fDesc);

    // Foto
    var prev = el('div', 'photo-prev');
    function showPhoto(url) {
      UI.clear(prev);
      if (safeImg(url)) { var im = el('img'); im.src = url; im.alt = 'Foto del producto'; prev.appendChild(im); }
      else prev.appendChild(el('span', 'muted', 'Sin foto'));
    }
    showPhoto(cur.photo);
    var file = el('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp';
    var fFile = UI.field('Foto', file, 'Se reduce sola para que la página cargue rápido.');
    var rm = el('button', 'btn btn-sm btn-quiet', 'Quitar foto'); rm.type = 'button'; rm.hidden = !cur.photoPath;
    var photoBox = el('div', 'photo-box'); photoBox.appendChild(prev);
    var side = el('div', 'photo-side'); side.appendChild(fFile); side.appendChild(rm); photoBox.appendChild(side);
    form.appendChild(photoBox);
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; fFile.setError('');
      if (!f) return;
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { fFile.setError('Usa una foto JPG, PNG o WebP.'); file.value = ''; return; }
      M.shrinkImage(f, 900, 0.82).then(function (blob) {
        newBlob = blob; removeOld = false;
        var u = URL.createObjectURL(blob); urls.push(u); showPhoto(u); rm.hidden = false;
      }, function () { fFile.setError('No se pudo leer esa foto. Prueba con otra.'); file.value = ''; });
    });
    rm.addEventListener('click', function () {
      newBlob = null; removeOld = true; file.value = ''; showPhoto(''); rm.hidden = true;
    });

    var stIn = null, whIn = null, fSt = null, fWh = null;
    if (isNew) {
      stIn = UI.input('text', '0', 7); stIn.inputMode = 'numeric';
      whIn = UI.input('text', '0', 7); whIn.inputMode = 'numeric';
      fSt = UI.field('Cantidad en tienda', stIn); fWh = UI.field('Cantidad en almacén', whIn, 'Las existencias con que empieza.');
      var r3 = el('div', 'row2'); r3.appendChild(fSt); r3.appendChild(fWh); form.appendChild(r3);
    } else {
      form.appendChild(el('p', 'hint info-line', 'Ahora hay ' + p.store + ' en la tienda y ' + p.warehouse + ' en el almacén. Para cambiar cantidades usa Entrada, Pasar a tienda o Ajustar.'));
    }

    var vis = el('label', 'toggle'); var chk = UI.input('checkbox', ''); chk.checked = cur.visible;
    vis.appendChild(chk); vis.appendChild(el('span', null, 'Mostrar en la página de la tienda'));
    form.appendChild(vis);

    var err = formError(); form.appendChild(err);
    var btns = buttonsRow(isNew ? 'Crear producto' : 'Guardar cambios'); form.appendChild(btns.box);

    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.show('');
      var ok = true;
      var nm = name.value.trim();
      fName.setError(nm ? '' : 'Escribe el nombre del producto.'); if (!nm) ok = false;
      var pr = parseDecimal(price.value);
      fPrice.setError(pr === null ? 'Escribe un precio válido, por ejemplo 12.50.' : ''); if (pr === null) ok = false;
      var st = 0, wh = 0;
      if (isNew) {
        st = parseWhole(stIn.value.trim() === '' ? '0' : stIn.value); wh = parseWhole(whIn.value.trim() === '' ? '0' : whIn.value);
        fSt.setError(st === null ? 'Escribe un número entero (0 o más).' : ''); fWh.setError(wh === null ? 'Escribe un número entero (0 o más).' : '');
        if (st === null || wh === null) ok = false;
      }
      fCode.setError('');
      var costV = null, reV = null;
      if (privLoaded) {
        if (costIn.value.trim() !== '') { costV = parseDecimal(costIn.value); fCost.setError(costV === null ? 'Escribe un costo válido, por ejemplo 8.50.' : ''); if (costV === null) ok = false; } else fCost.setError('');
        if (reIn.value.trim() !== '') { reV = parseWhole(reIn.value, 9999); fRe.setError(reV === null ? 'Escribe un número entero (0 o más).' : ''); if (reV === null) ok = false; } else fRe.setError('');
      }
      if (!ok) return;
      var cd = code.value.trim() || (isNew ? M.nextCode(products, catName(catSel.value)) : '');
      var chain = newBlob ? api.uploadPhoto(newBlob) : Promise.resolve(null);
      UI.busy(btns.go, chain.then(function (up) {
        var rec = { id: isNew ? '' : p.id, name: nm, code: cd, cat: catSel.value, sub: subSel.value, price: pr, desc: desc.value.trim(),
                    photoPath: up ? up.path : (removeOld ? '' : cur.photoPath), visible: chk.checked, store: st, warehouse: wh };
        return api.saveProduct(rec).then(function (saved) {
          if (cur.photoPath && (up || removeOld)) api.removePhoto(cur.photoPath);
          return saved;
        }, function (er) { if (up) api.removePhoto(up.path); throw er; });
      }).then(function (saved) {
        // El costo se guarda aparte. Si falla, el producto ya quedó guardado: se avisa para volver a intentarlo.
        var changed = privLoaded && (costV !== (pv0.cost != null ? pv0.cost : null) || reV !== (pv0.reorderAt != null ? pv0.reorderAt : null));
        if (!changed) return { saved: saved, privOk: true };
        return api.savePrivate(saved.id, { cost: costV, reorderAt: reV }).then(function () {
          if (costV == null && reV == null) delete priv[saved.id]; else priv[saved.id] = { cost: costV, reorderAt: reV };
          return { saved: saved, privOk: true };
        }, function () { return { saved: saved, privOk: false }; });
      }).then(function (r) {
        applyProduct(r.saved); UI.modal.close();
        if (r.privOk) UI.toast(isNew ? 'Producto creado.' : 'Cambios guardados.', 'ok');
        else UI.toast('El producto se guardó, pero el costo no. Ábrelo con Editar y vuelve a intentarlo.', 'bad');
      }, function (er) {
        var x = M.toError(er);
        if (x.code === 'duplicate') fCode.setError('Ese código ya lo tiene otro producto.');
        else err.show(M.errorText(x));
      }));
    });

    UI.modal.open(isNew ? 'Nuevo producto' : 'Editar producto', form, function () {
      urls.forEach(function (u) { URL.revokeObjectURL(u); });
    });
  }

  /* ------------------------------------------------------------------
     MOVIMIENTOS
     ------------------------------------------------------------------ */
  function buildMovPanel() {
    var p = ui.panels.mov;
    var bar = el('div', 'tools');
    var q = el('input', 'search'); q.type = 'search'; q.placeholder = 'Buscar por producto'; q.setAttribute('aria-label', 'Buscar movimiento'); q.autocomplete = 'off'; q.maxLength = 60;
    q.addEventListener('input', function () { movState.q = q.value; renderMov(); });
    var ref = refreshIcon(); ref.setAttribute('aria-label', 'Actualizar'); ref.title = 'Actualizar';
    ref.addEventListener('click', function () { loadMovements(false); });
    bar.appendChild(q); bar.appendChild(ref);
    p.appendChild(bar);
    ui.movChips = el('div', 'chiprow'); p.appendChild(ui.movChips);
    p.appendChild(el('p', 'hint count-line', 'Aquí queda anotado cada cambio de cantidades: quién lo movió, cuándo y por qué.'));
    ui.movList = el('div', 'mlist'); p.appendChild(ui.movList);
  }

  function loadMovements(silent) {
    if (movState.loading) return;
    movState.loading = true;
    if (!silent && !movState.list) renderMov();
    api.listMovements({ limit: 500 }).then(function (list) { movState.list = list; movState.error = ''; },
      function (e) { movState.error = M.errorText(M.toError(e)); })
      .then(function () { movState.loading = false; renderMov(); });
  }

  function movRow(m, compact) {
    var r = el('div', 'mrow');
    var top = el('div', 'mtop');
    top.appendChild(el('span', KIND_BADGE[m.kind] || 'badge', KIND_TEXT[m.kind] || m.kind));
    if (!compact) top.appendChild(el('span', 'mname', m.productName));
    top.appendChild(el('span', 'mtime muted num', compact ? M.fmtDateTime(m.at) : M.fmtTime(m.at)));
    r.appendChild(top);
    var d = el('div', 'mdelta');
    if (m.dStore) d.appendChild(el('span', 'dpill ' + (m.dStore > 0 ? 'dpos' : 'dneg'), 'Tienda ' + signed(m.dStore)));
    if (m.dWarehouse) d.appendChild(el('span', 'dpill ' + (m.dWarehouse > 0 ? 'dpos' : 'dneg'), 'Almacén ' + signed(m.dWarehouse)));
    if (d.firstChild) r.appendChild(d);
    var sub = [];
    if (typeof m.storeAfter === 'number' && typeof m.warehouseAfter === 'number') sub.push('Quedaron: tienda ' + m.storeAfter + ' · almacén ' + m.warehouseAfter);
    if (m.note) sub.push(m.note);
    if (sub.length) r.appendChild(el('div', 'msub muted', sub.join(' — ')));
    return r;
  }

  function renderMov() {
    UI.clear(ui.movChips); UI.clear(ui.movList);
    ui.movChips.appendChild(chipRow([['all', 'Todos'], ['entry', 'Entradas'], ['transfer', 'Traspasos'], ['adjust', 'Ajustes'], ['sale', 'Ventas'], ['return', 'Devoluciones'], ['void', 'Anulaciones']],
      movState.kind, function (v) { movState.kind = v; renderMov(); }));
    if (!movState.list) {
      if (movState.error) {
        ui.movList.appendChild(emptyNote(movState.error));
        var b = el('button', 'btn', 'Reintentar'); b.type = 'button'; b.addEventListener('click', function () { movState.error = ''; loadMovements(false); });
        ui.movList.appendChild(b);
      } else ui.movList.appendChild(spinnerBox());
      return;
    }
    var q = M.fold(movState.q).trim();
    var list = movState.list.filter(function (m) {
      return (movState.kind === 'all' || m.kind === movState.kind) && (!q || M.fold(m.productName).indexOf(q) !== -1);
    });
    if (!list.length) { ui.movList.appendChild(emptyNote(movState.list.length ? 'Ningún movimiento coincide.' : 'Todavía no hay movimientos.')); return; }
    var last = '';
    list.forEach(function (m) {
      var k = dateKey(new Date(m.at));
      if (k !== last) {
        last = k;
        var today = dateKey(new Date()), yest = dateKey(new Date(Date.now() - 86400000));
        ui.movList.appendChild(el('h3', 'dayhead', k === today ? 'Hoy' : k === yest ? 'Ayer' : M.fmtDate(m.at)));
      }
      ui.movList.appendChild(movRow(m, false));
    });
  }

  /* ------------------------------------------------------------------
     VENTAS (informe de la dueña)
     ------------------------------------------------------------------ */
  var RANGES = [['today', 'Hoy'], ['yesterday', 'Ayer'], ['d7', 'Últimos 7 días'], ['d30', 'Últimos 30 días']];
  function rangeFor(key) {
    if (key === 'yesterday') return M.dayRange(-1);
    if (key === 'd7') return { from: M.dayRange(-6).from, to: M.dayRange(0).to };
    if (key === 'd30') return { from: M.dayRange(-29).from, to: M.dayRange(0).to };
    return M.dayRange(0);
  }
  function rangeLabel(key) { return RANGES.filter(function (r) { return r[0] === key; })[0][1]; }

  function buildSalesPanel() {
    var p = ui.panels.ventas;
    var bar = el('div', 'tools tools-sales');
    ui.salesChips = el('div', 'chiprow grow');
    var czBtn = el('button', 'btn btn-sm btn-primary', 'Cierre del día'); czBtn.type = 'button';
    czBtn.addEventListener('click', cierreDialog);
    var csvBtn = el('button', 'btn btn-sm', 'Descargar CSV'); csvBtn.type = 'button';
    csvBtn.addEventListener('click', downloadSales);
    var ref = refreshIcon(); ref.setAttribute('aria-label', 'Actualizar'); ref.title = 'Actualizar';
    ref.addEventListener('click', function () { loadSales(false); });
    bar.appendChild(ui.salesChips); bar.appendChild(czBtn); bar.appendChild(csvBtn); bar.appendChild(ref);
    p.appendChild(bar);
    ui.salesBody = el('div', 'sales-body'); p.appendChild(ui.salesBody);
  }

  function loadSales(silent) {
    var tok = ++salesState.token, key = salesState.range;
    if (!silent) { salesState.list = null; salesState.counts = []; salesState.error = ''; renderSales(); }
    var rg = rangeFor(key);
    // El cuadre de caja que dejó el trabajador: si no se puede leer, el resto del informe sigue funcionando.
    var cntP = api.listCashCounts({ from: dateKey(new Date(rg.from)), to: dateKey(new Date(new Date(rg.to).getTime() - 1)) }).then(null, function () { return null; });
    Promise.all([api.listSales(rg), cntP]).then(function (r) {
      if (tok !== salesState.token) return;
      salesState.list = r[0]; if (r[1]) salesState.counts = r[1]; salesState.error = ''; salesState.rangeKey = key;
    }, function (e) {
      if (tok !== salesState.token) return;
      if (!silent || !salesState.list) salesState.error = M.errorText(M.toError(e));
    }).then(function () { if (tok === salesState.token) renderSales(); });
  }

  function summarize(list) {
    // Todo va "neto": lo devuelto ya no cuenta como vendido.
    var s = { count: 0, voided: 0, shortage: 0, total: 0, gross: 0, returned: 0, units: 0, nopay: 0, pay: {}, top: {}, profit: null };
    list.forEach(function (x) {
      if (x.voidedAt) { s.voided++; return; }
      s.count++; s.gross += x.total; s.returned += M.returnedValue(x); if (x.hasShortage) s.shortage++;
      x.items.forEach(function (i) {
        var q = i.qty - (i.returned || 0);
        s.units += q;
        var k = i.productId || i.name;
        var t = s.top[k] || (s.top[k] = { name: i.name, qty: 0, amount: 0 });
        t.qty += q; t.amount += q * i.unitPrice;
      });
      if (!M.normPayments(x).length) s.nopay++;
    });
    s.pay = M.netTotals(list);
    s.gross = round2(s.gross); s.returned = round2(s.returned); s.total = round2(s.gross - s.returned);
    s.profit = M.profitOf(list);
    return s;
  }

  function renderSales() {
    UI.clear(ui.salesChips); UI.clear(ui.salesBody);
    ui.salesChips.appendChild(chipRow(RANGES, salesState.range, function (v) { salesState.range = v; loadSales(false); }));
    var list = salesState.list;
    if (!list) {
      if (salesState.error) {
        ui.salesBody.appendChild(emptyNote(salesState.error));
        var b = el('button', 'btn', 'Reintentar'); b.type = 'button'; b.addEventListener('click', function () { loadSales(false); });
        ui.salesBody.appendChild(b);
      } else ui.salesBody.appendChild(spinnerBox());
      return;
    }
    var s = summarize(list);
    var stats = el('div', 'stats');
    stats.appendChild(stat('Ventas', String(s.count), s.voided ? plural(s.voided, 'anulada', 'anuladas') : rangeLabel(salesState.range).toLowerCase()));
    stats.appendChild(stat('Total vendido', fmt(s.total), plural(s.units, 'unidad', 'unidades') + (s.nopay ? ' · ' + s.nopay + ' sin forma de pago' : '')));
    if (s.returned > 0) stats.appendChild(stat('Devuelto', fmt(s.returned), 'ya descontado del total'));
    var pf = s.profit;
    if (s.count && (pf.revenueKnown > 0 || pf.cost > 0)) {
      stats.appendChild(stat('Ganancia', fmt(pf.profit), pf.complete
        ? 'costo ' + fmt(pf.cost) + ' · solo la ves tú'
        : plural(pf.unknownUnits, 'unidad sin costo no cuenta', 'unidades sin costo no cuentan'), pf.profit < 0 ? 'stat-warn' : ''));
    }
    M.PAY_METHODS.forEach(function (m) { stats.appendChild(stat(m.label, amt(round2(s.pay[m.id].amt), m.cur), plural(s.pay[m.id].n, 'venta', 'ventas') + (s.returned > 0 ? ' · ya sin devoluciones' : ''))); });
    ui.salesBody.appendChild(stats);

    // Cuadre de caja: lo que contó el trabajador contra lo que debía haber
    var counts = salesState.counts || [];
    if (counts.length) {
      var off = [];
      counts.forEach(function (c) { Cierre.countOff(c).forEach(function (t) { off.push(t); }); });
      var cb = el('section', 'card cuadre-box');
      cb.appendChild(el('h3', 'section-title', 'Cuadre de caja'));
      if (off.length) {
        var cw = el('div', 'callout callout-warn');
        cw.appendChild(el('strong', null, 'La caja no cuadró. '));
        cw.appendChild(el('span', null, off.join(' · ') + '.'));
        cb.appendChild(cw);
      } else cb.appendChild(el('p', 'hint', 'La caja cuadró: lo contado coincide con lo que debía haber.'));
      var multiC = salesState.range === 'd7' || salesState.range === 'd30';
      counts.forEach(function (c) { cb.appendChild(Cierre.countBox(c, multiC)); });
      ui.salesBody.appendChild(cb);
    }

    if (s.shortage) {
      var w = el('div', 'callout callout-warn');
      w.appendChild(el('strong', null, plural(s.shortage, 'venta con faltante', 'ventas con faltante') + '. '));
      w.appendChild(el('span', null, 'Se vendieron más unidades de las que había en la tienda. Revisa el inventario: lo que faltaba no se descontó.'));
      ui.salesBody.appendChild(w);
    }
    if (!list.length) { ui.salesBody.appendChild(emptyNote('No hay ventas en este período.')); return; }

    var tops = Object.keys(s.top).map(function (k) { return s.top[k]; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, 8);
    if (tops.length) {
      var tb = el('section', 'card topbox');
      tb.appendChild(el('h3', 'section-title', 'Lo más vendido'));
      var mx = tops[0].qty;
      tops.forEach(function (t) {
        var row = el('div', 'toprow');
        var line = el('div', 'toprow-line');
        line.appendChild(el('span', 'toprow-name', t.name));
        line.appendChild(el('span', 'toprow-qty num', '× ' + t.qty));
        line.appendChild(el('span', 'toprow-amt num muted', fmt(round2(t.amount))));
        var bar = el('div', 'bar'); var fill = el('div', 'bar-fill'); fill.style.width = Math.max(4, Math.round(100 * t.qty / mx)) + '%'; bar.appendChild(fill);
        row.appendChild(line); row.appendChild(bar); tb.appendChild(row);
      });
      ui.salesBody.appendChild(tb);
    }

    ui.salesBody.appendChild(el('h3', 'section-title list-title', 'Detalle de ventas'));
    var wrap = el('div', 'slist');
    var multi = salesState.range === 'd7' || salesState.range === 'd30';
    list.forEach(function (x) { wrap.appendChild(saleCard(x, multi)); });
    ui.salesBody.appendChild(wrap);
  }

  function saleCard(x, withDate) {
    var d = el('details', 'sale' + (x.voidedAt ? ' is-void' : ''));
    var sum = el('summary', 'sale-sum');
    var main = el('div', 'sale-main');
    var l1 = el('div', 'sale-l1');
    l1.appendChild(el('span', 'sale-time num', withDate ? M.fmtDateTime(x.soldAt) : M.fmtTime(x.soldAt)));
    if (x.seller) l1.appendChild(el('span', 'muted', x.seller));
    if (x.voidedAt) l1.appendChild(el('span', 'badge badge-bad', 'Anulada'));
    if (x.hasShortage) l1.appendChild(el('span', 'badge badge-warn', 'Con faltante'));
    main.appendChild(l1);
    var names = x.items.slice(0, 2).map(function (i) { return i.qty + ' × ' + i.name; }).join(', ');
    if (x.items.length > 2) names += ' y ' + (x.items.length - 2) + ' más';
    main.appendChild(el('div', 'sale-items muted', names));
    var right = el('div', 'sale-right');
    var retV = M.returnedValue(x);
    right.appendChild(el('div', 'sale-total num', fmt(round2(x.total - retV))));
    if (retV > 0) right.appendChild(el('div', 'sale-pay muted num', 'de ' + fmt(x.total) + ' · devuelto ' + fmt(retV)));
    right.appendChild(el('div', 'sale-pay muted', M.payLine(x) || 'Sin forma de pago'));
    sum.appendChild(main); sum.appendChild(right);
    d.appendChild(sum);

    var body = el('div', 'sale-body');
    x.items.forEach(function (i) {
      var r = el('div', 'sline');
      r.appendChild(el('span', 'sline-name', i.qty + ' × ' + i.name + (i.code ? ' (' + i.code + ')' : '') + (i.returned ? ' · devueltas ' + i.returned : '')));
      r.appendChild(el('span', 'sline-amt num', fmt(round2(i.qty * i.unitPrice))));
      body.appendChild(r);
      if (i.unitCost != null && !x.voidedAt) body.appendChild(el('div', 'sline-cost muted num', 'Costo ' + fmt(i.unitCost) + ' c/u · gana ' + fmt(round2(i.unitPrice - i.unitCost)) + ' c/u'));
      if (i.deducted < i.qty) body.appendChild(el('div', 'sline-warn', 'Solo se descontaron ' + i.deducted + ' de ' + i.qty + ' de la tienda.'));
    });
    if (x.note) body.appendChild(el('p', 'hint', 'Nota: ' + x.note));
    (x.returns || []).forEach(function (r) {
      var what = r.items.map(function (i) { return i.qty + ' × ' + i.name; }).join(', ');
      var line = (r.mode === 'exchange' ? 'Cambio' : 'Devolución') + ' ' + M.fmtDateTime(r.at) + (r.seller ? ' · ' + r.seller : '') + ': ' + what + ' · ' + fmt(r.total);
      if (r.mode !== 'exchange') { var rl = M.payLine({ payments: r.refund }); if (rl) line += ' · devuelto ' + rl; }
      if (!r.restock) line += ' · dañado, no volvió a la tienda';
      if (r.reason) line += ' · ' + r.reason;
      body.appendChild(el('p', 'sale-ret num', line));
    });
    if (!x.voidedAt && x.items.some(function (i) { return i.id != null && M.returnable(i) > 0; })) {
      var rb = el('button', 'btn btn-sm', 'Devolver o cambiar'); rb.type = 'button';
      rb.addEventListener('click', function () { returnDialog(x); });
      body.appendChild(rb); body.appendChild(document.createTextNode(' '));
    }
    if (x.voidedAt) body.appendChild(el('p', 'hint', 'Anulada el ' + M.fmtDateTime(x.voidedAt) + (x.voidReason ? ' · ' + x.voidReason : '')));
    else {
      var v = el('button', 'btn btn-sm btn-danger', 'Anular venta'); v.type = 'button';
      v.addEventListener('click', function () { voidDialog(x); });
      body.appendChild(v);
    }
    d.appendChild(body);
    return d;
  }

  function returnDialog(x) {
    Devolucion.open({
      api: api, sale: x, settings: settings,
      onDone: function (res, info) {
        loadSales(true); refreshCatalog(false); movState.list = null;
        if (info.mode === 'exchange') UI.toast('Cambio registrado. Anota la venta nueva en Ventas y cobra solo la diferencia: lo devuelto vale ' + fmt(info.total) + '.', 'ok');
        else UI.toast(res && res.duplicate ? 'Esa devolución ya estaba registrada.' : 'Devolución registrada.', 'ok');
      }
    });
  }

  function voidDialog(x) {
    var back = 0; x.items.forEach(function (i) { back += i.deducted; });
    var form = el('form'); form.noValidate = true;
    form.appendChild(el('p', null, 'Venta de ' + fmt(x.total) + ' (' + M.fmtDateTime(x.soldAt) + '). Al anularla ' + (back ? 'vuelven a la tienda ' + plural(back, 'unidad', 'unidades') + '.' : 'no vuelve ninguna unidad a la tienda.')));
    var reason = UI.input('text', '', 200);
    var f = UI.field('Motivo (opcional)', reason, 'Por ejemplo: se equivocó de producto.');
    form.appendChild(f);
    var err = formError(); form.appendChild(err);
    var btns = buttonsRow('Anular venta'); btns.go.className = 'btn btn-danger push'; form.appendChild(btns.box);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.show('');
      UI.busy(btns.go, api.voidSale(x.id, reason.value.trim()).then(function () {
        UI.modal.close(); UI.toast('Venta anulada. Las unidades volvieron a la tienda.', 'ok');
        loadSales(true); refreshCatalog(false); movState.list = null;
      }, function (er) { err.show(M.errorText(M.toError(er))); }));
    });
    UI.modal.open('Anular venta', form);
  }

  // Cierre del día: elige el día (hoy o ayer ya vienen puestos) y muestra todo lo vendido con el total.
  function cierreDialog() {
    var form = el('form'); form.noValidate = true;
    form.appendChild(el('p', null, 'Resumen de un día: el total, lo cobrado por forma de pago y cada producto vendido. Se puede enviar por WhatsApp, imprimir o guardar como PDF.'));
    var day = el('input'); day.type = 'date';
    day.value = dateKey(new Date(Date.now() - (salesState.range === 'yesterday' ? 86400000 : 0)));
    day.max = dateKey(new Date());
    var f = UI.field('Día', day); form.appendChild(f);
    var err = formError(); form.appendChild(err);
    var btns = buttonsRow('Ver cierre'); form.appendChild(btns.box);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.show('');
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.value);
      if (!m) { f.setError('Elige un día.'); return; }
      f.setError('');
      var a = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      var b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1);
      var cntP = api.listCashCounts({ from: dateKey(a), to: dateKey(a) }).then(null, function () { return []; });
      UI.busy(btns.go, Promise.all([api.listSales({ from: a.toISOString(), to: b.toISOString() }), cntP]).then(function (r) {
        var list = r[0], g = restockGroups();
        UI.modal.close();
        Cierre.open({ sales: list, settings: settings, fileDate: dateKey(a), owner: true, counts: r[1],
                      showNoCount: list.some(function (x) { return !x.voidedAt; }),
                      restock: g.out.concat(g.low).map(function (p) { return { name: p.name, code: p.code, store: p.store, warehouse: p.warehouse, total: totalOf(p) }; }),
                      label: a.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) });
      }, function (er) { err.show(M.errorText(M.toError(er))); }));
    });
    UI.modal.open('Cierre del día', form);
  }

  function downloadSales() {
    var list = salesState.list;
    if (!list || !list.length) { UI.toast('No hay ventas para descargar en este período.', 'bad'); return; }
    var rows = [['Fecha', 'Hora', 'Vendedor', 'Producto', 'Código', 'Cantidad', 'Devueltas', 'Precio', 'Subtotal', 'Costo unitario', 'Ganancia',
                 'Efectivo MN', 'Efectivo USD', 'Transferencia (MN)', 'Estado', 'Nota']];
    list.slice().reverse().forEach(function (x) {
      var d = new Date(x.soldAt), pays = {};
      M.normPayments(x).forEach(function (p) { pays[p.method] = p.amount; });
      x.items.forEach(function (i, idx) {
        // lo cobrado se anota solo en la primera línea de cada venta para que las sumas no se repitan
        var ret = i.returned || 0, valid = !x.voidedAt && i.unitCost != null;
        rows.push([dateKey(d), M.fmtTime(x.soldAt), x.seller, i.name, i.code, i.qty, ret, i.unitPrice.toFixed(2), round2(i.qty * i.unitPrice).toFixed(2),
          i.unitCost != null ? Number(i.unitCost).toFixed(2) : '',
          valid ? round2((i.qty - ret) * i.unitPrice - (i.qty - (i.restocked || 0)) * i.unitCost).toFixed(2) : '',
          idx === 0 && pays.cash_mn ? pays.cash_mn.toFixed(2) : '', idx === 0 && pays.cash_usd ? pays.cash_usd.toFixed(2) : '',
          idx === 0 && pays.transfer ? pays.transfer.toFixed(2) : '', x.voidedAt ? 'Anulada' : 'Válida', x.note]);
      });
    });
    var r = rangeFor(salesState.range), a = dateKey(new Date(r.from)), b = dateKey(new Date(new Date(r.to).getTime() - 1));
    M.saveText('ventas-' + a + (a === b ? '' : '_a_' + b) + '.csv', M.csv(rows));
  }

  /* ------------------------------------------------------------------
     AJUSTES
     ------------------------------------------------------------------ */
  var SECTIONS = [
    ['cats', 'Categorías', 'Cómo se agrupan los productos en la tienda'],
    ['store', 'Datos de la tienda', 'Nombre, WhatsApp, dirección, moneda y tasa'],
    ['team', 'Quién puede entrar', 'Trabajador y asistente'],
    ['sec', 'Seguridad', 'Verificación en dos pasos'],
    ['copy', 'Copias', 'Descargar tus datos']
  ];

  function buildSettingsPanel() {
    var p = ui.panels.set;
    ui.sb = {};
    SECTIONS.forEach(function (s) {
      var d = el('details', 'card setcard');
      var sm = el('summary', 'set-sum');
      var t = el('div'); t.appendChild(el('div', 'set-title', s[1])); t.appendChild(el('div', 'hint', s[2]));
      sm.appendChild(t); sm.appendChild(el('span', 'chev'));
      d.appendChild(sm);
      var body = el('div', 'set-body'); d.appendChild(body);
      ui.sb[s[0]] = body; p.appendChild(d);
    });
  }

  function openSettings() {
    setState.draftCats = null;
    renderCats(); renderStoreForm(); renderCopies();
    loadTeam(); loadMfa();
  }

  /* ---------- Categorías ---------- */
  var TINTS = [['otros', 'Neutro'], ['arena', 'Arena'], ['rosa', 'Rosa suave'], ['cocina', 'Cocina'], ['hogar', 'Hogar'], ['ferreteria', 'Ferretería']];

  function slug(name, taken) {
    var base = M.fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'categoria';
    var id = base, n = 2;
    while (taken[id]) { id = base + '-' + n; n++; }
    return id;
  }

  function renderCats() {
    var box = ui.sb.cats; UI.clear(box);
    if (!setState.draftCats) {
      setState.draftCats = categories.map(function (c) { return { id: c.id, name: c.name, tint: c.tint || 'otros', phrase: c.phrase || '', subsText: subsOf(c).join(', '), isNew: false }; });
    }
    var draft = setState.draftCats;
    box.appendChild(el('p', 'hint', 'El orden de aquí es el orden en la tienda. Las subcategorías van separadas por coma. No se puede quitar una categoría que todavía tiene productos.'));
    draft.forEach(function (d, i) { box.appendChild(catRow(d, i, draft)); });
    var act = el('div', 'actions');
    var add = el('button', 'btn btn-quiet', '+ Nueva categoría'); add.type = 'button';
    add.addEventListener('click', function () { draft.push({ id: '', name: '', tint: 'otros', phrase: '', subsText: '', isNew: true }); renderCats(); var ins = box.querySelectorAll('.crow input'); if (ins.length) { var k = (draft.length - 1) * 3; if (ins[k]) ins[k].focus(); } });
    var save = el('button', 'btn btn-primary push', 'Guardar categorías'); save.type = 'button';
    save.addEventListener('click', function () { saveCats(save, draft); });
    act.appendChild(add); act.appendChild(save); box.appendChild(act);
  }

  function catRow(d, i, draft) {
    var row = el('div', 'crow');
    var name = UI.input('text', d.name, 40); name.addEventListener('input', function () { d.name = name.value; });
    var phrase = UI.input('text', d.phrase, 90); phrase.addEventListener('input', function () { d.phrase = phrase.value; });
    var subs = UI.input('text', d.subsText, 600); subs.addEventListener('input', function () { d.subsText = subs.value; });
    var tint = UI.select(TINTS, d.tint); tint.addEventListener('change', function () { d.tint = tint.value; });
    var main = el('div', 'crow-main');
    var r1 = el('div', 'row2'); r1.appendChild(UI.field('Nombre', name)); r1.appendChild(UI.field('Color de fondo', tint));
    main.appendChild(r1);
    main.appendChild(UI.field('Frase corta (se ve en la tienda)', phrase));
    main.appendChild(UI.field('Subcategorías', subs, 'Por ejemplo: Platos, Vasos, Ollas'));
    row.appendChild(main);

    var act = el('div', 'crow-act');
    var up = el('button', 'icon-btn', '↑'); up.type = 'button'; up.setAttribute('aria-label', 'Subir'); up.disabled = i === 0;
    up.addEventListener('click', function () { draft.splice(i - 1, 0, draft.splice(i, 1)[0]); renderCats(); });
    var down = el('button', 'icon-btn', '↓'); down.type = 'button'; down.setAttribute('aria-label', 'Bajar'); down.disabled = i === draft.length - 1;
    down.addEventListener('click', function () { draft.splice(i + 1, 0, draft.splice(i, 1)[0]); renderCats(); });
    act.appendChild(up); act.appendChild(down);
    var used = d.isNew ? 0 : products.filter(function (p) { return p.cat === d.id; }).length;
    var rm = el('button', 'btn btn-sm btn-danger', 'Quitar'); rm.type = 'button';
    if (used) { rm.disabled = true; rm.title = 'Tiene ' + plural(used, 'producto', 'productos'); }
    else UI.armConfirm(rm, '¿Seguro?', function () { draft.splice(i, 1); renderCats(); });
    act.appendChild(rm);
    if (used) act.appendChild(el('span', 'hint', plural(used, 'producto', 'productos')));
    row.appendChild(act);
    return row;
  }

  function saveCats(btn, draft) {
    var taken = {}; draft.forEach(function (d) { if (!d.isNew) taken[d.id] = true; });
    var list = [], names = {};
    for (var i = 0; i < draft.length; i++) {
      var d = draft[i], nm = d.name.trim();
      if (!nm) { UI.toast('Cada categoría necesita un nombre.', 'bad'); return; }
      if (names[M.fold(nm)]) { UI.toast('Hay dos categorías con el nombre «' + nm + '».', 'bad'); return; }
      names[M.fold(nm)] = true;
      var subs = [], seen = {};
      d.subsText.split(/[,\n]/).forEach(function (s) { s = s.trim().slice(0, 40); if (s && !seen[M.fold(s)]) { seen[M.fold(s)] = true; subs.push(s); } });
      if (subs.length > 30) { UI.toast('«' + nm + '» tiene demasiadas subcategorías (máximo 30).', 'bad'); return; }
      var id = d.id;
      if (d.isNew) { id = slug(nm, taken); taken[id] = true; }
      list.push({ id: id, name: nm, tint: d.tint, phrase: d.phrase.trim().slice(0, 90), subs: subs, position: i });
    }
    UI.busy(btn, api.saveCategories(list).then(function () {
      categories = list; setState.draftCats = null; catalogSig = ''; indexData(); renderCats(); renderChips();
      UI.toast('Categorías guardadas.', 'ok');
    }, fail));
  }

  /* ---------- Datos de la tienda ---------- */
  function renderStoreForm() {
    var box = ui.sb.store; UI.clear(box);
    var s = settings;
    var form = el('form'); form.noValidate = true;
    var name = UI.input('text', s.name, 60), place = UI.input('text', s.place, 60);
    var fName = UI.field('Nombre de la tienda', name), fPlace = UI.field('Lugar (ciudad o municipio)', place);
    var r1 = el('div', 'row2'); r1.appendChild(fName); r1.appendChild(fPlace); form.appendChild(r1);
    var wa = el('textarea'); wa.rows = 3; wa.maxLength = 120; wa.value = (s.whatsapp || []).join('\n');
    var fWa = UI.field('WhatsApp (uno por línea)', wa, 'Escribe solo números. Los clientes te escriben a estos números desde la tienda.');
    form.appendChild(fWa);
    var addr = UI.input('text', s.address, 160), hours = UI.input('text', s.hours, 120);
    var fAddr = UI.field('Dirección', addr), fHours = UI.field('Horario', hours, 'Por ejemplo: Lunes a sábado, 9:00 a 17:00');
    form.appendChild(fAddr); form.appendChild(fHours);
    var map = UI.input('url', s.mapUrl, 300); map.inputMode = 'url';
    var fMap = UI.field('Enlace del mapa (opcional)', map, 'Debe empezar por https://');
    form.appendChild(fMap);

    var cur = UI.input('text', s.currency, 4);
    var fCur = UI.field('Símbolo junto a los precios', cur, 'Por ejemplo: $ o USD');
    var base = UI.select([['', 'Sin definir'], ['usd', 'Dólares (USD)'], ['mn', 'Pesos (MN)']], s.baseCurrency || '');
    var fBase = UI.field('Los precios de la lista están en', base);
    var r2 = el('div', 'row2'); r2.appendChild(fCur); r2.appendChild(fBase); form.appendChild(r2);
    var rate = UI.input('text', s.mnPerUsd ? amountText(s.mnPerUsd) : '', 10); rate.inputMode = 'decimal';
    var fRate = UI.field('Pesos (MN) que vale 1 USD', rate, 'Ventas lo usa para sugerir cuánto cobrar si pagan en la otra moneda. Cámbialo cuando cambie la tasa.');
    form.appendChild(fRate);

    var about = el('textarea'); about.rows = 3; about.maxLength = 600; about.value = s.about || '';
    form.appendChild(UI.field('Sobre la tienda (opcional)', about));
    var err = formError(); form.appendChild(err);
    var save = el('button', 'btn btn-primary', 'Guardar datos'); save.type = 'submit';
    var act = el('div', 'actions'); act.appendChild(save); form.appendChild(act);

    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.show('');
      var ok = true;
      var nm = name.value.trim(); fName.setError(nm ? '' : 'Escribe el nombre.'); if (!nm) ok = false;
      var nums = [];
      wa.value.split(/\n/).forEach(function (l) { var d = l.replace(/\D/g, ''); if (l.trim()) nums.push(d); });
      var badNum = nums.some(function (n) { return n.length < 6 || n.length > 15; });
      fWa.setError(badNum ? 'Cada número debe tener entre 6 y 15 cifras.' : (nums.length > 4 ? 'Máximo 4 números.' : '')); if (badNum || nums.length > 4) ok = false;
      var mu = map.value.trim(), mapOk = true;
      if (mu) { try { mapOk = new URL(mu).protocol === 'https:'; } catch (x) { mapOk = false; } }
      fMap.setError(mapOk ? '' : 'El enlace debe empezar por https://'); if (!mapOk) ok = false;
      var rt = 0;
      if (rate.value.trim()) { rt = parseDecimal(rate.value); if (rt === null || rt <= 0 || rt > 100000) { fRate.setError('Escribe un número mayor que 0, por ejemplo 400.'); ok = false; } else fRate.setError(''); }
      else fRate.setError('');
      if (!ok) return;
      var next = {}; for (var k in settings) next[k] = settings[k];
      next.name = nm; next.place = place.value.trim(); next.whatsapp = nums; next.address = addr.value.trim(); next.hours = hours.value.trim();
      next.mapUrl = mu; next.currency = cur.value.trim(); next.baseCurrency = base.value; next.mnPerUsd = rt; next.about = about.value.trim();
      UI.busy(save, api.saveSettings(next).then(function () {
        settings = next; catalogSig = ''; renderInv(); UI.toast('Datos guardados.', 'ok');
      }, function (er) { err.show(M.errorText(M.toError(er))); }));
    });
    box.appendChild(form);
  }

  /* ---------- Equipo ---------- */
  function loadTeam() {
    setState.team = null; setState.teamError = ''; renderTeam();
    api.teamList().then(function (l) { setState.team = l; }, function (e) { setState.teamError = M.errorText(M.toError(e)); }).then(renderTeam);
  }

  function renderTeam() {
    var box = ui.sb.team; UI.clear(box);
    box.appendChild(el('p', 'hint', 'Para dar acceso a alguien, primero crea su cuenta en Supabase (Authentication → Users → Add user, con «Auto Confirm User»). Después escribe aquí el mismo correo y elige qué puede hacer.'));
    if (setState.teamError) box.appendChild(el('p', 'err', setState.teamError));
    else if (!setState.team) box.appendChild(spinnerBox());
    else {
      var list = el('div', 'team');
      setState.team.forEach(function (m) {
        var r = el('div', 'trow');
        var who = el('div', 'twho'); who.appendChild(el('div', 'tname', m.name || m.email)); if (m.name) who.appendChild(el('div', 'hint', m.email));
        r.appendChild(who);
        r.appendChild(el('span', m.role === 'owner' ? 'badge badge-accent' : 'badge', ROLE_TEXT[m.role] || m.role));
        if (m.role !== 'owner') {
          var b = el('button', 'btn btn-sm btn-danger', 'Quitar acceso'); b.type = 'button';
          UI.armConfirm(b, '¿Seguro?', function () {
            UI.busy(b, api.revokeAccess(m.userId).then(function () { UI.toast('Acceso quitado.', 'ok'); loadTeam(); }, fail));
          });
          r.appendChild(b);
        }
        list.appendChild(r);
      });
      box.appendChild(list);
    }
    var form = el('form', 'addteam'); form.noValidate = true;
    form.appendChild(el('h4', 'sub-title', 'Dar acceso'));
    var email = UI.input('email', '', 120); email.inputMode = 'email';
    var fEmail = UI.field('Correo de la cuenta', email);
    var nm = UI.input('text', '', 60); var fNm = UI.field('Nombre (opcional)', nm);
    var role = UI.select([['worker', 'Trabajador: solo registra ventas'], ['assistant', 'Asistente (Claude): cantidades y productos']], 'worker');
    var fRole = UI.field('Qué puede hacer', role);
    var r = el('div', 'row2'); r.appendChild(fEmail); r.appendChild(fNm); form.appendChild(r); form.appendChild(fRole);
    var err = formError(); form.appendChild(err);
    var go = el('button', 'btn btn-primary', 'Dar acceso'); go.type = 'submit';
    var act = el('div', 'actions'); act.appendChild(go); form.appendChild(act);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.show('');
      var em = email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { fEmail.setError('Escribe un correo válido.'); return; }
      fEmail.setError('');
      UI.busy(go, api.grantAccess(em, nm.value.trim(), role.value).then(function () {
        UI.toast('Acceso dado a ' + em + '.', 'ok'); loadTeam();
      }, function (er) { err.show(M.errorText(M.toError(er))); }));
    });
    box.appendChild(form);
  }

  /* ---------- Seguridad: verificación en dos pasos ---------- */
  function loadMfa() {
    setState.mfa = null; setState.mfaError = ''; renderMfa();
    api.mfa.status().then(function (s) { setState.mfa = s; }, function (e) { setState.mfaError = M.errorText(M.toError(e)); }).then(renderMfa);
  }

  function renderMfa() {
    var box = ui.sb.sec; UI.clear(box);
    box.appendChild(el('p', 'hint', 'Cada vez que entres, además de la contraseña te pedirá un código de 6 números que cambia cada 30 segundos (de una app como Google Authenticator, Microsoft Authenticator o Aegis). Aunque alguien conozca tu contraseña, sin tu teléfono no puede entrar.'));
    if (setState.mfaError) { box.appendChild(el('p', 'err', setState.mfaError)); return; }
    if (!setState.mfa) { box.appendChild(spinnerBox()); return; }
    var en = setState.mfaEnroll;
    if (en) {
      var card = el('div', 'mfa-enroll');
      card.appendChild(el('p', null, '1. Abre la app de verificación en tu teléfono y escanea este código.'));
      var qr = el('div', 'qr');
      if (typeof en.qr === 'string' && /^data:image\//.test(en.qr)) { var im = el('img'); im.src = en.qr; im.alt = 'Código QR para la app de verificación'; qr.appendChild(im); }
      card.appendChild(qr);
      card.appendChild(el('p', 'hint', 'Si no puedes escanearlo, escribe este código en la app:'));
      var sec = el('code', 'secret', en.secret); sec.setAttribute('translate', 'no'); card.appendChild(sec);
      card.appendChild(el('p', 'hint', 'Guarda ese código en un lugar seguro: con él puedes volver a configurar la app si cambias de teléfono.'));
      card.appendChild(el('p', null, '2. Escribe el código de 6 números que muestra la app.'));
      var form = el('form'); form.noValidate = true;
      var code = UI.input('text', '', 8); code.inputMode = 'numeric'; code.autocomplete = 'one-time-code';
      var f = UI.field('Código', code); form.appendChild(f);
      var act = el('div', 'actions');
      var cancel = el('button', 'btn btn-quiet', 'Cancelar'); cancel.type = 'button';
      cancel.addEventListener('click', function () { api.mfa.cancelEnroll(en.factorId); setState.mfaEnroll = null; renderMfa(); });
      var go = el('button', 'btn btn-primary push', 'Activar'); go.type = 'submit';
      act.appendChild(cancel); act.appendChild(go); form.appendChild(act);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!code.value.trim()) { f.setError('Escribe el código.'); return; }
        f.setError('');
        UI.busy(go, api.mfa.confirmEnroll(en.factorId, code.value).then(function () {
          setState.mfaEnroll = null; UI.toast('Verificación en dos pasos activada.', 'ok'); loadMfa();
        }, function (er) { f.setError(M.errorText(M.toError(er))); code.select(); }));
      });
      card.appendChild(form); box.appendChild(card);
      return;
    }
    var st = el('div', 'mfa-state');
    if (setState.mfa.enabled) {
      st.appendChild(el('span', 'badge badge-ok', 'Activada'));
      var off = el('button', 'btn btn-sm btn-danger', 'Desactivar'); off.type = 'button';
      UI.armConfirm(off, 'Toca otra vez para desactivar', function () {
        var fac = setState.mfa.factors[0];
        if (!fac) return;
        UI.busy(off, api.mfa.disable(fac.id).then(function () { UI.toast('Verificación en dos pasos desactivada.', 'ok'); loadMfa(); }, fail));
      });
      st.appendChild(off);
    } else {
      st.appendChild(el('span', 'badge badge-warn', 'Sin activar'));
      var on = el('button', 'btn btn-primary btn-sm', 'Activar ahora'); on.type = 'button';
      on.addEventListener('click', function () {
        UI.busy(on, api.mfa.enroll().then(function (r) { setState.mfaEnroll = r; renderMfa(); }, fail));
      });
      st.appendChild(on);
    }
    box.appendChild(st);
  }

  /* ---------- Copias ---------- */
  function renderCopies() {
    var box = ui.sb.copy; UI.clear(box);
    box.appendChild(el('p', 'hint', 'Archivos CSV que se abren con Excel. Conviene bajar una copia de vez en cuando.'));
    var act = el('div', 'actions actions-start');
    var bp = el('button', 'btn', 'Productos y cantidades (CSV)'); bp.type = 'button';
    bp.addEventListener('click', function () {
      var rows = [['Código', 'Producto', 'Categoría', 'Subcategoría', 'Precio', 'En tienda', 'En almacén', 'Visible en la tienda', 'Descripción']];
      products.forEach(function (p) { rows.push([p.code, p.name, catName(p.cat), p.sub, p.price.toFixed(2), p.store, p.warehouse, p.visible ? 'Sí' : 'No', p.desc]); });
      M.saveText('productos-' + dateKey(new Date()) + '.csv', M.csv(rows));
    });
    var bm = el('button', 'btn', 'Movimientos (CSV)'); bm.type = 'button';
    bm.addEventListener('click', function () {
      UI.busy(bm, api.listMovements({ limit: 1000 }).then(function (list) {
        var rows = [['Fecha', 'Hora', 'Tipo', 'Producto', 'Entra a tienda', 'Sale de tienda', 'Entra a almacén', 'Sale de almacén', 'Quedan en tienda', 'Quedan en almacén', 'Nota']];
        list.forEach(function (m) {
          rows.push([dateKey(new Date(m.at)), M.fmtTime(m.at), KIND_TEXT[m.kind] || m.kind, m.productName,
            m.dStore > 0 ? m.dStore : '', m.dStore < 0 ? -m.dStore : '', m.dWarehouse > 0 ? m.dWarehouse : '', m.dWarehouse < 0 ? -m.dWarehouse : '',
            m.storeAfter == null ? '' : m.storeAfter, m.warehouseAfter == null ? '' : m.warehouseAfter, m.note]);
        });
        M.saveText('movimientos-' + dateKey(new Date()) + '.csv', M.csv(rows));
      }, fail));
    });
    act.appendChild(bp); act.appendChild(bm); box.appendChild(act);
    box.appendChild(el('p', 'hint', 'Las ventas se descargan desde la pestaña Ventas, con el botón «Descargar CSV».'));
  }

  /* ------------------------------------------------------------------
     Inicio y cierre
     ------------------------------------------------------------------ */
  function resetState() {
    settings = { name: '', currency: '$', baseCurrency: '', mnPerUsd: 0 };
    categories = []; products = []; byId = {}; catById = {};
    fromCache = false; fetchedAt = 0; loaded = false; loadingCatalog = false; catalogError = ''; catalogSig = '';
    priv = {}; privLoaded = false; privError = '';
    view = { tab: 'inv', q: '', cat: 'all', flt: 'all' };
    movState = { list: null, loading: false, error: '', kind: 'all', q: '' };
    salesState = { range: 'today', list: null, counts: [], loading: false, error: '', rangeKey: '', token: 0 };
    setState = { team: null, teamError: '', mfa: null, mfaError: '', draftCats: null, mfaEnroll: null };
  }

  function onReady(s) {
    session = s;
    resetState();
    buildShell();
    showTab('inv');
    renderInv();
    refreshCatalog(false);
    pollTimer = setInterval(tick, POLL_MS);
    offOnline = M.onOnline(function () { refreshCatalog(false); });
    onVis = function () { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
  }

  function teardown() {
    session = null;
    clearInterval(pollTimer); pollTimer = null;
    if (offOnline) { offOnline(); offOnline = null; }
    if (onVis) { document.removeEventListener('visibilitychange', onVis); onVis = null; }
    UI.modal.close();
    resetState();
  }

  function fatal(e) {
    UI.clear(root);
    var box = el('main', 'login'), card = el('div', 'login-card');
    card.appendChild(el('p', 'center-note', M.errorText(M.toError(e))));
    box.appendChild(card); root.appendChild(box);
  }

  M.open({ staff: true, app: 'almacen' }).then(function (a) {
    api = a;
    UI.registerSW();
    gate = UI.authGate({
      root: root, api: api, title: 'Almacén', allow: ['owner'],
      onReady: onReady, onSignedOut: teardown
    });
  }, fatal);
})();
