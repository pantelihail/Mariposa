/* =====================================================================
   MARIPOSA · capa de datos compartida por las 3 apps (Tienda, Almacén, Ventas)

   Una sola forma de pedir datos. Detrás hay tres versiones:
     - "public": solo lectura del catálogo, para los clientes (sin librerías, ligera)
     - "live":   con cuenta (dueño / trabajador / asistente), usa Supabase
     - "demo":   datos de ejemplo en el navegador (js/demo.js), para vista previa

   Código escrito sin ?. ni ?? para que funcione también en teléfonos viejos.
   ===================================================================== */
(function (global) {
  'use strict';

  var CFG = global.MARIPOSA_CONFIG || {};
  var Mariposa = { config: CFG };
  global.Mariposa = Mariposa;

  /* ------------------------------------------------------------------
     Errores con códigos fijos y mensajes en español
     ------------------------------------------------------------------ */
  var TEXT = {
    network: 'No hay conexión con internet. Inténtalo otra vez.',
    bad_credentials: 'Correo o contraseña incorrectos.',
    bad_code: 'Ese código no es correcto.',
    rate_limited: 'Demasiados intentos. Espera un momento y vuelve a probar.',
    forbidden: 'Tu cuenta no tiene permiso para hacer esto.',
    insufficient_stock: 'No hay suficientes unidades.',
    note_required: 'Escribe el motivo.',
    invalid_qty: 'La cantidad no es válida.',
    invalid_payment: 'Revisa la forma de pago y el monto.',
    invalid: 'Revisa los datos: hay un valor que no es válido.',
    sale_voided: 'Esa venta está anulada: ya no se puede devolver nada de ella.',
    over_returned: 'No se puede devolver más de lo que se vendió.',
    duplicate: 'Ya existe uno igual (por ejemplo, el código se repite).',
    in_use: 'No se puede borrar: todavía se usa en otro lugar.',
    not_found: 'No se encontró. Actualiza la pantalla e inténtalo otra vez.',
    auth: 'Tu sesión terminó. Entra otra vez.',
    user_not_found: 'No existe una cuenta con ese correo. Primero créala en Supabase (Authentication, Users).',
    already_owner: 'Esa cuenta es la del dueño.',
    invalid_role: 'Ese tipo de acceso no es válido.',
    not_configured: 'Falta conectar la base de datos. Abre el archivo config.js y pega los datos de tu proyecto.',
    no_library: 'No se pudo cargar una parte de la aplicación. Recarga la página.',
    unknown: 'Algo salió mal. Inténtalo otra vez.'
  };
  var SERVER_MESSAGES = {
    insufficient_stock: 'insufficient_stock', note_required: 'note_required', invalid_qty: 'invalid_qty',
    invalid_items: 'invalid', invalid_return: 'invalid', invalid_mode: 'invalid', invalid_period: 'invalid', invalid_counted: 'invalid',
    sale_voided: 'sale_voided', item_not_found: 'not_found', return_id_in_use: 'duplicate', count_id_in_use: 'duplicate',
    invalid_payment: 'invalid_payment', invalid_location: 'invalid', invalid_role: 'invalid_role', invalid_sale_id: 'invalid',
    product_not_found: 'not_found', sale_not_found: 'not_found', sale_id_in_use: 'duplicate',
    user_not_found: 'user_not_found', already_owner: 'already_owner', owner_exists: 'invalid',
    stock_only_via_functions: 'forbidden', forbidden: 'forbidden'
  };

  class MariposaError extends Error {
    constructor(code, message, cause) {
      super(message || TEXT[code] || TEXT.unknown);
      this.name = 'MariposaError';
      this.code = code;
      this.cause = cause;
    }
  }
  Mariposa.Error = MariposaError;

  // Convierte cualquier error (de Supabase, de la red...) en un MariposaError.
  function toErr(e) {
    if (e instanceof MariposaError) return e;
    var msg = String((e && (e.message || e.error_description)) || e || '');
    var code = e && (e.code || e.status);
    var name = (e && e.name) || '';
    if (name === 'AuthRetryableFetchError' || name === 'AbortError' ||
        /failed to fetch|networkerror|load failed|network request failed|fetch failed|timed? ?out|aborted/i.test(msg) ||
        (name === 'TypeError' && /fetch|network/i.test(msg))) return new MariposaError('network', null, e);
    if (SERVER_MESSAGES[msg]) return new MariposaError(SERVER_MESSAGES[msg], null, e);
    for (var k in SERVER_MESSAGES) { if (msg.indexOf(k) !== -1) return new MariposaError(SERVER_MESSAGES[k], null, e); }
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return new MariposaError('bad_credentials', null, e);
    if (code === 'mfa_verification_failed' || /invalid totp|mfa.*(fail|invalid)/i.test(msg)) return new MariposaError('bad_code', null, e);
    if (code === 429 || code === 'over_request_rate_limit' || /rate limit/i.test(msg)) return new MariposaError('rate_limited', null, e);
    if (code === '42501' || /permission denied|row-level security|not allowed/i.test(msg)) return new MariposaError('forbidden', null, e);
    if (code === '23505') return new MariposaError('duplicate', null, e);
    if (code === '23503') return new MariposaError('in_use', null, e);
    if (code === '23514' || code === '22023' || code === '22P02' || code === '22003') return new MariposaError('invalid', null, e);
    if (code === 'PGRST116') return new MariposaError('not_found', null, e);
    if (code === 'PGRST301' || code === 401 || /jwt|refresh token/i.test(msg)) return new MariposaError('auth', null, e);
    return new MariposaError('unknown', null, e);
  }
  Mariposa.toError = toErr;
  Mariposa.errorText = function (e) { return (e && e.code && TEXT[e.code]) ? (e.message || TEXT[e.code]) : TEXT.unknown; };

  /* ------------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------------ */
  Mariposa.isConfigured = function () {
    return !!(CFG.demo || (CFG.supabaseUrl && CFG.supabaseAnonKey && !/TU-PROYECTO|TU_LLAVE/i.test(CFG.supabaseUrl + CFG.supabaseAnonKey)));
  };

  Mariposa.uuid = function () {
    if (global.crypto && global.crypto.randomUUID) { try { return global.crypto.randomUUID(); } catch (e) {} }
    var b = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };

  Mariposa.fold = function (s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  };

  Mariposa.money = function (n, cur) {
    var c = cur == null ? '' : String(cur);
    var v = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!c) return v;
    return c.length <= 2 ? c + v : v + ' ' + c;
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  Mariposa.fmtTime = function (iso) { var d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  Mariposa.fmtDate = function (iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' }).replace(/\./g, '');
  };
  Mariposa.fmtDateTime = function (iso) { return Mariposa.fmtDate(iso) + ', ' + Mariposa.fmtTime(iso); };

  // Inicio y fin de un día local. offset 0 = hoy, -1 = ayer...
  Mariposa.dayRange = function (offset) {
    var a = new Date(); a.setHours(0, 0, 0, 0); a.setDate(a.getDate() + (offset || 0));
    var b = new Date(a); b.setDate(b.getDate() + 1);
    return { from: a.toISOString(), to: b.toISOString() };
  };

  // Almacenamiento local seguro (puede no existir o estar lleno).
  Mariposa.store = {
    get: function (k) { try { var v = global.localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
    set: function (k, v) { try { global.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { global.localStorage.removeItem(k); } catch (e) {} }
  };

  // Código automático del producto: 3 letras de la categoría y un número (COC-001).
  Mariposa.nextCode = function (products, categoryName) {
    var base = Mariposa.fold(categoryName || 'PRD').replace(/[^a-z]/g, '').toUpperCase().slice(0, 3) || 'PRD';
    var max = 0;
    (products || []).forEach(function (p) {
      var m = /^([A-Z]+)-(\d+)$/.exec(p.code || '');
      if (m && m[1] === base) max = Math.max(max, Number(m[2]));
    });
    return base + '-' + String(max + 1).padStart(3, '0');
  };

  // Reduce una foto para que cargue rápido (lado mayor 900 px, JPG).
  Mariposa.shrinkImage = function (file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, (maxSide || 900) / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('blob')); }, 'image/jpeg', quality || 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('img')); };
      img.src = url;
    });
  };

  // CSV que Excel abre bien (con BOM y comillas).
  Mariposa.csv = function (rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (v) {
        var s = v == null ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = "'" + s;           // evita que Excel ejecute fórmulas
        return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  };
  Mariposa.saveText = function (filename, text, type) {
    var blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  Mariposa.loadScript = function (src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new MariposaError('no_library')); };
      document.head.appendChild(s);
    });
  };

  Mariposa.onOnline = function (cb) {
    global.addEventListener('online', cb);
    return function () { global.removeEventListener('online', cb); };
  };

  /* ------------------------------------------------------------------
     Formas de pago: efectivo MN, efectivo USD y transferencia (en MN)
     ------------------------------------------------------------------ */
  Mariposa.PAY_METHODS = [
    { id: 'cash_mn', label: 'Efectivo MN', cur: 'MN' },
    { id: 'cash_usd', label: 'Efectivo USD', cur: 'USD' },
    { id: 'transfer', label: 'Transferencia', cur: 'MN' }
  ];
  Mariposa.payMethod = function (id) {
    return Mariposa.PAY_METHODS.filter(function (m) { return m.id === id; })[0] || null;
  };
  // Cuánto cobrar en la moneda del pago, según la moneda de los precios y la tasa. null si no se puede calcular.
  Mariposa.suggestPay = function (total, methodId, settings) {
    var m = Mariposa.payMethod(methodId);
    if (!m || !settings || !settings.baseCurrency) return null;
    var base = settings.baseCurrency === 'usd' ? 'USD' : 'MN';
    var v;
    if (base === m.cur) v = total;
    else if (!(settings.mnPerUsd > 0)) return null;
    else v = base === 'USD' ? total * settings.mnPerUsd : total / settings.mnPerUsd;
    return Math.round(v * 100) / 100;
  };
  Mariposa.payText = function (methodId, amount) {
    var m = Mariposa.payMethod(methodId);
    if (!m) return '';
    return m.label + (amount == null ? '' : ' · ' + Mariposa.money(amount) + ' ' + m.cur);
  };
  function round2(n) { return Math.round(n * 100) / 100; }
  // Moneda de los precios de la lista: 'USD', 'MN' o '' (sin definir).
  Mariposa.baseCur = function (settings) {
    var b = settings && settings.baseCurrency;
    return b === 'usd' ? 'USD' : b === 'mn' ? 'MN' : '';
  };
  // Convierte un monto de una moneda de pago (MN/USD) a la moneda de la lista. null si no se puede.
  Mariposa.toBase = function (amount, cur, settings) {
    var base = Mariposa.baseCur(settings);
    if (!base) return null;
    if (base === cur) return amount;
    if (!(settings.mnPerUsd > 0)) return null;
    return base === 'USD' ? amount / settings.mnPerUsd : amount * settings.mnPerUsd;
  };
  // Lista de pagos válidos de una venta [{method, amount}]. Acepta el formato viejo (payMethod/payAmount).
  Mariposa.normPayments = function (sale) {
    var list = sale && Array.isArray(sale.payments) ? sale.payments : (sale && sale.payMethod ? [{ method: sale.payMethod, amount: sale.payAmount }] : []);
    var seen = {}, out = [];
    list.forEach(function (p) {
      var a = Number(p && p.amount);
      if (!p || !Mariposa.payMethod(p.method) || !(a > 0) || seen[p.method]) return;
      seen[p.method] = 1;
      out.push({ method: p.method, amount: round2(a) });
    });
    return out;
  };
  // Cuánto falta por cobrar (positivo) o cuánto hay que devolver (negativo), en la moneda de la lista.
  Mariposa.payStatus = function (total, payments, settings) {
    var base = Mariposa.baseCur(settings), paid = 0, known = !!base;
    (payments || []).forEach(function (p) {
      var m = Mariposa.payMethod(p.method);
      var v = m ? Mariposa.toBase(p.amount, m.cur, settings) : null;
      if (v == null) known = false; else paid += v;
    });
    return { known: known, base: base, paid: round2(paid), left: round2(total - paid) };
  };
  // "Efectivo MN 1,400.00 MN + Efectivo USD 5.00 USD"
  Mariposa.payLine = function (sale) {
    return Mariposa.normPayments(sale).map(function (p) { return Mariposa.payText(p.method, p.amount); }).join(' + ');
  };
  // Totales cobrados por forma de pago (solo ventas no anuladas): { cash_mn: {amt, n}, ... }
  Mariposa.payTotals = function (sales) {
    var t = {};
    Mariposa.PAY_METHODS.forEach(function (m) { t[m.id] = { amt: 0, n: 0 }; });
    (sales || []).forEach(function (x) {
      if (x.voidedAt) return;
      Mariposa.normPayments(x).forEach(function (p) { t[p.method].amt = round2(t[p.method].amt + p.amount); t[p.method].n++; });
    });
    return t;
  };

  /* ------------------------------------------------------------------
     Devoluciones, costo y ganancia (todo en la moneda de la lista de precios)
     ------------------------------------------------------------------ */
  // Valor devuelto de una venta (suma de todas sus devoluciones).
  Mariposa.returnedValue = function (sale) {
    var t = 0;
    ((sale && sale.returns) || []).forEach(function (r) { t += Number(r.total) || 0; });
    return round2(t);
  };
  // Total de la venta menos lo devuelto.
  Mariposa.saleNet = function (sale) { return round2((Number(sale.total) || 0) - Mariposa.returnedValue(sale)); };
  // Unidades que todavía puede devolver el cliente de un renglón.
  Mariposa.returnable = function (item) { return Math.max(0, (item.qty | 0) - (item.returned | 0)); };
  // Dinero devuelto por forma de pago, solo de ventas no anuladas: { cash_mn: {amt, n}, ... }
  Mariposa.refundTotals = function (sales) {
    var t = {};
    Mariposa.PAY_METHODS.forEach(function (m) { t[m.id] = { amt: 0, n: 0 }; });
    (sales || []).forEach(function (x) {
      if (x.voidedAt) return;
      (x.returns || []).forEach(function (r) {
        Mariposa.normPayments({ payments: r.refund }).forEach(function (p) { t[p.method].amt = round2(t[p.method].amt + p.amount); t[p.method].n++; });
      });
    });
    return t;
  };
  // Cobrado menos devuelto, por forma de pago.
  Mariposa.netTotals = function (sales) {
    var c = Mariposa.payTotals(sales), r = Mariposa.refundTotals(sales), t = {};
    Mariposa.PAY_METHODS.forEach(function (m) { t[m.id] = { amt: round2(c[m.id].amt - r[m.id].amt), n: c[m.id].n }; });
    return t;
  };
  // Ganancia de las ventas no anuladas (solo la ve la dueña: el costo no le llega a nadie más).
  // Lo devuelto a la tienda no cuenta como venta ni como costo; lo devuelto dañado sí cuesta.
  Mariposa.profitOf = function (sales) {
    var revKnown = 0, revUnknown = 0, cost = 0, unknownUnits = 0;
    (sales || []).forEach(function (s) {
      if (s.voidedAt) return;
      (s.items || []).forEach(function (i) {
        var rev = ((i.qty | 0) - (i.returned | 0)) * (Number(i.unitPrice) || 0);
        if (i.unitCost == null) { revUnknown += rev; unknownUnits += Math.max(0, (i.qty | 0) - (i.returned | 0)); return; }
        revKnown += rev;
        cost += ((i.qty | 0) - (i.restocked | 0)) * Number(i.unitCost);
      });
    });
    return { revenue: round2(revKnown + revUnknown), revenueKnown: round2(revKnown), cost: round2(cost), profit: round2(revKnown - cost),
             unknownRevenue: round2(revUnknown), unknownUnits: unknownUnits, complete: unknownUnits === 0 };
  };

  /* ------------------------------------------------------------------
     Conversión fila de la base de datos -> objeto de la app
     ------------------------------------------------------------------ */
  function photoBase() { return String(CFG.supabaseUrl || '').replace(/\/+$/, '') + '/storage/v1/object/public/fotos/'; }
  function prodFromRow(r) {
    return {
      id: r.id, code: r.code || '', name: r.name, cat: r.category_id, sub: r.sub || '',
      price: Number(r.price), desc: r.description || '',
      photoPath: r.photo || '', photo: r.photo ? photoBase() + r.photo : '',
      visible: r.visible !== false, store: r.stock_store | 0, warehouse: r.stock_warehouse | 0,
      updatedAt: r.updated_at
    };
  }
  // El público solo recibe la cantidad total (no dónde está): no hay store ni warehouse.
  function prodFromPublic(r) {
    return {
      id: r.id, code: r.code || '', name: r.name, cat: r.category_id, sub: r.sub || '',
      price: Number(r.price), desc: r.description || '',
      photoPath: r.photo || '', photo: r.photo ? photoBase() + r.photo : '',
      visible: true, total: r.stock | 0, updatedAt: r.updated_at
    };
  }
  function catFromRow(r) {
    return { id: r.id, name: r.name, tint: r.tint || 'otros', phrase: r.phrase || '',
             subs: Array.isArray(r.subs) ? r.subs : [], position: r.position | 0 };
  }
  function saleFromRow(r) {
    var items = (r.sale_items || []).slice().sort(function (a, b) { return a.id - b.id; }).map(function (i) {
      // El costo solo llega si quien pregunta es la dueña (la base de datos no se lo da a nadie más).
      var c = Array.isArray(i.sale_item_costs) ? i.sale_item_costs[0] : i.sale_item_costs;
      return { id: i.id, productId: i.product_id, name: i.name, code: i.code || '', qty: i.qty, unitPrice: Number(i.unit_price), deducted: i.deducted | 0,
               returned: i.returned | 0, restocked: i.restocked | 0, unitCost: c && c.unit_cost != null ? Number(c.unit_cost) : null };
    });
    var returns = (r.sale_returns || []).slice().sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); }).map(retFromRow);
    return {
      id: r.id, soldAt: r.sold_at, createdAt: r.created_at, seller: r.seller || '', total: Number(r.total),
      note: r.note || '', hasShortage: !!r.has_shortage, voidedAt: r.voided_at || null, voidReason: r.void_reason || '', items: items,
      payments: Mariposa.normPayments({ payments: Array.isArray(r.payments) ? r.payments : [] }), returns: returns
    };
  }
  function retFromRow(r) {
    return {
      id: r.id, at: r.created_at, saleId: r.sale_id, seller: r.seller || '', mode: r.mode, reason: r.reason || '', restock: r.restock !== false,
      total: Number(r.total), refund: Mariposa.normPayments({ payments: Array.isArray(r.refund) ? r.refund : [] }),
      items: (Array.isArray(r.items) ? r.items : []).map(function (i) {
        return { itemId: i.item_id, productId: i.product_id || null, name: i.name || '', code: i.code || '', qty: i.qty | 0,
                 unitPrice: Number(i.unit_price), restocked: i.restocked | 0 };
      })
    };
  }
  function countFromRow(r) {
    return { id: r.id, at: r.created_at, seller: r.seller || '', day: r.day, from: r.window_from, to: r.window_to,
             expected: r.expected || {}, counted: r.counted || {}, note: r.note || '' };
  }
  function returnResult(d) {
    return { returnId: d.return_id, duplicate: !!d.duplicate, total: Number(d.total),
             items: (d.items || []).map(function (i) { return { itemId: i.item_id, qty: i.qty, restocked: i.restocked }; }) };
  }
  function movFromRow(r) {
    return { id: r.id, at: r.created_at, productId: r.product_id, productName: r.product_name, kind: r.kind,
             dStore: r.delta_store, dWarehouse: r.delta_warehouse, storeAfter: r.store_after, warehouseAfter: r.warehouse_after,
             note: r.note || '', userId: r.user_id, saleId: r.sale_id };
  }
  function settingsFromRow(r) {
    var d = (r && r.data) || {};
    return {
      name: d.name || 'Mi tienda', place: d.place || '', whatsapp: Array.isArray(d.whatsapp) ? d.whatsapp : [],
      address: d.address || '', hours: d.hours || '', mapUrl: d.mapUrl || '', currency: d.currency == null ? '$' : String(d.currency),
      baseCurrency: d.baseCurrency === 'usd' || d.baseCurrency === 'mn' ? d.baseCurrency : '',   // moneda en que están los precios
      mnPerUsd: Number(d.mnPerUsd) > 0 ? Number(d.mnPerUsd) : 0,                                   // cuántos MN vale 1 USD
      palette: d.palette || '', about: d.about || ''
    };
  }
  function saleResult(d) {
    return {
      saleId: d.sale_id, duplicate: !!d.duplicate, total: Number(d.total), hasShortage: !!d.has_shortage,
      items: (d.items || []).map(function (i) {
        return { productId: i.product_id, qty: i.qty, deducted: i.deducted, shortage: i.shortage, store: i.stock_store, warehouse: i.stock_warehouse };
      })
    };
  }
  Mariposa._shapes = { prodFromRow: prodFromRow, catFromRow: catFromRow, saleFromRow: saleFromRow, movFromRow: movFromRow, settingsFromRow: settingsFromRow, saleResult: saleResult,
                       retFromRow: retFromRow, countFromRow: countFromRow, returnResult: returnResult };

  /* ------------------------------------------------------------------
     Versión "public": lectura del catálogo con fetch (para los clientes)
     ------------------------------------------------------------------ */
  function restHeaders(token) {
    var key = CFG.supabaseAnonKey;
    var h = { apikey: key, Accept: 'application/json' };
    var bearer = token || (/^eyJ/.test(key) ? key : '');   // las llaves nuevas (sb_publishable_) no son JWT
    if (bearer) h.Authorization = 'Bearer ' + bearer;
    return h;
  }
  function getJson(path) {
    var base = String(CFG.supabaseUrl).replace(/\/+$/, '');
    var ctrl = global.AbortController ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    return fetch(base + '/rest/v1/' + path, { headers: restHeaders(), cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (t) clearTimeout(t);
        if (!r.ok) return r.text().then(function (tx) { var e = new Error(tx || ('HTTP ' + r.status)); e.status = r.status; throw e; });
        return r.json();
      }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  var CAT_COLS = 'id,name,tint,phrase,subs,position';

  function createPublic() {
    var CACHE = 'mariposa.catalog.public2';
    return {
      mode: 'public', isDemo: false,
      loadCatalog: function () {
        return Promise.all([
          getJson('store_settings?select=data&id=eq.1'),
          getJson('categories?select=' + CAT_COLS + '&order=position.asc'),
          getJson('rpc/public_products')       // solo productos visibles y su cantidad TOTAL
        ]).then(function (r) {
          var out = {
            settings: settingsFromRow(r[0][0]), categories: r[1].map(catFromRow), products: r[2].map(prodFromPublic),
            fromCache: false, fetchedAt: Date.now()
          };
          Mariposa.store.set(CACHE, out);
          return out;
        }).catch(function (e) {
          var c = Mariposa.store.get(CACHE);
          if (c) { c.fromCache = true; return c; }
          throw toErr(e);
        });
      }
    };
  }

  /* ------------------------------------------------------------------
     Versión "live": con cuenta, usa supabase-js
     ------------------------------------------------------------------ */
  function createLive(app) {
    var sb = global.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'mariposa-auth-' + app }
    });
    var PROFILE = 'mariposa.profile.' + app;
    var CACHE = 'mariposa.catalog.staff.' + app;
    var me = null;

    function run(p) {
      return Promise.resolve(p).then(function (res) {
        if (res && res.error) throw toErr(res.error);
        return res ? res.data : null;
      }, function (e) { throw toErr(e); });
    }
    function rpc(name, args) { return run(sb.rpc(name, args || {})); }

    function finishLogin(user) {
      return run(sb.from('profiles').select('role,display_name').eq('user_id', user.id).maybeSingle()).then(function (row) {
        me = { userId: user.id, email: user.email || '', role: row ? row.role : null, name: row ? row.display_name : '', offline: false };
        Mariposa.store.set(PROFILE, me);
        return me;
      });
    }

    var api = {
      mode: 'live', isDemo: false, app: app,
      session: function () { return me; },

      /* ---- sesión ---- */
      restore: function () {
        return sb.auth.getSession().then(function (r) {
          var s = r && r.data && r.data.session;
          if (!s) { var cached0 = Mariposa.store.get(PROFILE); return null; }
          return finishLogin(s.user).catch(function (e) {
            var c = Mariposa.store.get(PROFILE);
            if (toErr(e).code === 'network' && c && c.userId === s.user.id) { me = Object.assign({}, c, { offline: true }); return me; }
            if (toErr(e).code === 'auth') return null;
            throw toErr(e);
          });
        }, function (e) {
          var c = Mariposa.store.get(PROFILE);
          if (c && toErr(e).code === 'network') { me = Object.assign({}, c, { offline: true }); return me; }
          return null;
        });
      },
      signIn: function (email, password) {
        return sb.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') }).then(function (res) {
          if (res.error) throw toErr(res.error);
          return sb.auth.mfa.getAuthenticatorAssuranceLevel().then(function (lv) {
            var d = lv && lv.data;
            if (d && d.nextLevel === 'aal2' && d.currentLevel !== 'aal2') {
              return sb.auth.mfa.listFactors().then(function (fl) {
                var f = fl.data && fl.data.totp && fl.data.totp[0];
                if (f) return { mfaRequired: true, factorId: f.id };
                return finishLogin(res.data.user).then(function (s) { return { session: s }; });
              });
            }
            return finishLogin(res.data.user).then(function (s) { return { session: s }; });
          });
        }, function (e) { throw toErr(e); });
      },
      verifyMfa: function (factorId, code) {
        return run(sb.auth.mfa.challengeAndVerify({ factorId: factorId, code: String(code || '').replace(/\s/g, '') })).then(function () {
          return sb.auth.getUser().then(function (r) { return finishLogin(r.data.user); });
        });
      },
      signOut: function () {
        me = null; Mariposa.store.del(PROFILE); Mariposa.store.del(CACHE);
        return sb.auth.signOut().catch(function () {});
      },
      onAuthChange: function (cb) {
        var sub = sb.auth.onAuthStateChange(function (event) { setTimeout(function () { cb(event); }, 0); });
        return function () { try { sub.data.subscription.unsubscribe(); } catch (e) {} };
      },

      /* ---- catálogo (con productos ocultos y cantidades) ---- */
      loadCatalog: function () {
        return Promise.all([
          run(sb.from('store_settings').select('data').eq('id', 1).maybeSingle()),
          run(sb.from('categories').select(CAT_COLS).order('position')),
          run(sb.from('products').select('*').order('name'))
        ]).then(function (r) {
          var out = { settings: settingsFromRow(r[0]), categories: r[1].map(catFromRow), products: r[2].map(prodFromRow), fromCache: false, fetchedAt: Date.now() };
          Mariposa.store.set(CACHE, out);
          return out;
        }).catch(function (e) {
          var c = Mariposa.store.get(CACHE);
          if (c && toErr(e).code === 'network') { c.fromCache = true; return c; }
          throw toErr(e);
        });
      },

      /* ---- ventas ---- */
      // items: [{productId, qty}]. Si se cae internet, lanza un error con code 'network'.
      registerSale: function (sale) {
        return rpc('register_sale', {
          p_sale_id: sale.id,
          p_items: sale.items.map(function (i) { return { product_id: i.productId, qty: i.qty }; }),
          p_note: sale.note || '',
          p_sold_at: sale.soldAt || null,
          p_payments: Mariposa.normPayments(sale)
        }).then(saleResult);
      },
      listSales: function (range) {
        // sale_item_costs solo trae datos para la dueña; para los demás llega vacío.
        function build(sel) {
          var q = sb.from('sales').select(sel).order('sold_at', { ascending: false }).limit(1000);
          if (range && range.from) q = q.gte('sold_at', range.from);
          if (range && range.to) q = q.lt('sold_at', range.to);
          return q;
        }
        function shape(rows) { return (rows || []).map(saleFromRow); }
        return run(build('*, sale_items(*, sale_item_costs(unit_cost)), sale_returns(*)')).then(shape, function (e) {
          if (e && (e.code === 'network' || e.code === 'auth' || e.code === 'forbidden')) throw e;
          // Si la base de datos todavía no tiene la actualización (costos y devoluciones), al menos se leen las ventas.
          return run(build('*, sale_items(*)')).then(shape);
        });
      },
      voidSale: function (id, reason) { return rpc('void_sale', { p_sale_id: id, p_reason: reason || '' }); },
      // Devolución o cambio de uno o varios productos de una venta.
      // r: { id, saleId, items: [{itemId, qty}], mode: 'refund'|'exchange', refund: [{method, amount}], reason, restock }
      returnItems: function (r) {
        return rpc('return_items', {
          p_return_id: r.id, p_sale_id: r.saleId,
          p_items: r.items.map(function (i) { return { item_id: i.itemId, qty: i.qty }; }),
          p_mode: r.mode || 'refund', p_refund: Mariposa.normPayments({ payments: r.refund || [] }),
          p_reason: r.reason || '', p_restock: r.restock !== false
        }).then(returnResult);
      },
      // Cuadre de caja. c: { id, day: 'YYYY-MM-DD', from: ISO, to: ISO, counted: {cash_mn, cash_usd, transfer}, note }
      saveCashCount: function (c) {
        return rpc('save_cash_count', { p_id: c.id, p_day: c.day, p_from: c.from, p_to: c.to, p_counted: c.counted, p_note: c.note || '' })
          .then(function (d) { return { id: d.id, duplicate: !!d.duplicate, expected: d.expected || {}, counted: d.counted || {} }; });
      },
      // Lo que debe haber en caja en un período (solo lectura): { cash_mn, cash_usd, transfer }
      cashExpected: function (range) {
        return rpc('cash_expected', { p_from: range.from, p_to: range.to }).then(function (d) {
          return { cash_mn: Number(d.cash_mn) || 0, cash_usd: Number(d.cash_usd) || 0, transfer: Number(d.transfer) || 0 };
        });
      },
      listCashCounts: function (range) {       // range: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (días, inclusive)
        var q = sb.from('cash_counts').select('*').order('created_at', { ascending: false }).limit(200);
        if (range && range.from) q = q.gte('day', range.from);
        if (range && range.to) q = q.lte('day', range.to);
        return run(q).then(function (rows) { return (rows || []).map(countFromRow); });
      },

      /* ---- datos privados del producto: costo y aviso de reposición (solo la dueña) ---- */
      loadPrivate: function () {
        return run(sb.from('product_private').select('product_id,cost,reorder_at')).then(function (rows) {
          var o = {};
          (rows || []).forEach(function (r) { o[r.product_id] = { cost: r.cost == null ? null : Number(r.cost), reorderAt: r.reorder_at == null ? null : r.reorder_at | 0 }; });
          return o;
        });
      },
      savePrivate: function (productId, d) {   // d: { cost: número|null, reorderAt: entero|null }
        var cost = d && d.cost != null && d.cost !== '' ? Number(d.cost) : null;
        var re = d && d.reorderAt != null && d.reorderAt !== '' ? Number(d.reorderAt) : null;
        if (cost == null && re == null) return run(sb.from('product_private').delete().eq('product_id', productId));
        return run(sb.from('product_private').upsert({ product_id: productId, cost: cost, reorder_at: re }, { onConflict: 'product_id' }));
      },

      /* ---- productos (dueño o asistente) ---- */
      saveProduct: function (p) {
        var row = {
          code: p.code || '', name: p.name, category_id: p.cat, sub: p.sub || null, price: p.price,
          description: p.desc || '', photo: p.photoPath || null, visible: p.visible !== false
        };
        if (p.id) return run(sb.from('products').update(row).eq('id', p.id).select().single()).then(prodFromRow);
        row.stock_store = p.store | 0; row.stock_warehouse = p.warehouse | 0;
        return run(sb.from('products').insert(row).select().single()).then(prodFromRow);
      },
      deleteProduct: function (id) { return run(sb.from('products').delete().eq('id', id)); },
      uploadPhoto: function (blob) {
        var path = Mariposa.uuid().replace(/-/g, '') + '.jpg';
        return run(sb.storage.from('fotos').upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false, cacheControl: '31536000' }))
          .then(function () { return { path: path, url: photoBase() + path }; });
      },
      removePhoto: function (path) { return sb.storage.from('fotos').remove([path]).catch(function () {}); },

      /* ---- cantidades (dueño o asistente). Devuelven {store, warehouse} ---- */
      stockEntry: function (productId, qty, note) {
        return rpc('stock_entry', { p_product_id: productId, p_qty: qty, p_note: note || '' }).then(stockOut);
      },
      stockTransfer: function (productId, to, qty, note) {      // to: 'store' | 'warehouse'
        return rpc('stock_transfer', { p_product_id: productId, p_to: to, p_qty: qty, p_note: note || '' }).then(stockOut);
      },
      stockAdjust: function (productId, location, delta, note) { // location: 'store' | 'warehouse'
        return rpc('stock_adjust', { p_product_id: productId, p_location: location, p_delta: delta, p_note: note || '' }).then(stockOut);
      },
      listMovements: function (opts) {
        opts = opts || {};
        var q = sb.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(opts.limit || 200);
        if (opts.productId) q = q.eq('product_id', opts.productId);
        return run(q).then(function (rows) { return (rows || []).map(movFromRow); });
      },

      /* ---- categorías y datos de la tienda (dueño) ---- */
      saveCategories: function (list) {
        var rows = list.map(function (c, i) {
          return { id: c.id, name: c.name, tint: c.tint || 'otros', phrase: c.phrase || '', subs: c.subs || [], position: i };
        });
        return run(sb.from('categories').select('id')).then(function (existing) {
          var keep = {}; rows.forEach(function (r) { keep[r.id] = true; });
          var gone = (existing || []).map(function (e) { return e.id; }).filter(function (id) { return !keep[id]; });
          return run(sb.from('categories').upsert(rows, { onConflict: 'id' })).then(function () {
            return gone.length ? run(sb.from('categories').delete().in('id', gone)) : null;
          });
        });
      },
      saveSettings: function (s) {
        return run(sb.from('store_settings').update({ data: s }).eq('id', 1).select().single());
      },

      /* ---- equipo (dueño) ---- */
      teamList: function () {
        return rpc('team_list').then(function (rows) {
          return (rows || []).map(function (r) { return { userId: r.user_id, email: r.email, role: r.role, name: r.display_name }; });
        });
      },
      grantAccess: function (email, name, role) { return rpc('grant_access', { p_email: email, p_name: name || '', p_role: role || 'worker' }); },
      revokeAccess: function (userId) { return rpc('revoke_access', { p_user_id: userId }); },

      /* ---- verificación en dos pasos (dueño) ---- */
      mfa: {
        status: function () {
          return run(sb.auth.mfa.listFactors()).then(function (d) {
            var verified = (d && d.totp) || [];
            return { enabled: verified.length > 0, factors: verified.map(function (f) { return { id: f.id, name: f.friendly_name || '' }; }) };
          });
        },
        enroll: function () {
          return run(sb.auth.mfa.listFactors()).then(function (d) {
            var stale = ((d && d.all) || []).filter(function (f) { return f.status === 'unverified'; });
            return Promise.all(stale.map(function (f) { return sb.auth.mfa.unenroll({ factorId: f.id }).catch(function () {}); }));
          }).then(function () {
            return run(sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Teléfono ' + new Date().toISOString().slice(0, 10) }));
          }).then(function (d) { return { factorId: d.id, qr: d.totp.qr_code, secret: d.totp.secret }; });
        },
        confirmEnroll: function (factorId, code) {
          return run(sb.auth.mfa.challengeAndVerify({ factorId: factorId, code: String(code || '').replace(/\s/g, '') }));
        },
        cancelEnroll: function (factorId) { return sb.auth.mfa.unenroll({ factorId: factorId }).catch(function () {}); },
        disable: function (factorId) { return run(sb.auth.mfa.unenroll({ factorId: factorId })); }
      }
    };
    function stockOut(d) { return { store: d.stock_store, warehouse: d.stock_warehouse }; }
    return api;
  }

  /* ------------------------------------------------------------------
     Punto de entrada
        Mariposa.open()                              -> clientes (solo lectura)
        Mariposa.open({ staff: true, app: 'ventas' }) -> con cuenta
     ------------------------------------------------------------------ */
  Mariposa.open = function (opts) {
    opts = opts || {};
    var app = opts.app || 'app';
    if (CFG.demo) {
      return Mariposa.loadScript(CFG.demoScript || 'js/demo.js').then(function () { return Mariposa.createDemo(app, opts); });
    }
    if (!Mariposa.isConfigured()) return Promise.reject(new MariposaError('not_configured'));
    if (opts.staff) {
      if (!global.supabase || !global.supabase.createClient) return Promise.reject(new MariposaError('no_library'));
      return Promise.resolve(createLive(app));
    }
    return Promise.resolve(createPublic());
  };
})(window);
