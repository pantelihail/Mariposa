/* =====================================================================
   MARIPOSA · VENTAS (la usa el trabajador de la tienda)

   - Ve los productos con "En tienda" y "En almacén" (solo lectura).
   - Registra ventas. El precio siempre es el de la lista.
   - Si se cae el internet, las ventas se guardan en el teléfono y se
     envían solas al volver la conexión. No se pierde ninguna.

   Todo texto que viene de la base de datos se muestra con textContent.
   ===================================================================== */
(function () {
  'use strict';
  var M = window.Mariposa, UI = window.UI;
  var el = UI.el;
  var root = UI.$('root');

  var POLL_MS = 30000;        // refresco automático
  var SEND_TIMEOUT_MS = 12000; // si el envío no contesta, se trata como "sin conexión"

  var api = null, gate = null, session = null;
  var settings = { currency: '$', baseCurrency: '', mnPerUsd: 0 };
  var categories = [], rawProducts = [], products = [], byId = {};
  var fromCache = false, fetchedAt = 0, catalogLoaded = false, loadingCatalog = false, catalogError = '', catalogSig = '';
  var view = { tab: 'vender', cat: 'all', q: '' };
  var ticket = {}, order = [];
  var credit = 0;             // crédito de un cambio en curso (valor de lo que el cliente devolvió), en la moneda de la lista
  var queue = [];
  var todaySales = null, todayError = '', todayLoading = false, todayDirty = false, todayKey = '';
  var syncing = false, authProblem = false;
  var pollTimer = null, offOnline = null, sheet = null;
  var ui = {};

  /* ------------------------------------------------------------------
     Guardado local: cola de ventas pendientes, borrador del ticket y copia del catálogo
     ------------------------------------------------------------------ */
  function key(name) { return 'mariposa.ventas.' + name + '.' + (session ? session.userId : 'x'); }
  function saveQueue() { return M.store.set(key('queue'), queue); }
  function loadQueue() { var q = M.store.get(key('queue')); queue = Array.isArray(q) ? q : []; }
  function saveDraft() { M.store.set(key('draft'), { ticket: ticket, order: order, credit: credit }); }
  function loadDraft() {
    var d = M.store.get(key('draft'));
    ticket = {}; order = []; credit = d && typeof d.credit === 'number' && d.credit > 0 && d.credit < 1e9 ? round2(d.credit) : 0;
    if (d && d.ticket && Array.isArray(d.order)) {
      d.order.forEach(function (id) {
        var q = d.ticket[id];
        if (typeof id === 'string' && typeof q === 'number' && q >= 1 && q <= 100000 && order.indexOf(id) === -1) { ticket[id] = Math.floor(q); order.push(id); }
      });
    }
  }
  function pendingList() { return queue.filter(function (q) { return q.state === 'pending'; }); }
  function problemList() { return queue.filter(function (q) { return q.state === 'problem'; }); }

  /* ------------------------------------------------------------------
     Ayudas
     ------------------------------------------------------------------ */
  function fmt(n) { return M.money(n, settings.currency); }
  // Moneda de la forma de pago: "3,300.00 MN" (M.money pondría "MN3,300.00" para siglas de 2 letras)
  function curMoney(n, cur) { return M.money(n) + ' ' + cur; }
  function payLine(sale) { return M.payLine(sale); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function ticketCount() { var n = 0; order.forEach(function (id) { n += ticket[id]; }); return n; }
  function ticketTotal() {
    var t = 0;
    order.forEach(function (id) { var p = byId[id]; if (p) t += ticket[id] * p.price; });
    return round2(t);
  }
  // Lo que se cobra de verdad: el total menos el crédito del cambio (nunca menos de cero).
  function dueNow() { return round2(Math.max(0, ticketTotal() - credit)); }
  function parseAmount(s) {
    s = String(s || '').replace(/\s/g, '');
    if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
    var v = Number(s.replace(',', '.'));
    return isFinite(v) && v < 1e9 ? v : null;
  }
  function amountText(v) { return v % 1 === 0 ? String(v) : v.toFixed(2); }
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new M.Error('network')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function say(text) { if (ui.live) ui.live.textContent = text; }

  // Aplica las cantidades "reales" que devuelve el servidor tras una venta.
  function applyResultItems(items) {
    (items || []).forEach(function (i) {
      for (var k = 0; k < rawProducts.length; k++) {
        if (rawProducts[k].id === i.productId) { rawProducts[k].store = i.store; rawProducts[k].warehouse = i.warehouse; break; }
      }
    });
  }
  // Muestra las cantidades del servidor menos lo que está pendiente de enviar.
  function rebuildProducts() {
    var pend = {};
    pendingList().forEach(function (q) { q.items.forEach(function (i) { pend[i.productId] = (pend[i.productId] || 0) + i.qty; }); });
    products = rawProducts.map(function (p) {
      var o = {}; for (var k in p) o[k] = p[k];
      o.store = Math.max(0, p.store - (pend[p.id] || 0));
      return o;
    });
    byId = {}; products.forEach(function (p) { byId[p.id] = p; });
  }

  /* ------------------------------------------------------------------
     Estructura de la pantalla
     ------------------------------------------------------------------ */
  var REFRESH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function iconButton(label, onClick) {
    var b = el('button', 'icon-btn'); b.type = 'button'; b.setAttribute('aria-label', label);
    b.innerHTML = REFRESH_ICON;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildShell() {
    UI.clear(root);
    ui = {};
    root.appendChild(UI.header({ app: 'Ventas', session: session, onSignOut: requestSignOut }));
    ui.banners = el('div'); root.appendChild(ui.banners);

    // pestañas
    var bar = el('div', 'tabs-bar'), bw = el('div', 'vwrap'), tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    ui.tabBtns = {};
    [['vender', 'Vender'], ['hoy', 'Hoy']].forEach(function (t) {
      var b = el('button', 'tab', t[1]); b.type = 'button'; b.setAttribute('role', 'tab');
      b.addEventListener('click', function () { showTab(t[0]); });
      ui.tabBtns[t[0]] = b; tabs.appendChild(b);
    });
    ui.tabBadge = el('span', 'count'); ui.tabBadge.hidden = true; ui.tabBtns.hoy.appendChild(ui.tabBadge);
    bw.appendChild(tabs); bar.appendChild(bw); root.appendChild(bar);

    ui.main = el('main', 'vmain');

    // ---- Vender ----
    ui.vender = el('section'); ui.vender.setAttribute('aria-label', 'Vender');
    var vw = el('div', 'vwrap');
    var row = el('div', 'vbar');
    ui.search = el('input', 'search'); ui.search.type = 'search'; ui.search.placeholder = 'Buscar producto o código';
    ui.search.setAttribute('aria-label', 'Buscar producto o código'); ui.search.autocomplete = 'off';
    ui.search.addEventListener('input', function () { view.q = ui.search.value; renderList(); });
    row.appendChild(ui.search);
    row.appendChild(iconButton('Actualizar productos', function () { refreshAll(true); }));
    vw.appendChild(row);
    ui.credit = el('div', 'callout swap-box'); ui.credit.hidden = true; ui.credit.setAttribute('role', 'status');
    vw.appendChild(ui.credit);
    ui.cats = el('div', 'cats'); ui.cats.setAttribute('role', 'group'); ui.cats.setAttribute('aria-label', 'Categorías');
    vw.appendChild(ui.cats);
    ui.count = el('p', 'vcount muted');
    vw.appendChild(ui.count);
    ui.list = el('ul', 'plist');
    vw.appendChild(ui.list);
    ui.state = el('div', 'vstate');
    vw.appendChild(ui.state);
    ui.vender.appendChild(vw);
    ui.main.appendChild(ui.vender);

    // ---- Hoy ----
    ui.hoy = el('section'); ui.hoy.setAttribute('aria-label', 'Ventas de hoy');
    var hw = el('div', 'vwrap');
    var hh = el('div', 'hoy-head');
    ui.hoyTitle = el('h1', 'hoy-title', 'Hoy');
    hh.appendChild(ui.hoyTitle);
    hh.appendChild(iconButton('Actualizar ventas de hoy', function () { refreshAll(true); }));
    hw.appendChild(hh);
    ui.hoyBody = el('div');
    hw.appendChild(ui.hoyBody);
    ui.hoy.appendChild(hw);
    ui.main.appendChild(ui.hoy);
    root.appendChild(ui.main);

    // barra de cobro
    ui.cartbar = el('div', 'cartbar'); ui.cartbar.hidden = true;
    var cw = el('div', 'vwrap cartbar-in');
    ui.cartText = el('div', 'cartbar-text');
    ui.cartCount = el('span', 'cartbar-count');
    ui.cartTotal = el('span', 'cartbar-total num');
    ui.cartText.appendChild(ui.cartCount); ui.cartText.appendChild(ui.cartTotal);
    ui.cartBtn = el('button', 'btn btn-primary btn-cobrar', 'Cobrar'); ui.cartBtn.type = 'button';
    ui.cartBtn.addEventListener('click', openSheet);
    cw.appendChild(ui.cartText); cw.appendChild(ui.cartBtn);
    ui.cartbar.appendChild(cw);
    root.appendChild(ui.cartbar);

    ui.live = el('div', 'sr'); ui.live.setAttribute('aria-live', 'polite');
    root.appendChild(ui.live);
  }

  function showTab(name) {
    view.tab = name;
    ['vender', 'hoy'].forEach(function (n) {
      ui[n].hidden = n !== name;
      ui.tabBtns[n].setAttribute('aria-selected', String(n === name));
      ui.tabBtns[n].tabIndex = n === name ? 0 : -1;
    });
    renderCartbar();
    if (name === 'hoy') { renderHoy(); loadToday(); }
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------
     Avisos de arriba
     ------------------------------------------------------------------ */
  function banner(cls, text, btnText, onBtn) {
    var b = el('div', 'banner ' + cls), w = el('div', 'wrap');
    w.appendChild(el('span', null, text));
    if (btnText) { var x = el('button', 'link-btn', btnText); x.type = 'button'; x.addEventListener('click', onBtn); w.appendChild(x); }
    b.appendChild(w); ui.banners.appendChild(b);
  }
  function renderBanners() {
    if (!ui.banners) return;
    UI.clear(ui.banners);
    if (api.isDemo) banner('banner-info', 'Vista previa con datos de ejemplo.');
    if (fromCache) banner('', 'Sin conexión: se muestran los datos guardados a las ' + M.fmtTime(fetchedAt) + '.');
    if (authProblem) banner('banner-bad', 'Tu sesión terminó. Sal y vuelve a entrar para enviar las ventas pendientes.', 'Salir', function () { gate.signOut(); });
    var np = pendingList().length, nx = problemList().length;
    if (np) banner('', plural(np, 'venta pendiente', 'ventas pendientes') + '. Se enviarán solas cuando haya conexión.', 'Enviar ahora', function () { sync(true); });
    if (nx) banner('banner-bad', plural(nx, 'venta con problema', 'ventas con problema') + '. Revísalas en la pestaña Hoy.', 'Ver', function () { showTab('hoy'); });
    var n = np + nx;
    ui.tabBadge.hidden = !n; ui.tabBadge.textContent = String(n);
  }

  /* ------------------------------------------------------------------
     VENDER: lista de productos
     ------------------------------------------------------------------ */
  function visibleProducts() {
    var q = M.fold(view.q.trim());
    return products.filter(function (p) {
      if (view.cat !== 'all' && p.cat !== view.cat) return false;
      return !q || M.fold(p.name + ' ' + p.code).indexOf(q) !== -1;
    });
  }

  function renderChips() {
    UI.clear(ui.cats);
    if (view.cat !== 'all' && !categories.some(function (c) { return c.id === view.cat; })) view.cat = 'all';
    [{ id: 'all', name: 'Todo' }].concat(categories).forEach(function (c) {
      var b = el('button', 'chip', c.name); b.type = 'button';
      b.setAttribute('aria-pressed', String(view.cat === c.id));
      b.addEventListener('click', function () { view.cat = c.id; renderChips(); renderList(); });
      ui.cats.appendChild(b);
    });
    ui.cats.hidden = categories.length === 0;
  }

  function buildRow(p) {
    var qty = ticket[p.id] || 0;
    var li = el('li', 'prow' + (qty ? ' in' : '') + (p.store === 0 ? ' nostock' : ''));
    li.setAttribute('data-id', p.id);
    var btn = el('button', 'prod'); btn.type = 'button';
    btn.setAttribute('aria-label', 'Agregar ' + p.name + (qty ? '. Lleva ' + qty : ''));
    if (qty) btn.appendChild(el('span', 'prod-qty num', String(qty)));
    var body = el('span', 'prod-body');
    var top = el('span', 'prod-top');
    top.appendChild(el('span', 'prod-name', p.name));
    top.appendChild(el('span', 'prod-price num', fmt(p.price)));
    body.appendChild(top);
    var meta = el('span', 'prod-meta');
    meta.appendChild(el('span', 'pill pill-store num' + (p.store === 0 ? ' none' : p.store <= 2 ? ' low' : ''), 'En tienda ' + p.store));
    meta.appendChild(el('span', 'pill-wh num', 'En almacén ' + p.warehouse));
    if (p.code) meta.appendChild(el('span', 'prod-code', p.code));
    body.appendChild(meta);
    if (p.store === 0) body.appendChild(el('span', 'prod-warn', 'Sin existencia en tienda'));
    btn.appendChild(body);
    btn.addEventListener('click', function () { addToTicket(p.id); });
    li.appendChild(btn);
    if (qty) {
      var minus = el('button', 'minus', '−'); minus.type = 'button';
      minus.setAttribute('aria-label', 'Quitar uno de ' + p.name);
      minus.addEventListener('click', function () { setQty(p.id, qty - 1); });
      li.appendChild(minus);
    }
    return li;
  }

  function renderList() {
    if (!ui.list) return;
    UI.clear(ui.list); UI.clear(ui.state);
    if (!catalogLoaded) {
      ui.count.textContent = '';
      if (catalogError) {
        ui.state.appendChild(el('p', 'empty', catalogError));
        var again = el('button', 'btn btn-primary', 'Reintentar'); again.type = 'button';
        again.addEventListener('click', function () { refreshAll(true); });
        ui.state.appendChild(again);
      } else {
        var s = el('div', 'center-note'); s.appendChild(el('div', 'spinner')); s.appendChild(el('p', null, 'Cargando productos…'));
        ui.state.appendChild(s);
      }
      return;
    }
    var list = visibleProducts();
    ui.count.textContent = products.length ? plural(list.length, 'producto', 'productos') : '';
    if (!list.length) {
      var q = view.q.trim();
      ui.state.appendChild(el('p', 'empty',
        !products.length ? 'Todavía no hay productos. La dueña los agrega en Almacén.'
        : q ? 'No encontramos productos con esa búsqueda. Prueba con otra palabra o quita el filtro de categoría.'
        : 'No hay productos en esta categoría.'));
      return;
    }
    list.forEach(function (p) { ui.list.appendChild(buildRow(p)); });
  }

  function updateRow(id) {
    var p = byId[id];
    if (!p) return;
    for (var i = 0; i < ui.list.children.length; i++) {
      var old = ui.list.children[i];
      if (old.getAttribute('data-id') !== id) continue;
      var hadFocus = old.contains(document.activeElement);
      var wasMinus = hadFocus && document.activeElement.classList.contains('minus');
      var fresh = buildRow(p);
      ui.list.replaceChild(fresh, old);
      if (hadFocus) { var f = wasMinus ? fresh.querySelector('.minus') : null; (f || fresh.querySelector('.prod')).focus(); }
      return;
    }
  }

  /* ------------------------------------------------------------------
     Ticket
     ------------------------------------------------------------------ */
  function addToTicket(id) {
    if (!byId[id]) return;
    ticket[id] = (ticket[id] || 0) + 1;
    if (order.indexOf(id) === -1) order.push(id);
    afterTicketChange(id);
    say(byId[id].name + ': ' + ticket[id] + ' en el ticket');
  }
  function setQty(id, q) {
    if (q < 1) { delete ticket[id]; order = order.filter(function (x) { return x !== id; }); }
    else ticket[id] = Math.min(q, 100000);
    afterTicketChange(id);
  }
  function clearTicket() { ticket = {}; order = []; credit = 0; saveDraft(); }
  function renderCredit() {
    if (!ui.credit) return;
    UI.clear(ui.credit);
    ui.credit.hidden = !(credit > 0);
    if (!(credit > 0)) return;
    ui.credit.appendChild(el('strong', null, 'Cambio en curso. '));
    ui.credit.appendChild(el('span', null, 'El cliente tiene ' + fmt(credit) + ' a su favor por lo que devolvió. Elige el producto nuevo y cobra solo la diferencia.'));
    var drop = el('button', 'link-btn', 'Quitar el crédito'); drop.type = 'button';
    UI.armConfirm(drop, 'Toca otra vez para quitarlo', function () { credit = 0; saveDraft(); renderCredit(); renderCartbar(); if (sheet) sheet.refresh(); });
    ui.credit.appendChild(document.createTextNode(' ')); ui.credit.appendChild(drop);
  }
  function afterTicketChange(id) {
    saveDraft();
    updateRow(id);
    renderCartbar();
    if (sheet) sheet.refresh();
  }
  function renderCartbar() {
    renderCredit();
    var n = ticketCount();
    var show = n > 0 && view.tab === 'vender';
    ui.cartbar.hidden = !show;
    ui.main.classList.toggle('has-bar', show);
    ui.cartCount.textContent = plural(n, 'artículo', 'artículos');
    ui.cartTotal.textContent = credit > 0 ? 'A cobrar ' + fmt(dueNow()) : fmt(ticketTotal());
  }

  /* ------------------------------------------------------------------
     Cobrar (hoja desde abajo)
     ------------------------------------------------------------------ */
  function openSheet() {
    if (!ticketCount() || sheet) return;
    var st = { amounts: { cash_mn: '', cash_usd: '', transfer: '' }, submitting: false, confirmShort: false };
    var returnTo = document.activeElement;

    var overlay = el('div', 'sheet');
    var scrim = el('div', 'sheet-scrim');
    var card = el('div', 'sheet-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'sheetTitle');

    var top = el('div', 'modal-top');
    var h = el('h2', null, 'Cobrar'); h.id = 'sheetTitle';
    var x = el('button', 'x-btn'); x.type = 'button'; x.setAttribute('aria-label', 'Cerrar');
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    top.appendChild(h); top.appendChild(x);
    card.appendChild(top);

    var lines = el('div', 'lines'); card.appendChild(lines);
    var warn = el('p', 'callout'); warn.hidden = true; card.appendChild(warn);

    var totalRow = el('div', 'total-row');
    totalRow.appendChild(el('span', 'total-label', 'Total'));
    var totalVal = el('span', 'total-val num'); totalRow.appendChild(totalVal);
    card.appendChild(totalRow);
    var creditRow = el('div', 'total-row total-sub'); creditRow.hidden = true;
    creditRow.appendChild(el('span', 'total-label', 'Crédito por el cambio'));
    var creditVal = el('span', 'total-val num'); creditRow.appendChild(creditVal);
    card.appendChild(creditRow);
    var dueRow = el('div', 'total-row'); dueRow.hidden = true;
    dueRow.appendChild(el('span', 'total-label', 'A cobrar'));
    var dueVal = el('span', 'total-val num'); dueRow.appendChild(dueVal);
    card.appendChild(dueRow);

    // forma de pago: una fila por forma, se pueden mezclar (por ejemplo una parte en MN y otra en USD)
    var payField = el('div', 'field');
    var payLabel = el('span', 'flabel', 'Cómo pagó el cliente'); payLabel.id = 'payLabel';
    payField.appendChild(payLabel);
    payField.appendChild(el('p', 'hint', 'Escribe lo que recibiste en cada forma. Puedes mezclar.'));
    var pmRows = el('div', 'pm-rows'); pmRows.setAttribute('role', 'group'); pmRows.setAttribute('aria-labelledby', 'payLabel');
    var pmInputs = {}, pmErrs = {}, pmFills = {};
    M.PAY_METHODS.forEach(function (m) {
      var row = el('div', 'pm-row');
      var lab = el('label', 'pm-label', m.label); lab.htmlFor = 'pm-' + m.id;
      var line = el('div', 'pm-line');
      var inp = UI.input('text', '', 14); inp.id = 'pm-' + m.id; inp.inputMode = 'decimal'; inp.placeholder = '0';
      inp.addEventListener('input', function () {
        st.amounts[m.id] = inp.value; st.confirmShort = false; pmErrs[m.id].hidden = true; payErr.hidden = true; drawPay();
      });
      var unit = el('span', 'pm-unit', m.cur);
      var fill = el('button', 'btn btn-sm pm-fill', 'Todo'); fill.type = 'button';
      fill.setAttribute('aria-label', 'Cobrar todo lo que falta en ' + m.label);
      fill.addEventListener('click', function () {
        var others = currentPayments(m.id);
        var left = M.payStatus(dueNow(), others, settings).left;
        var v = left > 0 ? M.suggestPay(left, m.id, settings) : null;
        if (v != null && v > 0) { inp.value = amountText(v); st.amounts[m.id] = inp.value; st.confirmShort = false; pmErrs[m.id].hidden = true; payErr.hidden = true; drawPay(); }
        inp.focus();
      });
      line.appendChild(inp); line.appendChild(unit); line.appendChild(fill);
      var er = el('p', 'err'); er.hidden = true; er.setAttribute('role', 'alert');
      row.appendChild(lab); row.appendChild(line); row.appendChild(er);
      pmRows.appendChild(row);
      pmInputs[m.id] = inp; pmErrs[m.id] = er; pmFills[m.id] = fill;
    });
    payField.appendChild(pmRows);
    var payStat = el('p', 'paystat'); payStat.setAttribute('role', 'status'); payStat.setAttribute('aria-live', 'polite');
    payField.appendChild(payStat);
    var payErr = el('p', 'err'); payErr.hidden = true; payErr.setAttribute('role', 'alert');
    payField.appendChild(payErr);
    card.appendChild(payField);

    // pagos que se han escrito (ignora vacíos, ceros y lo que no se entiende), sin contar la forma 'skip'
    function currentPayments(skip) {
      var out = [];
      M.PAY_METHODS.forEach(function (m) {
        if (m.id === skip) return;
        var v = parseAmount(st.amounts[m.id]);
        if (v != null && v > 0) out.push({ method: m.id, amount: v });
      });
      return out;
    }
    function otherCur(cur) { return cur === 'USD' ? 'MN' : 'USD'; }
    // "Falta: 4.00 USD (1,600.00 MN)" con la tasa de la tienda
    function leftText(v) {
      var base = M.baseCur(settings), t = fmt(round2(v));
      if (base && settings.mnPerUsd > 0) {
        var oc = otherCur(base);
        t += ' (' + curMoney(round2(base === 'USD' ? v * settings.mnPerUsd : v / settings.mnPerUsd), oc) + ')';
      }
      return t;
    }

    var noteIn = el('textarea'); noteIn.rows = 2; noteIn.maxLength = 200;
    card.appendChild(UI.field('Nota (opcional)', noteIn));

    var general = el('p', 'err'); general.hidden = true; general.setAttribute('role', 'alert');
    card.appendChild(general);

    var actions = el('div', 'actions actions-col');
    var go = el('button', 'btn btn-primary btn-block btn-cobrar', 'Registrar venta'); go.type = 'submit';
    var back = el('button', 'btn btn-block btn-quiet', 'Seguir vendiendo'); back.type = 'button';
    actions.appendChild(go); actions.appendChild(back);
    card.appendChild(actions);

    overlay.appendChild(scrim); overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    function drawPay() {
      var total = dueNow(), pays = currentPayments(null);
      var stt = M.payStatus(total, pays, settings);
      M.PAY_METHODS.forEach(function (m) {
        pmFills[m.id].hidden = !(M.baseCur(settings) && (M.baseCur(settings) === m.cur || settings.mnPerUsd > 0));
      });
      payStat.className = 'paystat';
      if (!pays.length && total <= 0.005 && credit > 0) {
        var extra = round2(credit - ticketTotal());
        payStat.textContent = 'El crédito del cambio cubre todo: no hay que cobrar nada ✓' + (extra > 0.005 ? ' Sobran ' + fmt(extra) + ' a favor del cliente: devuélveselos o déjalos para otra compra.' : '');
        payStat.classList.add('ok');
      } else if (!pays.length) {
        payStat.textContent = M.baseCur(settings) ? 'Total a cobrar: ' + leftText(total) : 'Total: ' + fmt(total) + '. Escribe lo que recibiste en cada forma.';
      } else if (!stt.known) {
        payStat.textContent = 'Total: ' + fmt(total) + '. Revisa que lo recibido cubra el total.';
      } else if (stt.left > 0.005) {
        payStat.textContent = 'Falta cobrar: ' + leftText(stt.left); payStat.classList.add('warn');
      } else if (stt.left < -0.005) {
        payStat.textContent = 'Cobrado de más. Cambio a devolver: ' + leftText(-stt.left); payStat.classList.add('info');
      } else {
        payStat.textContent = 'Cobrado completo ✓'; payStat.classList.add('ok');
      }
    }

    function drawLines() {
      UI.clear(lines);
      var over = false;
      order.forEach(function (id) {
        var p = byId[id]; if (!p) return;
        var q = ticket[id];
        var line = el('div', 'line');
        var info = el('div', 'line-info');
        info.appendChild(el('div', 'line-name', p.name));
        info.appendChild(el('div', 'line-sub num', q + ' × ' + fmt(p.price) + ' = ' + fmt(round2(q * p.price))));
        if (q > p.store) {
          over = true;
          info.appendChild(el('div', 'line-warn', p.store === 0 ? 'Sin existencia en tienda' : 'Solo hay ' + p.store + ' en tienda'));
        }
        var step = el('div', 'step');
        var m1 = el('button', 'icon-btn', '−'); m1.type = 'button'; m1.setAttribute('aria-label', 'Quitar uno de ' + p.name);
        m1.addEventListener('click', function () { setQty(id, q - 1); });
        var qn = el('span', 'step-qty num', String(q));
        var p1 = el('button', 'icon-btn', '+'); p1.type = 'button'; p1.setAttribute('aria-label', 'Agregar uno de ' + p.name);
        p1.addEventListener('click', function () { setQty(id, q + 1); });
        var rm = el('button', 'icon-btn', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', 'Quitar ' + p.name + ' del ticket');
        rm.addEventListener('click', function () { setQty(id, 0); });
        step.appendChild(m1); step.appendChild(qn); step.appendChild(p1); step.appendChild(rm);
        line.appendChild(info); line.appendChild(step);
        lines.appendChild(line);
      });
      warn.hidden = !over;
      warn.textContent = 'Según el sistema, no hay suficiente en tienda para algunos productos. La venta se registra igual, pero avisa a la dueña.';
    }

    function refresh() {
      if (!ticketCount()) { close(); return; }
      drawLines();
      totalVal.textContent = fmt(ticketTotal());
      creditRow.hidden = !(credit > 0); dueRow.hidden = !(credit > 0);
      creditVal.textContent = '−' + fmt(Math.min(credit, ticketTotal()));
      dueVal.textContent = fmt(dueNow());
      drawPay();
    }

    function focusables() {
      return Array.prototype.filter.call(card.querySelectorAll('button, input, select, textarea'), function (n) { return !n.disabled && n.offsetParent !== null; });
    }
    function onKey(e) {
      if (e.key === 'Escape' && !st.submitting) { close(); return; }
      if (e.key !== 'Tab') return;
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function close() {
      if (st.submitting) return;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.style.overflow = '';
      sheet = null;
      if (returnTo && document.contains(returnTo) && returnTo.focus) returnTo.focus();
    }
    sheet = { refresh: refresh, close: close, isSubmitting: function () { return st.submitting; } };
    document.addEventListener('keydown', onKey);
    x.addEventListener('click', close); back.addEventListener('click', close); scrim.addEventListener('click', close);

    function submit() {
      if (st.submitting) return;
      general.hidden = true;
      var ok = true, pays = [], firstBad = null;
      M.PAY_METHODS.forEach(function (m) {
        var raw = String(st.amounts[m.id] || '').trim();
        pmErrs[m.id].hidden = true;
        if (raw === '') return;
        var v = parseAmount(raw);
        if (v == null) {
          pmErrs[m.id].textContent = 'Escribe un monto válido, por ejemplo 1800 o 1800.50 (sin comas de miles).';
          pmErrs[m.id].hidden = false; ok = false; if (!firstBad) firstBad = pmInputs[m.id];
        } else if (v > 0) pays.push({ method: m.id, amount: v });
      });
      if (ok && !pays.length && dueNow() > 0.005) {
        payErr.textContent = 'Escribe cuánto pagó el cliente en al menos una forma de pago.'; payErr.hidden = false; ok = false; firstBad = pmInputs.cash_mn;
      }
      if (!ok) { if (firstBad) firstBad.focus(); return; }
      // Si el sistema sabe cuánto debía pagar y falta, se pide confirmar (un toque más).
      var stt = M.payStatus(dueNow(), pays, settings);
      if (stt.known && stt.left > Math.max(0.01, dueNow() * 0.005) && !st.confirmShort) {
        st.confirmShort = true;
        payErr.textContent = 'Falta cobrar ' + leftText(stt.left) + '. Si el cliente pagó menos, toca otra vez «Registrar venta».';
        payErr.hidden = false; return;
      }
      payErr.hidden = true;

      var sale = {
        id: M.uuid(),                               // se genera ANTES de enviar: un reenvío no duplica
        soldAt: new Date().toISOString(),
        note: ((credit > 0 ? 'Cambio (crédito ' + fmt(Math.min(credit, ticketTotal())) + ')' + (noteIn.value.trim() ? ' · ' : '') : '') + noteIn.value.trim()).slice(0, 200),
        payments: pays,
        total: ticketTotal(),
        items: order.map(function (id) { return { productId: id, qty: ticket[id], name: byId[id].name, unitPrice: byId[id].price }; })
      };
      st.submitting = true; go.disabled = true; back.disabled = true; x.disabled = true; go.textContent = 'Registrando…';

      function unlock() { st.submitting = false; go.disabled = false; back.disabled = false; x.disabled = false; go.textContent = 'Registrar venta'; }

      withTimeout(api.registerSale(toPayload(sale)), SEND_TIMEOUT_MS).then(function (res) {
        st.submitting = false;
        clearTicket(); close();
        applyResultItems(res.items); rebuildProducts();
        todaySales = null;
        renderAfterSale();
        toast('Venta registrada · ' + fmt(res.total), 'ok');
        if (res.hasShortage) shortageNotice();
        sync();
        if (view.tab === 'hoy') loadToday();
      }, function (e) {
        var code = e && e.code;
        if (code === 'network' || code === 'auth') {
          // No se pierde: queda guardada en el teléfono y se envía sola.
          sale.state = 'pending'; sale.error = '';
          queue.push(sale);
          if (!saveQueue()) {
            queue.pop(); unlock();
            general.textContent = 'No se pudo guardar la venta en este teléfono (falta espacio). No cierres: libera espacio e inténtalo otra vez.';
            general.hidden = false; return;
          }
          if (code === 'auth') authProblem = true;
          st.submitting = false;
          clearTicket(); close();
          rebuildProducts(); renderAfterSale();
          toast(code === 'auth' ? 'Tu sesión terminó. La venta quedó guardada: sal y entra otra vez para enviarla.' : 'Sin conexión: venta guardada, se enviará sola', 'bad');
          return;
        }
        unlock();
        general.textContent = M.errorText(e);
        general.hidden = false;
      });
    }
    go.addEventListener('click', submit);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    });

    refresh();
    setTimeout(function () { var f = pmInputs.cash_mn; if (f) f.focus(); }, 0);
  }

  function toPayload(s) {
    return {
      id: s.id, soldAt: s.soldAt, note: s.note || '', payments: M.normPayments(s),
      items: s.items.map(function (i) { return { productId: i.productId, qty: i.qty }; })
    };
  }
  function toast(msg, kind) { UI.toast(msg, kind); }
  function renderAfterSale() { renderBanners(); renderList(); renderCartbar(); if (view.tab === 'hoy') renderHoy(); }

  function shortageNotice() {
    var box = el('div');
    box.appendChild(el('p', null, 'No había suficiente en el sistema para esta venta. Avisa a la dueña para corregir el inventario.'));
    var ok = el('button', 'btn btn-primary btn-block', 'OK'); ok.type = 'button';
    ok.addEventListener('click', function () { UI.modal.close(); });
    box.appendChild(ok);
    UI.modal.open('Aviso', box);
  }

  /* ------------------------------------------------------------------
     Enviar las ventas pendientes (una a una, de la más antigua a la más nueva)
     ------------------------------------------------------------------ */
  function sync(manual) {
    if (syncing) return Promise.resolve();
    var list = pendingList().sort(function (a, b) { return new Date(a.soldAt) - new Date(b.soldAt); });
    if (!list.length) return Promise.resolve();
    syncing = true;
    var sent = 0, shortage = 0, stopped = '';

    function step(i) {
      if (i >= list.length || stopped) return Promise.resolve();
      var q = list[i];
      function done(res) {
        queue = queue.filter(function (x) { return x.id !== q.id; });
        saveQueue();
        if (res) applyResultItems(res.items);
        sent++; if (res && res.hasShortage) shortage++;
      }
      return withTimeout(api.registerSale(toPayload(q)), SEND_TIMEOUT_MS).then(done, function (e) {
        var code = e && e.code;
        if (code === 'duplicate') { done(null); return; }              // ya estaba registrada
        if (code === 'network') { stopped = 'network'; return; }       // sigue sin conexión: se reintenta luego
        if (code === 'auth' || code === 'forbidden') { stopped = 'auth'; return; }
        q.state = 'problem'; q.error = M.errorText(e); saveQueue();    // error que no se arregla solo
      }).then(function () { return step(i + 1); });
    }
    return step(0).then(function () {
      syncing = false;
      if (!session) return;
      if (stopped === 'auth') authProblem = true; else if (!stopped) authProblem = false;
      rebuildProducts(); renderBanners(); renderList(); renderCartbar();
      if (view.tab === 'hoy') renderHoy();
      if (sent) {
        toast(plural(sent, 'venta pendiente enviada', 'ventas pendientes enviadas'), 'ok');
        loadCatalog(false); todaySales = null; if (view.tab === 'hoy') loadToday();
      } else if (manual && stopped === 'network') {
        toast('Todavía no hay conexión. Se intentará otra vez.', 'bad');
      }
      if (shortage) shortageNotice();
    });
  }

  /* ------------------------------------------------------------------
     HOY
     ------------------------------------------------------------------ */
  function dayKeyNow() { var d = new Date(); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  function loadToday() {
    if (!api || !session) return Promise.resolve();
    if (todayLoading) { todayDirty = true; return Promise.resolve(); }   // hay una carga en curso: se repite al terminar
    todayLoading = true; todayDirty = false; todayKey = dayKeyNow();
    renderHoy();
    return api.listSales(M.dayRange(0)).then(function (list) {
      if (!todayDirty) { todaySales = list; todayError = ''; }
    }, function (e) {
      if (!todayDirty) todayError = e && e.code === 'network' ? 'Sin conexión: no se pueden ver las ventas ya enviadas.' : M.errorText(e);
    }).then(function () {
      todayLoading = false;
      if (!session) return;
      if (todayDirty) { todayDirty = false; loadToday(); return; }
      renderHoy();
    });
  }

  function itemsText(items) {
    return items.map(function (i) { return i.qty + ' × ' + i.name; }).join(', ');
  }
  function localToSale(q) {
    return { id: q.id, local: true, state: q.state, error: q.error, soldAt: q.soldAt, total: q.total, items: q.items,
             payments: M.normPayments(q), voidedAt: null, hasShortage: false };
  }

  function openCierre(all) {
    var pend = all.filter(function (s) { return s.local && s.state === 'pending'; }).length;
    var prob = all.filter(function (s) { return s.state === 'problem'; }).length;
    var note = '';
    if (pend) note += 'Incluye ' + plural(pend, 'venta pendiente de enviar', 'ventas pendientes de enviar') + ' (se enviarán al volver el internet). ';
    if (prob) note += plural(prob, 'venta con problema no está', 'ventas con problema no están') + ' incluida.';
    var list = all.filter(function (s) { return s.state !== 'problem'; });
    var now = new Date();
    var label = now.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    var day = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
    var rng = M.dayRange(0);
    // El cuadre de caja lo calcula el servidor con las ventas ya enviadas: si hay ventas sin enviar, se espera.
    var unsent = all.filter(function (s) { return s.local; }).length;
    Cierre.open({
      sales: list, settings: settings, label: label, note: note.trim(), fileDate: day,
      cuadre: { api: api, day: day, from: rng.from, to: rng.to, pending: unsent, seller: session ? session.name : '' }
    });
  }

  function renderHoy() {
    if (!ui.hoyBody) return;
    var b = UI.clear(ui.hoyBody);
    var server = todaySales || [];
    var seen = {}; server.forEach(function (s) { seen[s.id] = true; });
    var locals = queue.filter(function (q) { return !seen[q.id]; }).map(localToSale);
    var all = server.concat(locals).sort(function (a, c) { return new Date(c.soldAt) - new Date(a.soldAt); });

    // cifras: no cuentan las anuladas ni las que tienen problema
    var counted = all.filter(function (s) { return !s.voidedAt && s.state !== 'problem'; });
    var total = 0, returned = 0, by = M.netTotals(counted);
    counted.forEach(function (s) { total += s.total; returned += M.returnedValue(s); });
    total = round2(total); returned = round2(returned);

    var stats = el('div', 'stats');
    var tiles = [['Ventas', String(counted.length)], [returned > 0 ? 'Vendido (sin lo devuelto)' : 'Total vendido', fmt(round2(total - returned))]];
    if (returned > 0) tiles.push(['Devuelto', fmt(returned)]);
    tiles.forEach(function (t) {
      var s = el('div', 'stat'); s.appendChild(el('div', 'stat-label', t[0])); s.appendChild(el('div', 'stat-value num', t[1])); stats.appendChild(s);
    });
    b.appendChild(stats);

    var payCard = el('div', 'card paycard');
    payCard.appendChild(el('h2', 'section-title', returned > 0 ? 'En caja por forma de pago (ya sin lo devuelto)' : 'Cobrado por forma de pago'));
    M.PAY_METHODS.forEach(function (m) {
      var r = el('div', 'payrow' + (by[m.id].amt ? '' : ' zero'));
      r.appendChild(el('span', null, m.label));
      r.appendChild(el('span', 'num', curMoney(round2(by[m.id].amt), m.cur)));
      payCard.appendChild(r);
    });
    var nx = all.filter(function (s) { return s.state === 'problem'; }).length;
    if (nx) payCard.appendChild(el('p', 'hint', plural(nx, 'venta con problema no está', 'ventas con problema no están') + ' en estas cifras.'));
    b.appendChild(payCard);

    var cz = el('button', 'btn btn-block btn-cierre', 'Cierre del día'); cz.type = 'button';
    cz.disabled = !counted.length && !all.some(function (s) { return s.voidedAt; });
    cz.addEventListener('click', function () { openCierre(all); });
    b.appendChild(cz);

    if (todayError) b.appendChild(el('p', 'callout', todayError));
    if (todayLoading && todaySales == null) {
      var sp = el('div', 'center-note'); sp.appendChild(el('div', 'spinner')); sp.appendChild(el('p', null, 'Cargando ventas…')); b.appendChild(sp);
      return;
    }

    b.appendChild(el('h2', 'section-title list-title', 'Ventas de hoy'));
    if (!all.length) { b.appendChild(el('p', 'empty', 'Todavía no hay ventas hoy.')); return; }
    var ul = el('ul', 'salelist');
    all.forEach(function (s) { ul.appendChild(saleCard(s)); });
    b.appendChild(ul);
  }

  function openReturn(s) {
    Devolucion.open({
      api: api, sale: s, settings: settings,
      onDone: function (res, info) {
        todaySales = null; loadToday(); loadCatalog(false);
        if (info.mode === 'exchange') {
          // el valor de lo devuelto queda como crédito para la venta nueva (solo informativo: no lo guarda la base de datos)
          credit = round2(credit + info.total); saveDraft(); renderCartbar();
          toast('Cambio registrado. Elige el producto nuevo: ya hay ' + fmt(credit) + ' de crédito.', 'ok');
          showTab('vender');
        } else {
          toast(res && res.duplicate ? 'Esa devolución ya estaba registrada.' : 'Devolución registrada.', 'ok');
        }
      }
    });
  }

  function saleCard(s) {
    var li = el('li', 'sale' + (s.voidedAt ? ' void' : '') + (s.state === 'problem' ? ' problem' : ''));
    var head = el('div', 'sale-head');
    head.appendChild(el('span', 'sale-time num', M.fmtTime(s.soldAt)));
    var badges = el('span', 'sale-badges');
    if (s.local && s.state === 'pending') badges.appendChild(el('span', 'badge badge-warn', 'Pendiente'));
    if (s.state === 'problem') badges.appendChild(el('span', 'badge badge-bad', 'Problema'));
    if (s.hasShortage) badges.appendChild(el('span', 'badge badge-warn', 'Faltante'));
    if (s.voidedAt) badges.appendChild(el('span', 'badge', 'Anulada'));
    head.appendChild(badges);
    head.appendChild(el('span', 'sale-total num', fmt(s.total)));
    li.appendChild(head);
    li.appendChild(el('p', 'sale-items', itemsText(s.items)));
    var pl = payLine(s);
    if (pl) li.appendChild(el('p', 'sale-pay muted num', pl));
    if (s.note && !s.local) li.appendChild(el('p', 'sale-note muted', 'Nota: ' + s.note));
    (s.returns || []).forEach(function (r) {
      var what = r.items.map(function (i) { return i.qty + ' × ' + i.name; }).join(', ');
      var line = (r.mode === 'exchange' ? 'Cambio' : 'Devolución') + ' ' + M.fmtTime(r.at) + ': ' + what + ' · ' + fmt(r.total);
      if (r.mode !== 'exchange') { var rl = M.payLine({ payments: r.refund }); if (rl) line += ' · devuelto ' + rl; }
      if (!r.restock) line += ' · dañado';
      li.appendChild(el('p', 'sale-ret num', line));
    });
    if (s.state === 'problem') li.appendChild(el('p', 'err', s.error || 'No se pudo enviar.'));

    var acts = el('div', 'sale-actions');
    if (s.local) {
      if (s.state === 'problem') {
        var retry = el('button', 'btn btn-sm', 'Reintentar'); retry.type = 'button';
        retry.addEventListener('click', function () {
          for (var i = 0; i < queue.length; i++) if (queue[i].id === s.id) { queue[i].state = 'pending'; queue[i].error = ''; }
          saveQueue(); rebuildProducts(); renderBanners(); renderList(); renderHoy(); sync(true);
        });
        acts.appendChild(retry);
      }
      var drop = el('button', 'btn btn-sm btn-danger', 'Descartar'); drop.type = 'button';
      UI.armConfirm(drop, 'Toca otra vez para descartar', function () {
        queue = queue.filter(function (x) { return x.id !== s.id; });
        saveQueue(); rebuildProducts(); renderBanners(); renderList(); renderHoy();
        toast('Venta descartada.');
      });
      acts.appendChild(drop);
    } else if (!s.voidedAt) {
      var canReturn = (s.items || []).some(function (i) { return i.id != null && M.returnable(i) > 0; });
      if (canReturn) {
        var rb = el('button', 'btn btn-sm', 'Devolver o cambiar'); rb.type = 'button';
        rb.addEventListener('click', function () { openReturn(s); });
        acts.appendChild(rb);
      }
      var vb = el('button', 'btn btn-sm btn-danger', 'Anular'); vb.type = 'button';
      UI.armConfirm(vb, 'Toca otra vez para anular', function () {
        vb.disabled = true;
        api.voidSale(s.id, '').then(function () {
          toast('Venta anulada. Lo vendido volvió a la tienda.', 'ok');
          todaySales = null; loadToday(); loadCatalog(false);
        }, function (e) { vb.disabled = false; toast(M.errorText(e), 'bad'); });
      });
      acts.appendChild(vb);
    }
    if (acts.children.length) li.appendChild(acts);
    return li;
  }

  /* ------------------------------------------------------------------
     Catálogo
     ------------------------------------------------------------------ */
  function applyCatalog(c, cached) {
    settings = { currency: '$', baseCurrency: '', mnPerUsd: 0 };
    for (var k in (c.settings || {})) settings[k] = c.settings[k];
    categories = c.categories || [];
    rawProducts = c.products || [];
    fromCache = !!cached;
    fetchedAt = c.fetchedAt || Date.now();
    catalogLoaded = true; catalogError = '';
    // quita del ticket lo que ya no existe
    var ids = {}; rawProducts.forEach(function (p) { ids[p.id] = true; });
    var before = order.length;
    order = order.filter(function (id) { return ids[id]; });
    Object.keys(ticket).forEach(function (id) { if (!ids[id]) delete ticket[id]; });
    if (order.length !== before) saveDraft();
    rebuildProducts();
  }

  function loadCatalog(manual) {
    if (loadingCatalog) return Promise.resolve();
    loadingCatalog = true;
    return api.loadCatalog().then(function (c) {
      if (!c.fromCache) M.store.set(key('catalog'), { at: Date.now(), settings: c.settings, categories: c.categories, products: c.products });
      applyCatalog(c, c.fromCache);
    }, function (e) {
      var code = e && e.code;
      if (code === 'auth') { authProblem = true; }
      if (code === 'network' || code === 'auth') {
        if (catalogLoaded) { fromCache = true; }
        else {
          var saved = M.store.get(key('catalog'));
          if (saved && Array.isArray(saved.products)) applyCatalog({ settings: saved.settings, categories: saved.categories, products: saved.products, fetchedAt: saved.at }, true);
          else catalogError = 'No hay conexión y todavía no hay productos guardados en este teléfono. Conéctate una vez para descargarlos.';
        }
      } else {
        if (!catalogLoaded) catalogError = M.errorText(e);
        else if (manual) toast(M.errorText(e), 'bad');
      }
    }).then(function () {
      loadingCatalog = false;
      if (!session) return;
      var sig = JSON.stringify([fromCache, catalogError, products.map(function (p) { return [p.id, p.name, p.price, p.store, p.warehouse, p.cat]; }), categories.map(function (c) { return c.id + c.name; })]);
      renderBanners();
      if (sig !== catalogSig) { catalogSig = sig; renderChips(); renderList(); }
      renderCartbar();
      if (sheet) sheet.refresh();
    });
  }

  function refreshAll(manual) {
    var p = [loadCatalog(manual)];
    if (view.tab === 'hoy' || manual) p.push(loadToday());
    p.push(sync());
    return Promise.all(p).then(function () { if (manual && !fromCache) toast('Actualizado', 'ok'); });
  }

  /* ------------------------------------------------------------------
     Salir, temporizador y ciclo de vida
     ------------------------------------------------------------------ */
  function requestSignOut() {
    var n = queue.length;
    if (!n) { gate.signOut(); return; }
    var box = el('div');
    box.appendChild(el('p', null, 'Tienes ' + plural(n, 'venta sin enviar', 'ventas sin enviar') + '. No se pierden: quedan guardadas en este teléfono y se enviarán cuando vuelvas a entrar con tu cuenta y haya conexión.'));
    var stay = el('button', 'btn btn-primary btn-block', 'Seguir aquí'); stay.type = 'button';
    stay.addEventListener('click', function () { UI.modal.close(); });
    var leave = el('button', 'btn btn-block btn-danger', 'Salir de todos modos'); leave.type = 'button';
    leave.classList.add('btn-gap');
    leave.addEventListener('click', function () { UI.modal.close(); gate.signOut(); });
    box.appendChild(stay); box.appendChild(leave);
    UI.modal.open('¿Salir?', box);
  }

  function tick() {
    if (pendingList().length) sync();
    if (document.visibilityState === 'hidden' || sheet || UI.modal.isOpen()) return;
    loadCatalog(false);
    if (view.tab === 'hoy') loadToday();
  }
  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    if (todayKey && todayKey !== dayKeyNow()) { todaySales = null; }
    refreshAll(false);
  }
  function onOnline() { sync(); loadCatalog(false); }

  function teardown() {
    clearInterval(pollTimer); pollTimer = null;
    if (offOnline) { offOnline(); offOnline = null; }
    document.removeEventListener('visibilitychange', onVisible);
    if (sheet) { var s = sheet; sheet = null; try { s.close(); } catch (e) {} }
    var stale = document.querySelector('.sheet'); if (stale) stale.remove();
    document.body.style.overflow = '';
    session = null; catalogLoaded = false; catalogSig = ''; rawProducts = []; products = []; byId = {}; categories = [];
    todaySales = null; ticket = {}; order = []; queue = []; fromCache = false; authProblem = false; catalogError = '';
    view = { tab: 'vender', cat: 'all', q: '' };
    ui = {};
  }

  function onReady(s) {
    session = s;
    loadQueue(); loadDraft();
    buildShell();
    showTab('vender');
    renderBanners(); renderChips(); renderList(); renderCartbar();
    if (s.offline) fromCache = true;
    refreshAll(false).then(function () { sync(); });
    pollTimer = setInterval(tick, POLL_MS);
    offOnline = M.onOnline(onOnline);
    document.addEventListener('visibilitychange', onVisible);
  }

  function fatal(e) {
    UI.clear(root);
    var box = el('main', 'login'), card = el('div', 'login-card');
    card.appendChild(el('p', 'center-note', M.errorText(e)));
    box.appendChild(card); root.appendChild(box);
  }

  /* ------------------------------------------------------------------
     Inicio
     ------------------------------------------------------------------ */
  M.open({ staff: true, app: 'ventas' }).then(function (a) {
    api = a;
    UI.registerSW();
    gate = UI.authGate({
      root: root, api: api, title: 'Ventas', allow: ['worker', 'owner', 'assistant'],
      onReady: onReady, onSignedOut: teardown
    });
  }, fatal);
})();
