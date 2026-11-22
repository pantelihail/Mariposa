/* =====================================================================
   MARIPOSA · Cierre del día
   Un resumen de todo lo vendido en un día: total, devoluciones, lo cobrado
   por forma de pago, cada producto vendido y la lista de ventas. Se puede
   compartir por WhatsApp, copiar, imprimir (o guardar como PDF) y bajar en CSV.

   Lo usan Ventas (el trabajador) y Almacén (la dueña):
   - La dueña además ve la ganancia, el cuadre de caja que dejó el trabajador
     y los productos por reponer (opts.owner = true).
   - El trabajador cuenta la caja al final (opts.cuadre) y nunca ve costos.

   Todo texto de la base de datos se escribe con textContent.
   Sin ?. ni ?? (teléfonos viejos).
   ===================================================================== */
(function (global) {
  'use strict';

  var M = global.Mariposa;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function toast(msg, kind) { if (global.UI && global.UI.toast) global.UI.toast(msg, kind); }
  function parseDecimal(s) {
    s = String(s == null ? '' : s).replace(/\s/g, '');
    if (!/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return null;
    return Number(s.replace(',', '.'));
  }

  /* ------------------------------ cálculo ------------------------------ */
  // Las ventas anuladas no cuentan: se listan aparte. Lo devuelto se resta.
  function summarize(sales) {
    var valid = [], voided = [], units = 0, gross = 0, returned = 0, byProd = {}, order = [], returns = [];
    (sales || []).forEach(function (s) { (s.voidedAt ? voided : valid).push(s); });
    valid.sort(function (a, b) { return new Date(a.soldAt) - new Date(b.soldAt); });
    voided.sort(function (a, b) { return new Date(a.soldAt) - new Date(b.soldAt); });
    valid.forEach(function (s) {
      gross += s.total;
      (s.items || []).forEach(function (i) {
        var net = i.qty - (i.returned || 0);
        units += net;
        if (net <= 0) return;
        var key = i.productId || (i.name + '|' + i.code);
        if (!byProd[key]) { byProd[key] = { name: i.name, code: i.code || '', qty: 0, amount: 0 }; order.push(key); }
        byProd[key].qty += net;
        byProd[key].amount = round2(byProd[key].amount + net * i.unitPrice);
      });
      (s.returns || []).forEach(function (r) { returned += Number(r.total) || 0; returns.push({ sale: s, ret: r }); });
    });
    returns.sort(function (a, b) { return new Date(a.ret.at) - new Date(b.ret.at); });
    var items = order.map(function (k) { return byProd[k]; });
    items.sort(function (a, b) { return b.amount - a.amount || a.name.localeCompare(b.name); });
    gross = round2(gross); returned = round2(returned);
    return { valid: valid, voided: voided, count: valid.length, units: units, gross: gross, returned: returned, total: round2(gross - returned),
             pay: M.netTotals(valid), refund: M.refundTotals(valid), returns: returns, items: items };
  }

  function fmtMoney(n, settings) { return M.money(n, settings && settings.currency); }
  function payAmt(n, cur) { return M.money(n) + ' ' + cur; }
  function curOf(methodId) { var m = M.payMethod(methodId); return m ? m.cur : ''; }

  // "Cuadra", "Sobran 200.00 MN" o "Faltan 200.00 MN".
  function diffText(counted, expected, cur) {
    var d = round2(counted - expected);
    if (d === 0) return 'Cuadra';
    return (d > 0 ? 'Sobran ' : 'Faltan ') + payAmt(Math.abs(d), cur);
  }
  function retLine(x) {
    var r = x.ret, names = r.items.map(function (i) { return i.qty + ' × ' + i.name; }).join(', ');
    var how = r.mode === 'exchange' ? 'cambio por otro producto' : (r.refund && r.refund.length ? 'devuelto ' + M.payLine({ payments: r.refund }).replace(/ · /g, ' ') : 'devolución sin dinero');
    return { names: names, how: how, reason: r.reason || '' };
  }
  function countHead(c, withDate) { return (withDate ? M.fmtDateTime(c.at) : M.fmtTime(c.at)) + (c.seller ? ' · ' + c.seller : ''); }
  // ¿Algún renglón del cuadre no cuadra? (la dueña lo ve resaltado)
  function countOff(c) {
    var off = [];
    M.PAY_METHODS.forEach(function (m) {
      if (c.counted[m.id] == null) return;
      if (round2(c.counted[m.id] - (c.expected[m.id] || 0)) !== 0) off.push(m.label + ': ' + diffText(c.counted[m.id], c.expected[m.id] || 0, m.cur).toLowerCase());
    });
    return off;
  }
  function countBox(c, withDate) {
    var box = el('div', 'cz-rows cz-count');
    box.appendChild(el('p', 'cz-counthead', countHead(c, withDate) + (c.note ? ' — ' + c.note : '')));
    M.PAY_METHODS.forEach(function (m) {
      if (c.counted[m.id] == null) return;
      var exp = c.expected[m.id] || 0, d = round2(c.counted[m.id] - exp);
      box.appendChild(row(m.label, 'Debía haber ' + payAmt(exp, m.cur) + ' · contó ' + payAmt(c.counted[m.id], m.cur),
                          diffText(c.counted[m.id], exp, m.cur), d === 0 ? 'cz-ok' : 'cz-diff'));
    });
    return box;
  }

  /* ------------------------------ texto ------------------------------ */
  // extra: { owner, profit, counts, restock }
  function text(sum, settings, label, extra) {
    extra = extra || {};
    var L = [];
    L.push('CIERRE DEL DÍA · ' + ((settings && settings.name) || 'Mariposa'));
    L.push(label);
    L.push('');
    L.push('Ventas: ' + sum.count + ' · Unidades: ' + sum.units);
    if (sum.returned > 0) {
      L.push('Vendido: ' + fmtMoney(sum.gross, settings));
      L.push('Devuelto: −' + fmtMoney(sum.returned, settings));
    }
    L.push('TOTAL VENDIDO: ' + fmtMoney(sum.total, settings));
    L.push('');
    L.push('COBRADO' + (sum.returned > 0 ? ' (menos lo devuelto)' : ''));
    M.PAY_METHODS.forEach(function (m) {
      L.push('• ' + m.label + ': ' + payAmt(sum.pay[m.id].amt, m.cur) + ' (' + plural(sum.pay[m.id].n, 'venta', 'ventas') + ')');
    });
    if (sum.returns.length) {
      L.push('');
      L.push('DEVOLUCIONES Y CAMBIOS');
      sum.returns.forEach(function (x) {
        var d = retLine(x);
        L.push('• ' + M.fmtTime(x.ret.at) + ' · ' + d.names + ' — ' + d.how + (d.reason ? ' — ' + d.reason : ''));
      });
    }
    if (sum.items.length) {
      L.push('');
      L.push('LO VENDIDO');
      sum.items.forEach(function (i) { L.push('• ' + i.qty + ' × ' + i.name + ' — ' + fmtMoney(i.amount, settings)); });
    }
    if (extra.owner && extra.profit) {
      var p = extra.profit;
      L.push('');
      L.push('GANANCIA');
      L.push('• Costo de lo vendido: ' + fmtMoney(p.cost, settings));
      L.push('• Ganancia: ' + fmtMoney(p.profit, settings) + (p.revenueKnown > 0 ? ' (' + Math.round(100 * p.profit / p.revenueKnown) + '% de lo vendido)' : ''));
      if (!p.complete) L.push('• ' + plural(p.unknownUnits, 'unidad sin costo no cuenta', 'unidades sin costo no cuentan') + ' en la ganancia.');
    }
    if (extra.counts && extra.counts.length) {
      L.push('');
      L.push('CUADRE DE CAJA');
      extra.counts.forEach(function (c) {
        L.push(countHead(c) + (c.note ? ' — ' + c.note : ''));
        M.PAY_METHODS.forEach(function (m) {
          if (c.counted[m.id] == null) return;
          L.push('• ' + m.label + ': debía haber ' + payAmt(c.expected[m.id] || 0, m.cur) + ' · contó ' + payAmt(c.counted[m.id], m.cur) + ' · ' + diffText(c.counted[m.id], c.expected[m.id] || 0, m.cur));
        });
      });
    }
    if (sum.voided.length) {
      L.push('');
      L.push('Anuladas (no cuentan): ' + sum.voided.length);
    }
    if (extra.owner && extra.restock && extra.restock.length) {
      L.push('');
      L.push('POR REPONER');
      extra.restock.forEach(function (r) {
        L.push('• ' + r.name + ' — ' + (r.total === 0 ? 'agotado' : 'tienda ' + r.store + ', almacén ' + r.warehouse));
      });
    }
    return L.join('\n');
  }

  /* ------------------------------ CSV ------------------------------ */
  function csvRows(sum, extra) {
    extra = extra || {};
    var head = ['Fecha', 'Hora', 'Vendedor', 'Producto', 'Código', 'Cantidad', 'Devueltas', 'Precio', 'Importe',
                'Efectivo MN', 'Efectivo USD', 'Transferencia (MN)', 'Estado'];
    if (extra.owner) head.push('Costo unitario', 'Ganancia');
    var rows = [head];
    function add(s, estado) {
      var pays = {};
      M.normPayments(s).forEach(function (p) { pays[p.method] = p.amount; });
      (s.items || []).forEach(function (i, idx) {
        var net = i.qty - (i.returned || 0);
        var row = [M.fmtDate(s.soldAt), M.fmtTime(s.soldAt), s.seller || '', i.name, i.code || '', i.qty, i.returned || 0,
                   i.unitPrice.toFixed(2), round2(net * i.unitPrice).toFixed(2),
                   idx === 0 && pays.cash_mn ? pays.cash_mn.toFixed(2) : '',
                   idx === 0 && pays.cash_usd ? pays.cash_usd.toFixed(2) : '',
                   idx === 0 && pays.transfer ? pays.transfer.toFixed(2) : '', estado];
        if (extra.owner) {
          row.push(i.unitCost == null ? '' : Number(i.unitCost).toFixed(2),
                   i.unitCost == null || estado !== 'Válida' ? '' : round2(net * i.unitPrice - (i.qty - (i.restocked || 0)) * i.unitCost).toFixed(2));
        }
        rows.push(row);
      });
    }
    sum.valid.forEach(function (s) { add(s, 'Válida'); });
    sum.voided.forEach(function (s) { add(s, 'Anulada'); });
    return rows;
  }

  /* ------------------------------ copiar ------------------------------ */
  function copyText(t) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  /* ------------------------------ pantalla ------------------------------ */
  function section(title) { return el('h3', 'cz-h', title); }
  function row(name, sub, amt, cls) {
    var r = el('div', 'cz-row' + (cls ? ' ' + cls : ''));
    var l = el('div', 'cz-l');
    l.appendChild(el('span', 'cz-name', name));
    if (sub) l.appendChild(el('span', 'cz-sub', sub));
    r.appendChild(l);
    if (amt != null) r.appendChild(el('span', 'cz-amt num', amt));
    return r;
  }

  function buildDoc(sum, settings, label, note, extra) {
    var doc = el('div', 'cz-doc');
    doc.appendChild(el('p', 'cz-store', (settings && settings.name) || 'Mariposa'));
    doc.appendChild(el('h2', 'cz-title', 'Cierre del día'));
    doc.appendChild(el('p', 'cz-date', label));
    doc.appendChild(el('p', 'cz-gen', 'Generado a las ' + M.fmtTime(new Date().toISOString())));
    if (note) doc.appendChild(el('p', 'cz-note', note));

    var big = el('div', 'cz-big');
    var t = el('div', 'cz-bigitem');
    t.appendChild(el('span', 'cz-biglabel', 'Total vendido'));
    t.appendChild(el('span', 'cz-bigval num', fmtMoney(sum.total, settings)));
    if (sum.returned > 0) t.appendChild(el('span', 'cz-bigsub', 'Vendido ' + fmtMoney(sum.gross, settings) + ' − devuelto ' + fmtMoney(sum.returned, settings)));
    big.appendChild(t);
    var c = el('div', 'cz-bigitem cz-small');
    c.appendChild(el('span', 'cz-biglabel', 'Ventas'));
    c.appendChild(el('span', 'cz-bigval num', String(sum.count)));
    big.appendChild(c);
    var u = el('div', 'cz-bigitem cz-small');
    u.appendChild(el('span', 'cz-biglabel', 'Unidades'));
    u.appendChild(el('span', 'cz-bigval num', String(sum.units)));
    big.appendChild(u);
    doc.appendChild(big);

    doc.appendChild(section(sum.returned > 0 ? 'Cobrado por forma de pago (menos lo devuelto)' : 'Cobrado por forma de pago'));
    var pt = el('div', 'cz-rows');
    M.PAY_METHODS.forEach(function (m) {
      var back = sum.refund[m.id].amt;
      pt.appendChild(row(m.label, plural(sum.pay[m.id].n, 'venta', 'ventas') + (back > 0 ? ' · devuelto ' + payAmt(back, m.cur) : ''), payAmt(sum.pay[m.id].amt, m.cur)));
    });
    doc.appendChild(pt);

    if (sum.returns.length) {
      doc.appendChild(section('Devoluciones y cambios'));
      var rs = el('div', 'cz-rows');
      sum.returns.forEach(function (x) {
        var d = retLine(x);
        var r = row(M.fmtTime(x.ret.at) + (x.ret.seller ? ' · ' + x.ret.seller : ''),
                    d.names + ' — ' + d.how + (x.ret.restock ? '' : ' (no vuelve a la tienda)') + (d.reason ? ' — ' + d.reason : ''),
                    '−' + fmtMoney(x.ret.total, settings), 'cz-ret');
        rs.appendChild(r);
      });
      doc.appendChild(rs);
    }

    doc.appendChild(section('Lo vendido'));
    if (!sum.items.length) {
      doc.appendChild(el('p', 'cz-empty', sum.count ? 'Todo lo vendido fue devuelto.' : 'No hubo ventas.'));
    } else {
      var it = el('div', 'cz-rows');
      sum.items.forEach(function (i) {
        it.appendChild(row(i.name, (i.code ? i.code + ' · ' : '') + i.qty + (i.qty === 1 ? ' unidad' : ' unidades'), fmtMoney(i.amount, settings)));
      });
      var tr = el('div', 'cz-row cz-total');
      tr.appendChild(el('span', 'cz-name', 'Total'));
      tr.appendChild(el('span', 'cz-amt num', fmtMoney(sum.total, settings)));
      it.appendChild(tr);
      doc.appendChild(it);
    }

    if (extra.owner && extra.profit) {
      var p = extra.profit;
      doc.appendChild(section('Ganancia (solo la ves tú)'));
      var gp = el('div', 'cz-rows');
      gp.appendChild(row('Costo de lo vendido', null, fmtMoney(p.cost, settings)));
      gp.appendChild(row('Ganancia', p.revenueKnown > 0 ? Math.round(100 * p.profit / p.revenueKnown) + '% de lo vendido con costo' : null, fmtMoney(p.profit, settings), 'cz-total'));
      doc.appendChild(gp);
      if (!p.complete) {
        doc.appendChild(el('p', 'cz-note', plural(p.unknownUnits, 'unidad vendida no tiene', 'unidades vendidas no tienen') + ' costo y no ' + (p.unknownUnits === 1 ? 'cuenta' : 'cuentan') +
          ' en la ganancia. Ponle el costo al producto en Editar y se verá en las ventas nuevas.'));
      }
    }

    if (sum.valid.length) {
      doc.appendChild(section('Ventas del día'));
      var ls = el('div', 'cz-rows');
      sum.valid.forEach(function (s) {
        var r = el('div', 'cz-row cz-sale');
        var l = el('div', 'cz-l');
        var head = el('span', 'cz-name');
        head.appendChild(document.createTextNode(M.fmtTime(s.soldAt) + (s.seller ? ' · ' + s.seller : '')));
        if (s.state === 'pending') head.appendChild(el('span', 'cz-tag', 'Pendiente de enviar'));
        if (s.hasShortage) head.appendChild(el('span', 'cz-tag cz-warn', 'Con faltante'));
        if ((s.returns || []).length) head.appendChild(el('span', 'cz-tag', 'Con devolución'));
        l.appendChild(head);
        l.appendChild(el('span', 'cz-sub', (s.items || []).map(function (i) { return i.qty + ' × ' + i.name; }).join(', ')));
        var pl = M.payLine(s);
        l.appendChild(el('span', 'cz-sub', pl || 'Sin forma de pago'));
        r.appendChild(l);
        r.appendChild(el('span', 'cz-amt num', fmtMoney(s.total, settings)));
        ls.appendChild(r);
      });
      doc.appendChild(ls);
    }

    if (sum.voided.length) {
      doc.appendChild(section('Anuladas (no cuentan en el total)'));
      var vs = el('div', 'cz-rows');
      sum.voided.forEach(function (s) {
        var r = el('div', 'cz-row cz-void');
        var l = el('div', 'cz-l');
        l.appendChild(el('span', 'cz-name', M.fmtTime(s.soldAt) + (s.seller ? ' · ' + s.seller : '')));
        l.appendChild(el('span', 'cz-sub', (s.items || []).map(function (i) { return i.qty + ' × ' + i.name; }).join(', ') + (s.voidReason ? ' — ' + s.voidReason : '')));
        r.appendChild(l);
        r.appendChild(el('span', 'cz-amt num', fmtMoney(s.total, settings)));
        vs.appendChild(r);
      });
      doc.appendChild(vs);
    }

    // Cuadre de caja guardado (lo que contó el trabajador contra lo que debía haber)
    var counts = extra.counts || [];
    if (counts.length) {
      doc.appendChild(section('Cuadre de caja'));
      counts.forEach(function (c) { doc.appendChild(countBox(c)); });
    } else if (extra.owner && extra.showNoCount) {
      doc.appendChild(section('Cuadre de caja'));
      doc.appendChild(el('p', 'cz-empty', 'El trabajador no hizo el cuadre de caja este día.'));
    }

    if (extra.owner && extra.restock && extra.restock.length) {
      doc.appendChild(section('Por reponer'));
      var rr = el('div', 'cz-rows');
      extra.restock.forEach(function (r) {
        rr.appendChild(row(r.name, (r.code ? r.code + ' · ' : '') + (r.total === 0 ? 'Agotado' : 'En tienda ' + r.store + ' · En almacén ' + r.warehouse), null));
      });
      doc.appendChild(rr);
    }
    return doc;
  }

  /* --------- Cuadre de caja (lo llena el trabajador al cerrar el día) --------- */
  // cu: { api, day, from, to, pending, seller }  ->  onSaved(count)
  function buildCuadre(cu, onSaved) {
    var box = el('section', 'cz-cuadre no-print');
    box.appendChild(el('h3', 'cz-h', 'Cuadre de caja'));
    var body = el('div');
    box.appendChild(body);

    function note(msg, cls) { return el('p', cls || 'cz-empty', msg); }

    if (cu.pending > 0) {
      body.appendChild(note('Hay ' + plural(cu.pending, 'venta sin enviar', 'ventas sin enviar') + '. Cuando vuelva el internet y se envíen, podrás cuadrar la caja.'));
      return box;
    }

    function load() {
      UI_clear(body);
      body.appendChild(note('Calculando lo que debe haber en la caja…'));
      cu.api.cashExpected({ from: cu.from, to: cu.to }).then(function (exp) { form(exp); }, function (e) {
        UI_clear(body);
        body.appendChild(note(M.errorText(M.toError(e)), 'err'));
        var b = el('button', 'btn btn-sm', 'Reintentar'); b.type = 'button'; b.addEventListener('click', load);
        body.appendChild(b);
      });
    }
    function UI_clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

    function form(exp) {
      UI_clear(body);
      body.appendChild(el('p', 'cz-hint', 'Cuenta el dinero que hay y escríbelo. Si no usaste una forma de pago, déjala vacía. Esto no cambia ninguna venta: solo deja constancia.'));
      var inputs = {}, diffs = {};
      var rows = el('div', 'cz-cq-rows');
      M.PAY_METHODS.forEach(function (m) {
        var r = el('div', 'cz-cq');
        r.appendChild(el('span', 'cz-cq-name', m.label));
        r.appendChild(el('span', 'cz-cq-exp muted', 'Debe haber ' + payAmt(exp[m.id] || 0, m.cur)));
        var line = el('div', 'cz-cq-line');
        var inp = el('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off'; inp.maxLength = 14;
        inp.id = 'cq-' + m.id; inp.placeholder = 'Lo que hay'; inp.setAttribute('aria-label', 'Contado en ' + m.label);
        var unit = el('span', 'cz-cq-unit muted', m.cur);
        var df = el('span', 'cz-cq-diff'); df.setAttribute('aria-live', 'polite');
        inp.addEventListener('input', function () {
          var v = parseDecimal(inp.value);
          if (inp.value.trim() === '') { df.textContent = ''; df.className = 'cz-cq-diff'; }
          else if (v === null) { df.textContent = 'Número no válido'; df.className = 'cz-cq-diff bad'; }
          else { df.textContent = diffText(v, exp[m.id] || 0, m.cur); df.className = 'cz-cq-diff ' + (round2(v - (exp[m.id] || 0)) === 0 ? 'ok' : 'warn'); }
        });
        line.appendChild(inp); line.appendChild(unit); r.appendChild(line); r.appendChild(df);
        inputs[m.id] = inp; diffs[m.id] = df;
        rows.appendChild(r);
      });
      body.appendChild(rows);
      var nt = el('input'); nt.type = 'text'; nt.maxLength = 200; nt.placeholder = 'Nota (opcional), por ejemplo: dejé 500 MN de fondo';
      nt.setAttribute('aria-label', 'Nota del cuadre');
      body.appendChild(nt);
      var err = el('p', 'err'); err.hidden = true; err.setAttribute('role', 'alert'); body.appendChild(err);
      var go = el('button', 'btn btn-primary', 'Guardar cuadre'); go.type = 'button';
      go.addEventListener('click', function () {
        err.hidden = true;
        var counted = {}, any = false, bad = false;
        M.PAY_METHODS.forEach(function (m) {
          var t = inputs[m.id].value.trim();
          if (t === '') return;
          var v = parseDecimal(t);
          if (v === null) { bad = true; return; }
          counted[m.id] = v; any = true;
        });
        if (bad) { err.textContent = 'Revisa los montos: usa números, por ejemplo 4000 o 12.50.'; err.hidden = false; return; }
        if (!any) { err.textContent = 'Escribe al menos una cantidad.'; err.hidden = false; return; }
        go.disabled = true; go.textContent = 'Guardando…';
        cu.api.saveCashCount({ id: M.uuid(), day: cu.day, from: cu.from, to: cu.to, counted: counted, note: nt.value.trim() }).then(function (res) {
          var rec = { id: res.id, at: new Date().toISOString(), seller: cu.seller || '', day: cu.day, expected: res.expected, counted: res.counted, note: nt.value.trim() };
          saved(rec);
          if (onSaved) onSaved(rec);
        }, function (e) {
          go.disabled = false; go.textContent = 'Guardar cuadre';
          err.textContent = M.errorText(M.toError(e)); err.hidden = false;
        });
      });
      body.appendChild(go);
    }

    function saved(rec) {
      UI_clear(body);
      var ok = el('div', 'cz-saved');
      ok.appendChild(el('p', 'cz-saved-title', 'Cuadre guardado'));
      M.PAY_METHODS.forEach(function (m) {
        if (rec.counted[m.id] == null) return;
        var exp = rec.expected[m.id] || 0, same = round2(rec.counted[m.id] - exp) === 0;
        var line = el('p', 'cz-saved-line ' + (same ? 'ok' : 'warn'), m.label + ': ' + diffText(rec.counted[m.id], exp, m.cur) + ' (debía haber ' + payAmt(exp, m.cur) + ')');
        ok.appendChild(line);
      });
      ok.appendChild(el('p', 'cz-hint', 'La dueña lo verá junto al cierre del día.'));
      body.appendChild(ok);
      var again = el('button', 'btn btn-sm btn-quiet', 'Contar otra vez'); again.type = 'button';
      again.addEventListener('click', load);
      body.appendChild(again);
    }

    load();
    return box;
  }

  // opts: { sales, settings, label, note, fileDate, owner, counts, restock, showNoCount, cuadre }
  function open(opts) {
    var settings = opts.settings || {};
    var sum = summarize(opts.sales);
    var label = opts.label || '';
    label = label.charAt(0).toUpperCase() + label.slice(1);
    var returnTo = document.activeElement;
    var extra = {
      owner: !!opts.owner,
      profit: opts.owner ? M.profitOf(sum.valid) : null,         // el costo solo existe para la dueña
      counts: (opts.counts || []).slice(),
      restock: opts.owner ? (opts.restock || []) : [],
      showNoCount: !!opts.showNoCount
    };

    var overlay = el('div', 'cz-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Cierre del día');
    var card = el('div', 'cz-card');

    var bar = el('div', 'cz-bar no-print');
    bar.appendChild(el('span', 'cz-bartitle', 'Cierre del día'));
    var x = el('button', 'icon-btn cz-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Cerrar');
    bar.appendChild(x);
    card.appendChild(bar);

    var docHolder = el('div', 'cz-dochold');
    docHolder.appendChild(buildDoc(sum, settings, label, opts.note, extra));
    card.appendChild(docHolder);

    var report = text(sum, settings, label, extra);
    var wa = el('a', 'btn btn-primary', 'Enviar por WhatsApp');
    function setWa() { wa.href = 'https://wa.me/?text=' + encodeURIComponent(report); }
    setWa();
    function refreshDoc() {
      while (docHolder.firstChild) docHolder.removeChild(docHolder.firstChild);
      docHolder.appendChild(buildDoc(sum, settings, label, opts.note, extra));
      report = text(sum, settings, label, extra); setWa();
    }

    if (opts.cuadre) {
      card.appendChild(buildCuadre(opts.cuadre, function (rec) { extra.counts.unshift(rec); refreshDoc(); }));
    }

    var acts = el('div', 'cz-actions no-print');
    wa.target = '_blank'; wa.rel = 'noopener noreferrer';
    var cp = el('button', 'btn', 'Copiar texto'); cp.type = 'button';
    cp.addEventListener('click', function () {
      copyText(report).then(function (ok) { toast(ok ? 'Resumen copiado.' : 'No se pudo copiar. Usa WhatsApp o imprimir.', ok ? 'ok' : 'bad'); });
    });
    var pr = el('button', 'btn', 'Imprimir o guardar PDF'); pr.type = 'button';
    pr.addEventListener('click', function () { if (global.print) global.print(); });
    var cs = el('button', 'btn', 'Descargar CSV'); cs.type = 'button';
    cs.addEventListener('click', function () {
      M.saveText('cierre-' + (opts.fileDate || 'dia') + '.csv', M.csv(csvRows(sum, extra)), 'text/csv;charset=utf-8');
    });
    acts.appendChild(wa); acts.appendChild(cp); acts.appendChild(pr); acts.appendChild(cs);
    card.appendChild(acts);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('cz-open');

    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.classList.remove('cz-open');
      if (returnTo && document.contains(returnTo) && returnTo.focus) returnTo.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    x.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    x.focus();
    return { close: close };
  }

  global.Cierre = { summarize: summarize, text: text, csvRows: csvRows, open: open, copyText: copyText, countBox: countBox, countOff: countOff };
})(window);
