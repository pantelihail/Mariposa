/* =====================================================================
   MARIPOSA · Devolución y cambio de productos de una venta
   Sirve para devolver UNO o varios productos de una venta ya registrada
   (no hace falta anular toda la venta). Lo usan Ventas y Almacén.

   - "Devolver el dinero": se anota cuánto dinero se le devolvió y en qué forma.
   - "Cambiar por otro producto": no se devuelve dinero; el valor de lo devuelto
     queda como crédito para la venta nueva (la app de Ventas lo aplica).
   - El producto vuelve a la tienda, o se marca como dañado (no vuelve).

   Todo texto de la base de datos se escribe con textContent.
   Sin ?. ni ?? (teléfonos viejos).
   ===================================================================== */
(function (global) {
  'use strict';

  var M = global.Mariposa, UI = global.UI, el = UI.el;

  function round2(n) { return Math.round(n * 100) / 100; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function amountText(v) { return v % 1 === 0 ? String(v) : v.toFixed(2); }
  function parseAmount(s) {
    s = String(s || '').replace(/\s/g, '');
    if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
    var v = Number(s.replace(',', '.'));
    return isFinite(v) && v < 1e9 ? v : null;
  }

  // opts: { api, sale, settings, onDone(res, info) }   info = { mode, total }
  function open(opts) {
    var api = opts.api, sale = opts.sale, settings = opts.settings || {};
    var lines = (sale.items || []).filter(function (i) { return i.id != null && M.returnable(i) > 0; });
    var form = el('form'); form.noValidate = true;
    var rid = M.uuid();                    // un mismo id si se reintenta: no se cuenta dos veces
    var qtys = {}, mode = 'refund', touched = false, busy = false;
    function fmt(n) { return M.money(n, settings.currency); }

    form.appendChild(el('p', null, 'Venta de ' + M.fmtTime(sale.soldAt) + ' por ' + fmt(sale.total) + '. Elige qué devuelve el cliente: no hace falta anular toda la venta.'));

    if (!lines.length) {
      form.appendChild(el('p', 'empty', 'De esta venta ya se devolvió todo.'));
      var ok0 = el('button', 'btn btn-primary btn-block', 'Cerrar'); ok0.type = 'button';
      ok0.addEventListener('click', function () { UI.modal.close(); });
      form.appendChild(ok0);
      UI.modal.open('Devolver o cambiar', form);
      return;
    }

    var list = el('div', 'dv-lines');
    var qtyEls = {}, minusEls = {}, plusEls = {};
    lines.forEach(function (i) {
      qtys[i.id] = 0;
      var can = M.returnable(i);
      var row = el('div', 'dv-line');
      var info = el('div', 'dv-info');
      info.appendChild(el('div', 'dv-name', i.name));
      info.appendChild(el('div', 'dv-sub muted num', fmt(i.unitPrice) + ' c/u · vendidas ' + i.qty + (i.returned ? ' · ya devueltas ' + i.returned : '')));
      var step = el('div', 'dv-step');
      var mn = el('button', 'icon-btn', '−'); mn.type = 'button'; mn.setAttribute('aria-label', 'Devolver una menos de ' + i.name);
      var qn = el('span', 'dv-qty num', '0'); qn.setAttribute('aria-live', 'polite');
      var pl = el('button', 'icon-btn', '+'); pl.type = 'button'; pl.setAttribute('aria-label', 'Devolver una más de ' + i.name);
      mn.addEventListener('click', function () { set(i, qtys[i.id] - 1, can); });
      pl.addEventListener('click', function () { set(i, qtys[i.id] + 1, can); });
      step.appendChild(mn); step.appendChild(qn); step.appendChild(pl);
      row.appendChild(info); row.appendChild(step); list.appendChild(row);
      qtyEls[i.id] = qn; minusEls[i.id] = mn; plusEls[i.id] = pl;
    });
    form.appendChild(list);
    var sum = el('p', 'dv-sum'); sum.setAttribute('aria-live', 'polite');
    form.appendChild(sum);

    // qué quiere el cliente
    var modes = el('div', 'dv-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Qué quiere el cliente');
    var bRefund = el('button', 'btn dv-mode', 'Le devuelvo el dinero'); bRefund.type = 'button';
    var bSwap = el('button', 'btn dv-mode', 'Lo cambia por otro producto'); bSwap.type = 'button';
    modes.appendChild(bRefund); modes.appendChild(bSwap);
    form.appendChild(modes);
    var swapHint = el('p', 'hint', 'No se devuelve dinero. Después eliges el producto nuevo en Vender y el valor de lo devuelto se descuenta de la venta nueva.');
    form.appendChild(swapHint);

    // dinero que se devuelve
    var refundBox = el('div');
    var payMethods = M.PAY_METHODS.map(function (m) { return [m.id, m.label + ' (' + m.cur + ')']; });
    var firstPay = M.normPayments(sale)[0];
    var method = UI.select(payMethods, firstPay ? firstPay.method : 'cash_mn');
    var amount = UI.input('text', '', 14); amount.inputMode = 'decimal';
    var fMethod = UI.field('Dinero devuelto en', method);
    var fAmount = UI.field('Cuánto le devuelves', amount, 'Se calcula con el precio de lista y tu tasa; cámbialo si devolviste otra cantidad.');
    var r2 = el('div', 'row2'); r2.appendChild(fMethod); r2.appendChild(fAmount);
    refundBox.appendChild(r2);
    form.appendChild(refundBox);
    amount.addEventListener('input', function () { touched = true; });

    // qué pasa con el producto
    var rs = UI.select([['yes', 'Vuelve a la tienda para venderse'], ['no', 'Está dañado: no vuelve a la tienda']], 'yes');
    form.appendChild(UI.field('El producto devuelto', rs));

    var reason = UI.input('text', '', 200);
    var fReason = UI.field('Motivo (opcional)', reason);
    form.appendChild(fReason);
    var chips = el('div', 'chips reasons');
    ['Se equivocó', 'No le gustó', 'Defectuoso', 'Otro tamaño'].forEach(function (t) {
      var b = el('button', 'chip', t); b.type = 'button';
      b.addEventListener('click', function () { reason.value = t; reason.focus(); });
      chips.appendChild(b);
    });
    form.appendChild(chips);

    var err = el('p', 'err'); err.hidden = true; err.setAttribute('role', 'alert'); form.appendChild(err);
    var actions = el('div', 'actions');
    var cancel = el('button', 'btn btn-quiet', 'Cancelar'); cancel.type = 'button';
    cancel.addEventListener('click', function () { UI.modal.close(); });
    var go = el('button', 'btn btn-primary push', 'Registrar devolución'); go.type = 'submit';
    actions.appendChild(cancel); actions.appendChild(go); form.appendChild(actions);

    function chosenTotal() {
      var t = 0;
      lines.forEach(function (i) { t += qtys[i.id] * i.unitPrice; });
      return round2(t);
    }
    function chosenUnits() { var n = 0; lines.forEach(function (i) { n += qtys[i.id]; }); return n; }
    function suggest() {
      if (touched || mode !== 'refund') return;
      var v = M.suggestPay(chosenTotal(), method.value, settings);
      amount.value = v != null && v > 0 ? amountText(v) : '';
    }
    function draw() {
      var n = chosenUnits(), t = chosenTotal();
      sum.textContent = n ? 'Devuelve ' + plural(n, 'unidad', 'unidades') + ' · valor ' + fmt(t) : 'Toca + en lo que devuelve el cliente.';
      bRefund.setAttribute('aria-pressed', String(mode === 'refund'));
      bSwap.setAttribute('aria-pressed', String(mode === 'exchange'));
      refundBox.hidden = mode !== 'refund';
      swapHint.hidden = mode !== 'exchange';
      go.textContent = mode === 'exchange' ? 'Registrar cambio' : 'Registrar devolución';
    }
    function set(i, q, max) {
      q = Math.max(0, Math.min(max, q));
      qtys[i.id] = q;
      qtyEls[i.id].textContent = String(q);
      minusEls[i.id].disabled = q <= 0; plusEls[i.id].disabled = q >= max;
      err.hidden = true;
      suggest(); draw();
    }
    lines.forEach(function (i) { minusEls[i.id].disabled = true; });
    bRefund.addEventListener('click', function () { mode = 'refund'; suggest(); draw(); });
    bSwap.addEventListener('click', function () { mode = 'exchange'; draw(); });
    method.addEventListener('change', function () { touched = false; suggest(); });
    draw();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      err.hidden = true; fAmount.setError('');
      var items = [];
      lines.forEach(function (i) { if (qtys[i.id] > 0) items.push({ itemId: i.id, qty: qtys[i.id] }); });
      if (!items.length) { err.textContent = 'Elige al menos una unidad que devuelve el cliente.'; err.hidden = false; return; }
      var refund = [];
      if (mode === 'refund') {
        var v = parseAmount(amount.value);
        if (v == null || !(v > 0)) { fAmount.setError('Escribe cuánto dinero le devuelves, por ejemplo 400 o 12.50. Si no le devuelves dinero, elige «Lo cambia por otro producto».'); return; }
        refund = [{ method: method.value, amount: v }];
      }
      busy = true; go.disabled = true; go.textContent = 'Registrando…';
      var total = chosenTotal();
      api.returnItems({ id: rid, saleId: sale.id, items: items, mode: mode, refund: refund, reason: reason.value.trim(), restock: rs.value !== 'no' }).then(function (res) {
        busy = false;
        UI.modal.close();
        if (opts.onDone) opts.onDone(res, { mode: mode, total: res.total != null ? res.total : total });
      }, function (er) {
        busy = false; go.disabled = false; draw();
        var x = M.toError(er);
        err.textContent = M.errorText(x) + (x.code === 'network' ? ' Las devoluciones necesitan internet.' : '');
        err.hidden = false;
      });
    });

    UI.modal.open('Devolver o cambiar', form);
  }

  global.Devolucion = { open: open };
})(window);
