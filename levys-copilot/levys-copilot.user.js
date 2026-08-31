// ==UserScript==
// @name         Levys Bazar Copiloto ML
// @namespace    levysbazar.copiloto
// @version      0.9.0
// @description  Copiloto integrado como un ítem más del menú de Mercado Libre (mismos diseños, colores y fuentes), autocargado en segundo plano: stock crítico Full, oportunidades sin usar, calendario comercial, margen real, competencia y tendencias propias — para Levys Bazar / TUSHKA (seller 107584006).
// @author       Levys Bazar
// @match        https://vendedores.mercadolibre.com.ar/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      identitytoolkit.googleapis.com
// @connect      securetoken.googleapis.com
// @connect      firestore.googleapis.com
// ==/UserScript==

/*
  ------------------------------------------------------------------------
  LEVYS BAZAR — COPILOTO PARA VENDEDORES.MERCADOLIBRE.COM.AR
  ------------------------------------------------------------------------
  Qué hace:
   1. Intercepta las respuestas de red que la propia página de ML ya carga
      (fetch + XHR) y lee el estado embebido en el HTML de las páginas
      server-renderizadas (ventas, publicaciones, reputación) — sin pedir
      nada que ML no te esté por mostrar de todas formas.
   2. En segundo plano (mientras la pestaña está abierta) pide por su
      cuenta, de a una y escalonadas, las 7 fuentes que necesita — no hace
      falta navegar a cada pantalla para que se complete.
   3. Guarda un historial propio (via GM_setValue) para poder comparar
      "esta semana" contra "el promedio de las últimas semanas" — cosas
      que ML no te cruza.
   4. Se suma como un ítem más del menú lateral real de Mercado Libre
      (mismas clases CSS que "Resumen" o "Publicaciones", así hereda su
      tipografía, colores e íconos reales) con KPIs y alertas activas:
      stock crítico, oportunidades sin usar, calendario comercial cruzado
      con tu catálogo, margen real (con costo que vos cargás), competencia
      (posición en tu categoría + brechas vs. tu rival más cercano) y
      tendencia propia una vez que haya historial.

  Qué NO hace todavía (honesto, no lo simulamos):
   - Cruce entre categoría en tendencia (lo que ML calcula en
     /metricas/analisis-de-mercado/tendencias-por-categorias) y tu catálogo:
     esa pantalla carga sus datos vía módulos remotos que no llegamos a
     capturar en los HAR (no hay una respuesta real para reverse-engenieer,
     así que no la simulamos).
   - Comparación producto a producto contra publicaciones puntuales de un
     competidor (existe una API para eso, pero matchear "tu producto" con
     "su producto equivalente" de forma confiable necesitaría más señal de
     la que tenemos hoy).
   - Forecasting estadístico pesado (ARIMA/Prophet). Lo que sí hace es
     comparación directa contra tu propio historial acumulado, que para
     este uso es lo que importa y no necesita años de datos.
  ------------------------------------------------------------------------
*/

(function () {
  'use strict';

  // ======================================================================
  // 0. STORAGE — GM_* con fallback a localStorage si el userscript manager
  //    no las expone (por ejemplo si falta algún @grant).
  // ======================================================================
  const Store = (function () {
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    return {
      get(key, fallback) {
        try {
          if (hasGM) {
            const v = GM_getValue(key, undefined);
            return v === undefined ? fallback : JSON.parse(v);
          }
          const raw = window.localStorage.getItem('levys_copilot_' + key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
      },
      set(key, value) {
        try {
          const raw = JSON.stringify(value);
          if (hasGM) { GM_setValue(key, raw); }
          else { window.localStorage.setItem('levys_copilot_' + key, raw); }
        } catch (e) { /* noop */ }
      },
    };
  })();

  // ======================================================================
  // 0.5 SINCRONIZACIÓN EN LA NUBE (opcional) — Firestore vía REST, llamado
  //     con GM_xmlhttpRequest (no fetch/XHR normal) a propósito: así la
  //     llamada la hace el userscript manager, no la página, y no choca
  //     contra la Content-Security-Policy de mercadolibre.com.ar.
  //
  //     Mientras CLOUD_CONFIG esté vacío, todo esto queda inerte y el
  //     panel sigue funcionando 100% local como hasta ahora — no rompe
  //     nada para quien todavía no configuró Firebase.
  //
  //     Qué sincroniza: el costo que cargás en "Margen real" y el
  //     historial propio ("Tendencia propia"), en un único documento
  //     compartido (shops/levysbazar) — así vos y quien más uses el
  //     panel ven los mismos números sin tener que cargarlos dos veces.
  // ======================================================================
  const CLOUD_CONFIG = {
    // Pegá acá los dos valores que te da la consola de Firebase (ver
    // LEEME.md → "Sincronización en la nube"). El resto de esta sección
    // no necesita tocarse.
    apiKey: '',
    projectId: '',
  };

  // -- (de)serialización al formato "typed value" que usa la API REST de
  //    Firestore (cada valor viaja envuelto en {stringValue:...} /
  //    {integerValue:...} / {mapValue:{fields:{...}}} / etc.) --
  function toFirestoreValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
    if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
    return { stringValue: String(v) };
  }
  function toFirestoreFields(obj) {
    const out = {};
    Object.keys(obj || {}).forEach(k => { out[k] = toFirestoreValue(obj[k]); });
    return out;
  }
  function fromFirestoreValue(fv) {
    if (!fv) return null;
    if ('nullValue' in fv) return null;
    if ('booleanValue' in fv) return fv.booleanValue;
    if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
    if ('doubleValue' in fv) return fv.doubleValue;
    if ('stringValue' in fv) return fv.stringValue;
    if ('arrayValue' in fv) return (fv.arrayValue.values || []).map(fromFirestoreValue);
    if ('mapValue' in fv) return fromFirestoreFields(fv.mapValue.fields || {});
    return null;
  }
  function fromFirestoreFields(fields) {
    const out = {};
    Object.keys(fields || {}).forEach(k => { out[k] = fromFirestoreValue(fields[k]); });
    return out;
  }

  // -- merges simples (no es un CRDT — alcanza para 2-3 personas editando
  //    de vez en cuando, no ediciones simultáneas al segundo) --
  // costos: mapa familyId -> número. Ante conflicto en la misma key, gana
  // el valor local (se asume que lo acabás de cargar vos mismo ahora).
  function mergeCostos(local, cloud) {
    return Object.assign({}, cloud || {}, local || {});
  }
  // historial: array de {date, ...kpis}. Ante mismo date, se combinan los
  // campos (local pisa por campo, no por día entero) para no perder datos
  // que una sola de las dos fuentes tenga para ese día.
  function mergeHistory(local, cloud) {
    const map = {};
    (cloud || []).forEach(h => { if (h && h.date) map[h.date] = Object.assign({}, h); });
    (local || []).forEach(h => { if (h && h.date) map[h.date] = Object.assign({}, map[h.date] || {}, h); });
    const merged = Object.keys(map).sort().map(k => map[k]);
    while (merged.length > 180) merged.shift();
    return merged;
  }

  const Cloud = (function () {
    const DOC_PATH = 'shops/levysbazar';

    function enabled() { return !!(CLOUD_CONFIG.apiKey && CLOUD_CONFIG.projectId); }

    function gmRequest(opts) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest no disponible')); return; }
        GM_xmlhttpRequest(Object.assign({
          timeout: 15000,
          onload: res => resolve(res),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
        }, opts));
      });
    }

    async function getIdToken() {
      const cached = Store.get('cloud_auth', null);
      const now = Date.now();
      if (cached && cached.expiresAt && cached.expiresAt - 60000 > now) return cached.idToken;
      if (cached && cached.refreshToken) {
        try {
          const res = await gmRequest({
            method: 'POST',
            url: 'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(CLOUD_CONFIG.apiKey),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(cached.refreshToken),
          });
          const json = JSON.parse(res.responseText);
          const auth = { idToken: json.id_token, refreshToken: json.refresh_token, expiresAt: now + parseInt(json.expires_in, 10) * 1000, uid: json.user_id };
          Store.set('cloud_auth', auth);
          return auth.idToken;
        } catch (e) { /* si falla el refresh, probamos alta anónima nueva abajo */ }
      }
      const res = await gmRequest({
        method: 'POST',
        url: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(CLOUD_CONFIG.apiKey),
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ returnSecureToken: true }),
      });
      const json = JSON.parse(res.responseText);
      const auth = { idToken: json.idToken, refreshToken: json.refreshToken, expiresAt: now + parseInt(json.expiresIn, 10) * 1000, uid: json.localId };
      Store.set('cloud_auth', auth);
      return auth.idToken;
    }

    async function firestoreRequest(method, body, updateMaskFields) {
      const token = await getIdToken();
      if (!token) return null;
      let url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(CLOUD_CONFIG.projectId) + '/databases/(default)/documents/' + DOC_PATH;
      if (updateMaskFields) {
        url += '?' + updateMaskFields.map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
      }
      const res = await gmRequest({
        method,
        url,
        headers: Object.assign({ 'Authorization': 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
        data: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404) return null;
      if (res.status >= 400) throw new Error('Firestore ' + res.status + ': ' + res.responseText);
      return res.responseText ? JSON.parse(res.responseText) : null;
    }

    async function pull() {
      if (!enabled()) return null;
      try {
        const doc = await firestoreRequest('GET', null, null);
        if (!doc || !doc.fields) return null;
        return fromFirestoreFields(doc.fields);
      } catch (e) {
        console.warn('[Copiloto] no se pudo leer de la nube:', e && e.message);
        return null;
      }
    }

    async function pushField(fieldName, value) {
      if (!enabled()) return false;
      try {
        const fields = {};
        fields[fieldName] = value;
        fields.updatedAt = new Date().toISOString();
        await firestoreRequest('PATCH', { fields: toFirestoreFields(fields) }, [fieldName, 'updatedAt']);
        return true;
      } catch (e) {
        console.warn('[Copiloto] no se pudo escribir en la nube (' + fieldName + '):', e && e.message);
        return false;
      }
    }

    return {
      enabled,
      pull,
      pushCostos: costs => pushField('costos', costs),
      pushHistory: hist => pushField('history', hist),
    };
  })();

  // ======================================================================
  // 1. UTILIDADES DE PARSEO — portadas 1:1 de la versión que validamos
  //    contra los 3 HAR reales (ventas, publicaciones+Full, reputación).
  // ======================================================================

  // Extrae un objeto JSON balanceado en llaves a partir de un string que
  // empieza en '{' — necesario porque los blobs "_n.ctx.r={...};..." no
  // son JSON puro (tienen JS alrededor), así que no alcanza con JSON.parse
  // directo ni con un regex greedy.
  function extractBalanced(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
      }
    }
    return null;
  }

  function extractCtxState(html) {
    // Busca el script inline más grande que contenga "_n.ctx.r=" y le saca
    // el objeto JSON balanceado.
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!scripts.length) return null;
    const big = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
    const idx = big.indexOf('_n.ctx.r=');
    if (idx === -1) return null;
    const start = big.indexOf('{', idx);
    if (start === -1) return null;
    const jsonStr = extractBalanced(big, start);
    if (!jsonStr) return null;
    try { return JSON.parse(jsonStr); } catch (e) { return null; }
  }

  function parseAR(numStr) {
    if (numStr === null || numStr === undefined) return null;
    let s = String(numStr).replace(/[^0-9,.\-]/g, '');
    s = s.replace(/\./g, '').replace(',', '.');
    const v = parseFloat(s);
    return isNaN(v) ? null : v;
  }

  function todayKey(d) {
    d = d || new Date();
    return d.toISOString().slice(0, 10);
  }

  // ======================================================================
  // 2. NORMALIZADORES — de cada forma cruda que ML devuelve a un modelo
  //    limpio y estable, sea que venga de HTML embebido o de un fetch JSON.
  // ======================================================================

  function normalizeVentas(ctxState) {
    try {
      const bs = ctxState.appProps.pageProps.floxPreloadedState['@meli/web/flox/FLOX_STATE'].brickStack;
      const rowKeys = Object.keys(bs).filter(k => k.startsWith('row-'));
      return rowKeys.map(k => {
        const d = bs[k].data || {};
        const idd = d.identificationData || {};
        const sad = d.statusActionsData || {};
        const pd = d.productData || {};
        return {
          id: idd.id, date: idd.date, buyer: (idd.buyer || {}).name,
          status: sad.status, statusDetail: sad.description,
          product: pd.label, price: pd.price, qty: pd.quantity,
        };
      });
    } catch (e) { return null; }
  }

  function normalizePublicaciones(ctxState) {
    try {
      const rows = ctxState.appProps.pageProps.viewData.rows;
      return rows.map(r => {
        const prod = r.product || {};
        const stockMap = {};
        (prod.stock || []).forEach(s => { stockMap[s.id] = s.label; });
        let price = null;
        if (r.price && r.price.lines && r.price.lines[0]) price = r.price.lines[0].label;
        return {
          id: prod.id, title: prod.title, status: prod.status,
          stockDeposito: stockMap.flex, stockFull: stockMap.fulfillment, price,
          qualityGoals: (r.quality || {}).goals, experienceGoals: (r.experience || {}).goals,
          familyId: (r.metadata || {}).familyId,
          // foto real (la primera de la publicación) -- ya viene en el
          // mismo objeto "product" de esta tabla, sin pedir nada extra.
          foto: (prod.pictures && prod.pictures.urls && prod.pictures.urls[0]) || null,
          // link real de ML para editar esta publicación puntual (viene tal
          // cual de la propia página — no lo armamos nosotros).
          link: prod.redirectUrl || null,
        };
      });
    } catch (e) { return null; }
  }

  function normalizeReputacion(ctxState) {
    try {
      const pp = ctxState.appProps.pageProps;
      const s = pp.summaryData || {};
      const v = pp.variablesData || {};
      const exp = pp.exposureLevelsData || {};
      const labels = { claims: 'Reclamos', disputes: 'Mediaciones', cancellations: 'Canceladas por vos', delayed_handling_time: 'Demoras en el despacho' };
      return {
        level: (s.levels || {}).level,
        periodDays: (s.periods || {}).quantity,
        salesPeriod: (s.variables || {}).sales,
        gmvPeriodLC: ((s.variables || {}).gmv || {}).gmvLC,
        variables: (v.variables || []).map(x => ({ id: x.id, label: labels[x.id] || x.id, qty: x.quantity, pct: x.percentage, health: x.health })),
        exposure: (exp.contentRows || []).map(r => ({ shippingType: (r.shippingType || {}).value, level: (r.exposureLvl || {}).value })),
      };
    } catch (e) { return null; }
  }

  function riskRank(timeToSellOut) {
    if (!timeToSellOut) return 999;
    if (timeToSellOut.indexOf('Sin stock') !== -1) return 0;
    const m = timeToSellOut.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 999;
  }

  function normalizeFullStock(json) {
    try {
      const st = json.stockTable;
      const products = st.products.map(p => {
        const cols = {};
        p.columns.forEach(c => { cols[c.id] = c.data; });
        const prod = cols.product || {};
        const ident = prod.identifiers || {};
        const cellText = id => (cols[id] || {}).text;
        const timeToSellOut = cellText('time-to-sell-out');
        return {
          id: p.id, title: prod.title,
          sku: ((ident.sku || {}).codes || [{}])[0].value,
          size: (prod.segmentPill || {}).text,
          sales30d: cellText('last-month-sales'), avgStock: cellText('average-stock'),
          onTheWay: cellText('on-the-way'), notSuitable: cellText('not-suitable-for-sale'),
          suitable: cellText('suitable-for-sale'), aging: cellText('aging-stock'),
          timeToSellOut, riskRank: riskRank(timeToSellOut),
          // foto real del producto -- ya viene en esta misma columna, sin
          // pedir nada extra (la misma que ML muestra en su propia tabla).
          foto: prod.image || null,
          // mismo patrón de URL que usa el propio tooltip de ML en esta
          // pantalla (?userProductId=...) para llevarte directo a esa
          // publicación en el listado.
          link: p.id ? 'https://www.mercadolibre.com.ar/publicaciones/listado?userProductId=' + encodeURIComponent(p.id) : null,
        };
      });
      products.sort((a, b) => a.riskRank - b.riskRank);
      return { products, distribution: (json.stockDistributionSpaceFcv || {}).stockDistribution || [] };
    } catch (e) { return null; }
  }

  function normalizeUpdateRows(json, familyId) {
    try {
      const ur = (json.updatedRows || [])[0];
      if (!ur) return null;
      const earn = ur.earnings || {};
      const lines = earn.lines || [];
      const metrics = (ur.metrics || {}).metrics || [];
      const byIcon = {};
      metrics.forEach(m => { byIcon[m.icon] = m.value; });
      return { familyId, earnings: lines[0] ? lines[0].label : null, visits: byIcon.visits, sales: byIcon.sales, conversion: byIcon.conversion };
    } catch (e) { return null; }
  }

  function normalizeResumenCards(json) {
    try {
      const cards = json.cards || {};
      const mc = cards.metrics_card || {};
      const gen = ((mc.data || {}).general || [{}])[0];
      let chart = null;
      try { chart = mc.data.details[0][0].metric.chart.data; } catch (e2) {}
      const bc = cards.billing_card || {};
      const bgen = ((bc.data || {}).general || [{}])[0];
      const fc = cards.flex_shipping_card || {};
      const fgen = ((fc.data || {}).general || [{}])[0];
      const sf = cards.stock_full_card || {};
      return {
        sales7d: {
          amount: (gen.amountTitle || {}).fraction,
          variationPct: (((gen.amountTitle || {}).badge || {}).text),
          variationColor: (((gen.amountTitle || {}).badge || {}).color),
          dailyChart: chart,
        },
        billing: { balance: (bgen.amountTitle || {}).fraction, cents: (bgen.amountTitle || {}).cents, description: (bgen.description || {}).value },
        flex: { complianceThisWeek: (fgen.title || {}).value, description: (fgen.description || {}).value },
        fullSpaceCards: (sf.data || {}).general,
      };
    } catch (e) { return null; }
  }

  function normalizePromosMetrics(json) { try { return (json.data || {}).metrics || null; } catch (e) { return null; } }
  function normalizeTasksAndRecos(json) { try { return (json.tasks_and_recos || {}).tasks || null; } catch (e) { return null; } }
  function normalizePromotionsSummary(json) {
    try {
      return (json.promotions.meli_campaigns || []).map(c => ({
        title: c.title, candidates: (c.counts || {}).candidates, offers: (c.counts || {}).offers, endDate: c.endDate,
      }));
    } catch (e) { return null; }
  }

  // -- Competencia: /metricas/benchmark/api/ranking/bricks --
  // Trae dos tablas: "Tu posición" (vos + los vecinos de ranking en tu
  // categoría) y "Mejores vendedores" (top 50). De ahí sacamos tu posición,
  // si subiste o bajaste vs. el período anterior, y el alias del competidor
  // más cercano arriba tuyo (para pedir después su comparativa puntual).
  function normalizeRankingBricks(json) {
    try {
      const tables = json.bricks[0].bricks; // [tuPosicion, mejoresVendedores]
      const tuPosicionRows = (tables[0].data || {}).rows || [];
      const ownerRow = tuPosicionRows.find(r => (r.columns[1].data || {}).owner);
      if (!ownerRow) return null;
      const ownerIdx = tuPosicionRows.indexOf(ownerRow);
      const rankCol = ownerRow.columns[0].data || {};
      const sellerCol = ownerRow.columns[1].data || {};
      // el competidor inmediatamente arriba tuyo en la tabla de posición
      let nearestAbove = null;
      for (let i = ownerIdx - 1; i >= 0; i--) {
        const sc = tuPosicionRows[i].columns[1].data || {};
        if (!sc.owner) { nearestAbove = sc.alias; break; }
      }
      const cols = ownerRow.columns;
      return {
        position: rankCol.label, change: rankCol.change, trend: rankCol.position,
        alias: sellerCol.alias,
        grossSales: (cols[2].data || {}).label,
        salesQty: (cols[3].data || {}).label,
        visits: (cols[4].data || {}).label,
        conversion: (cols[5].data || {}).label,
        nearestCompetitorAlias: nearestAbove,
        categoryTopAlias: (((tables[1].data || {}).rows || [])[0] || { columns: [{}, {}] }).columns[1].data.alias,
      };
    } catch (e) { return null; }
  }

  // -- Competencia: /metricas/benchmark/api/details-comparative-graph/bricks --
  // Esto es lo más valioso: ML ya calculó, condición por condición de venta
  // (Full, Flex, envío gratis, cuotas, promos, publicidad, clips, catálogo),
  // si estás peor que tu competidor de referencia (requires_improvement) y
  // te da el % tuyo vs el de él/ella.
  function normalizeComparativeGraph(json) {
    try {
      const data = (json.bricks[0].data || {}).graphs || {};
      const info = data.graph_info || [];
      let recos = [];
      try { recos = json.bricks[1].bricks[0].data.recommendations || []; } catch (e2) {}
      const recoByName = {};
      recos.forEach(r => { recoByName[r.name] = r; });
      return info.map(g => {
        const yo = (g.legends || []).find(l => l.color === 'metrics-purple-500');
        const comp = (g.legends || []).find(l => l.color === 'metrics-yellow-500');
        const reco = recoByName[g.name];
        const href = reco && reco.button && reco.button.href ? reco.button.href : null;
        return {
          name: g.name, requiresImprovement: !!g.requires_improvement,
          pctYo: yo ? yo.value : null, pctCompetidor: comp ? comp.value : null,
          recomendacion: reco ? reco.description : null,
          // link real que ML ya te ofrece para resolver esto puntual (por
          // ejemplo "ofrecer envío gratis" te lleva al filtro correcto de
          // tu propio listado) — no inventamos ninguna URL acá.
          link: href || null,
        };
      });
    } catch (e) { return null; }
  }

  // -- Competencia: /metricas/benchmark/api/details-business-table/bricks --
  function normalizeBusinessTable(json) {
    try {
      const rows = json.bricks[0].bricks[0].data.rows;
      const you = rows.find(r => (r.columns[1].data || {}).owner);
      const comp = rows.find(r => !(r.columns[1].data || {}).owner);
      const pick = r => r ? ({
        alias: r.columns[1].data.alias, position: r.columns[0].data.label,
        grossSales: r.columns[2].data.label, unitsSold: r.columns[3].data.label,
        salesQty: r.columns[4].data.label, visits: r.columns[5].data.label,
        conversion: r.columns[6].data.label,
      }) : null;
      return { you: pick(you), competitor: pick(comp) };
    } catch (e) { return null; }
  }

  // ======================================================================
  // 3. STATE — snapshot en memoria que se va completando a medida que
  //    interceptamos cosas, más el historial persistido.
  // ======================================================================
  const live = Store.get('live_snapshot', {}) || {};
  function saveLive() { Store.set('live_snapshot', live); live.updatedAt = new Date().toISOString(); Store.set('live_snapshot', live); render(); }

  function pushHistory(kpis) {
    const hist = Store.get('history', []) || [];
    const key = todayKey();
    const idx = hist.findIndex(h => h.date === key);
    const entry = Object.assign({ date: key }, kpis);
    if (idx === -1) hist.push(entry); else hist[idx] = Object.assign(hist[idx], entry);
    // conservamos hasta 180 días
    while (hist.length > 180) hist.shift();
    Store.set('history', hist);
    Cloud.pushHistory(hist);
    return hist;
  }

  // ======================================================================
  // 4. INTERCEPTOR DE RED — fetch + XHR, matchea por URL contra los
  //    endpoints que ya reverse-engineamos.
  // ======================================================================
  function handleJsonResponse(url, bodyText) {
    let json;
    try { json = JSON.parse(bodyText); } catch (e) { return; }
    try {
      if (url.indexOf('/publicaciones/api/listing/update-rows') !== -1) {
        const m = url.match(/[?&]ids=([^&]+)/);
        const fam = m ? decodeURIComponent(m[1]) : null;
        const row = normalizeUpdateRows(json, fam);
        if (row) {
          live.publicacionesMetrics = live.publicacionesMetrics || {};
          live.publicacionesMetrics[fam] = row;
          saveLive();
        }
      } else if (url.indexOf('/stock-management/space-management/api/content') !== -1) {
        const fs = normalizeFullStock(json);
        if (fs) { live.fullStock = fs; saveLive(); }
      } else if (url.indexOf('/resumen/api/content') !== -1) {
        const cards = normalizeResumenCards(json);
        if (cards) {
          live.resumenCards = cards;
          saveLive();
          pushHistory({
            sales7dAmount: parseAR(cards.sales7d.amount),
            billingBalance: parseAR(cards.billing.balance),
          });
        }
      } else if (url.indexOf('/publicaciones/listado/promos/api/metrics') !== -1) {
        const m = normalizePromosMetrics(json);
        if (m) {
          live.accountMetrics30d = m;
          saveLive();
          pushHistory({
            visits30d: m.visits ? m.visits.total : null,
            conversion30d: m.conversion ? m.conversion.total : null,
            soldUnits30d: m.sold_units ? m.sold_units.total : null,
          });
        }
      } else if (url.indexOf('/publicaciones/listado/promos/api/tasks-and-recos/summary') !== -1) {
        const t = normalizeTasksAndRecos(json);
        if (t) { live.tasksAndRecos = t; saveLive(); }
      } else if (url.indexOf('/publicaciones/listado/promos/api/promotions/summary') !== -1) {
        const c = normalizePromotionsSummary(json);
        if (c) { live.activeCampaigns = c; saveLive(); }
      } else if (url.indexOf('/metricas/benchmark/api/ranking/bricks') !== -1) {
        const mCat = url.match(/[?&]category_id=([^&]+)/);
        if (mCat) Store.set('category_id', decodeURIComponent(mCat[1]));
        const r = normalizeRankingBricks(json);
        if (r) {
          live.competenciaRanking = r;
          saveLive();
          pushHistory({ posicionCategoria: parseInt(r.position, 10) || null });
          // encadenamos: pedimos la comparativa puntual contra el competidor
          // más cercano arriba tuyo (o, si no hay, el líder de la categoría).
          const alias = r.nearestCompetitorAlias || r.categoryTopAlias;
          const catId = Store.get('category_id', DEFAULT_CATEGORY_ID);
          if (alias) fetchCompetitorDetail(alias, catId);
        }
      } else if (url.indexOf('/metricas/benchmark/api/details-comparative-graph/bricks') !== -1) {
        const g = normalizeComparativeGraph(json);
        if (g) { live.competenciaGaps = g; saveLive(); }
      } else if (url.indexOf('/metricas/benchmark/api/details-business-table/bricks') !== -1) {
        const b = normalizeBusinessTable(json);
        if (b) { live.competenciaHeadToHead = b; saveLive(); }
      }
    } catch (e) { /* nunca romper la página de ML por esto */ }
  }

  // Pide, en un solo lugar, la comparativa puntual (gráfico + tabla) contra
  // un competidor puntual — se usa tanto si el propio ML dispara estas
  // llamadas (visitaste /metricas/competencia/detalle) como si las
  // encadenamos nosotros después de leer el ranking en segundo plano.
  function fetchCompetitorDetail(alias, categoryId) {
    const qs = 'alias=' + encodeURIComponent(alias) + '&category_id=' + encodeURIComponent(categoryId) + '&start_period=currentMonth';
    ['details-comparative-graph', 'details-business-table'].forEach((ep, i) => {
      setTimeout(() => {
        const url = '/metricas/benchmark/api/' + ep + '/bricks?' + qs;
        fetch(url, { credentials: 'include' })
          .then(r => r.ok ? r.text() : null)
          .then(t => { if (t) handleJsonResponse(url, t); })
          .catch(() => {});
      }, i * 900);
    });
  }

  function handleHtmlDocument(url, html) {
    try {
      maybeCaptureCompetitorParams(url);
      const ctx = extractCtxState(html);
      if (!ctx) return;
      if (url.indexOf('/ventas/omni/listado') !== -1) {
        const v = normalizeVentas(ctx);
        if (v) { live.ventasRecientes = v; saveLive(); }
      } else if (/\/publicaciones\/?($|\?)/.test(url)) {
        const p = normalizePublicaciones(ctx);
        if (p) {
          live.publicaciones = p;
          saveLive();
          enqueueUpdateRows(p.map(x => x.familyId || x.id).filter(Boolean));
        }
      } else if (url.indexOf('/reputacion') !== -1) {
        const r = normalizeReputacion(ctx);
        if (r) {
          live.reputacion = r;
          saveLive();
          pushHistory({ claimsPct: parseAR((r.variables.find(x => x.id === 'claims') || {}).pct) });
        }
      }
    } catch (e) { /* noop */ }
  }

  // fetch()
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return origFetch.apply(this, arguments).then(resp => {
      try {
        const ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('application/json') !== -1 && isInterestingUrl(url)) {
          resp.clone().text().then(t => handleJsonResponse(url, t)).catch(() => {});
        }
      } catch (e) { /* noop */ }
      return resp;
    });
  };

  // XMLHttpRequest (por si algún endpoint viejo lo usa en vez de fetch)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__levys_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const url = this.__levys_url || '';
        const ct = this.getResponseHeader('content-type') || '';
        if (ct.indexOf('application/json') !== -1 && isInterestingUrl(url)) {
          handleJsonResponse(url, this.responseText);
        }
      } catch (e) { /* noop */ }
    });
    return origSend.apply(this, arguments);
  };

  function isInterestingUrl(url) {
    return /(update-rows|space-management\/api\/content|resumen\/api\/content|promos\/api\/(metrics|tasks-and-recos|promotions)|benchmark\/api\/(ranking|details-comparative-graph|details-business-table))/.test(url);
  }

  // Si navegás a mano a la ficha de un competidor puntual, la URL ya trae
  // alias + category_id — los guardamos igual aunque no nos interese el
  // HTML de esa página (los datos reales llegan por las 3 APIs de arriba).
  function maybeCaptureCompetitorParams(url) {
    try {
      const m = url.match(/\/metricas\/competencia\/detalle\?([^#]+)/);
      if (!m) return;
      const params = new URLSearchParams(m[1]);
      if (params.get('category_id')) Store.set('category_id', params.get('category_id'));
    } catch (e) { /* noop */ }
  }

  // Documento actual (páginas server-renderizadas): se evalúa apenas hay
  // <body>, y de nuevo si la SPA navega sin recargar (pushState/popstate).
  function scanCurrentDocument() {
    handleHtmlDocument(location.href, document.documentElement.outerHTML);
    trySidebarInsert(); // por si la navegación volvió a dibujar el menú lateral
  }
  const origPushState = history.pushState;
  history.pushState = function () {
    const r = origPushState.apply(this, arguments);
    setTimeout(scanCurrentDocument, 800);
    return r;
  };
  window.addEventListener('popstate', () => setTimeout(scanCurrentDocument, 800));

  // ======================================================================
  // 5. POLLER EN SEGUNDO PLANO — el panel se completa solo, sin que navegues
  //    a cada pantalla. En vez de pedir todo junto (lo que se vería como un
  //    pico de tráfico raro), cada fuente tiene su propio intervalo y en
  //    cada "tick" (cada 1 min) como mucho se dispara UNA tarea vencida —
  //    así queda escalonado en el tiempo, pareciendo más una navegación
  //    normal espaciada que un scraper.
  // ======================================================================
  const DEFAULT_CATEGORY_ID = '1574'; // hogar — categoría principal de Levys Bazar

  function fetchHtml(url) {
    return fetch(url, { credentials: 'include' })
      .then(r => (r.ok ? r.text() : null))
      .then(t => { if (t) handleHtmlDocument(location.origin + url, t); })
      .catch(() => {});
  }
  function fetchJsonEndpoint(url) {
    return fetch(url, { credentials: 'include' })
      .then(r => (r.ok ? r.text() : null))
      .then(t => { if (t) handleJsonResponse(url, t); })
      .catch(() => {});
  }

  function pollResumen() { return fetchJsonEndpoint('/resumen/api/content'); }
  function pollVentas() { return fetchHtml('/ventas/omni/listado'); }
  function pollReputacion() { return fetchHtml('/reputacion'); }
  function pollFullStock() { return fetchJsonEndpoint('/stock-management/space-management/api/content?offset=0&limit=50'); }
  function pollPromos() {
    return Promise.all([
      fetchJsonEndpoint('/publicaciones/listado/promos/api/metrics?days=30&activePromos=true'),
      fetchJsonEndpoint('/publicaciones/listado/promos/api/tasks-and-recos/summary'),
      fetchJsonEndpoint('/publicaciones/listado/promos/api/promotions/summary'),
    ]);
  }
  function pollCompetencia() {
    const catId = Store.get('category_id', DEFAULT_CATEGORY_ID);
    return fetchJsonEndpoint('/metricas/benchmark/api/ranking/bricks?category_id=' + encodeURIComponent(catId) + '&start_period=currentMonth&from_current=&to_current=');
  }
  function pollPublicaciones() {
    return fetch('/publicaciones', { credentials: 'include' })
      .then(r => (r.ok ? r.text() : null))
      .then(t => {
        if (!t) return;
        handleHtmlDocument(location.origin + '/publicaciones', t);
        const ids = (live.publicaciones || []).map(p => p.familyId || p.id).filter(Boolean);
        enqueueUpdateRows(ids);
      })
      .catch(() => {});
  }

  // Cola de ids de publicaciones a las que todavía no les pedimos
  // earnings/métricas — se van drenando de a poquitos en cada tick, igual
  // que la propia página de ML las pide a medida que hacés scroll.
  let updateRowsQueue = [];
  function enqueueUpdateRows(ids) {
    const known = live.publicacionesMetrics || {};
    ids.forEach(id => { if (id && !known[id] && updateRowsQueue.indexOf(id) === -1) updateRowsQueue.push(id); });
  }
  function drainUpdateRowsQueue() {
    const batch = updateRowsQueue.splice(0, 3);
    batch.forEach((id, i) => {
      setTimeout(() => fetchJsonEndpoint('/publicaciones/api/listing/update-rows?ids=' + encodeURIComponent(id) + '&cells=earnings,metrics&rowType=main'), i * 700);
    });
  }

  // ======================================================================
  // 4.5 NUEVA PROPUESTA SIN UNIR — portado 1:1 de tu script real
  //     "ML Nueva Propuesta - Escáner" (v1.1.0, mismos umbrales, mismo
  //     descarte de cajas relámpago de un día, mismo criterio de buena
  //     oferta). Acá corre en segundo plano en vez de en un panel flotante
  //     aparte, y el escaneo sigue siendo 100% de solo lectura igual que el
  //     original. Desde v0.7, cada fila puede además CONFIRMARSE desde acá
  //     mismo (ver npFetchModal/npConfirmModal más abajo) — a diferencia
  //     del escaneo, esa es una acción real que escribe en tu cuenta, y
  //     nunca se dispara sola: siempre requiere que abras la vista previa
  //     real (con los datos que Mercado Libre te devuelve en ese momento) y
  //     confirmes con un segundo click explícito, igual que en la pantalla
  //     real de ML.
  // ======================================================================
  const NP_STATUS_LABELS = ['ACTIVA', 'PROGRAMADA', 'PAUSADA', 'FINALIZADA'];
  const NP_PAGE_SIZE = 25;
  const NP_MAX_DIFF_PRECIO_FINAL = 200; // la nueva puede ser hasta $200 más cara
  const NP_MAX_CAIDA_RECIBIS = 200; // el recibís nuevo puede bajar hasta $200

  // Estado transitorio (NO se guarda en Store/live ni se sincroniza a la
  // nube) de la vista previa de confirmación por fila, indexado por id de
  // publicación: { estado: 'idle'|'cargando'|'preview'|'confirmando'|'ok'|'error', modal, mensaje }
  const npPreview = {};

  function npGetCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }
  function npParseMoney(s) {
    if (s == null) return null;
    if (typeof s === 'number') return s;
    const cleaned = String(s).replace(/\$/g, '').replace(/[^\d.,-]/g, '').trim();
    if (!cleaned) return null;
    if (/\ba\b/i.test(String(s))) return null; // "$X a $Y" (rango de familia): no sirve
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(normalized);
    return isNaN(n) ? null : n;
  }
  function npNormalizeItemId(rawId) {
    if (rawId == null) return null;
    const bare = String(rawId).replace(/^#/, '').trim();
    if (!/^\d+$/.test(bare)) return null;
    return 'MLA' + bare;
  }
  function npFindAllWithKeys(obj, keys) {
    const out = [];
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (keys.every(k => Object.prototype.hasOwnProperty.call(o, k))) out.push(o);
      for (const k in o) walk(o[k]);
    })(obj);
    return out;
  }
  function npFindBoxesMatching(json, regex) {
    const out = [];
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o.columns)) {
        const col0 = o.columns[0];
        if (col0 && Array.isArray(col0.lines)) {
          const matches = col0.lines.some(l => {
            const c = l && l.primaryText && l.primaryText.content;
            return typeof c === 'string' && regex.test(c);
          });
          if (matches) out.push(o);
        }
      }
      for (const k in o) walk(o[k]);
    })(json);
    return out;
  }
  function npGetDateLineText(col0) {
    if (!col0 || !Array.isArray(col0.lines)) return null;
    for (const l of col0.lines) {
      const pt = l && l.primaryText;
      if (pt && pt.color === 'gray' && typeof pt.content === 'string') return pt.content;
    }
    return null;
  }
  function npExtractBoxInfo(box) {
    const info = { estado: null, nombre: null, fechas: null, aportePropio: null, aporteML: null, precioFinal: null, recibis: null };
    const col0 = box.columns && box.columns[0];
    if (col0 && Array.isArray(col0.lines)) {
      for (const l of col0.lines) {
        const c = l && l.primaryText && l.primaryText.content;
        if (typeof c !== 'string') continue;
        const cUpper = c.trim().toUpperCase();
        if (NP_STATUS_LABELS.includes(cUpper)) info.estado = cUpper;
        else if (c.trim() === '¡Nueva propuesta!') info.estado = info.estado || 'NUEVA_PROPUESTA';
      }
      const nombrePartes = col0.lines.filter(l => {
        const pt = l && l.primaryText;
        if (!pt || typeof pt.content !== 'string') return false;
        if (pt.color === 'gray') return false;
        const cUpper = pt.content.trim().toUpperCase();
        if (NP_STATUS_LABELS.includes(cUpper)) return false;
        if (pt.content.trim() === '¡Nueva propuesta!') return false;
        return true;
      }).map(l => l.primaryText.content.trim());
      info.nombre = nombrePartes.join(' - ') || null;
      info.fechas = npGetDateLineText(col0);
    }
    const col1 = box.columns && box.columns[1];
    if (col1 && Array.isArray(col1.lines)) {
      for (const l of col1.lines) {
        const prim = l && l.primaryText && l.primaryText.content;
        const sec = l && l.secondaryText && l.secondaryText.content;
        if (typeof sec === 'string' && /mercado libre/i.test(sec)) info.aporteML = npParseMoney(prim);
        else if (info.aportePropio == null) info.aportePropio = npParseMoney(prim);
      }
    }
    function readMoneyColumn(col) {
      if (!col || !Array.isArray(col.lines)) return null;
      for (const l of col.lines) {
        const plain = l && l.primaryText && l.primaryText.content;
        if (typeof plain === 'string' && /\d/.test(plain)) {
          const v = npParseMoney(plain);
          if (v != null) return v;
        }
      }
      for (const l of col.lines) {
        if (l && l.type === 'charges' && l.totalCharges && l.totalCharges.value != null) {
          const v = npParseMoney(l.totalCharges.value);
          if (v != null) return v;
        }
      }
      return null;
    }
    // El detalle de costos real (Precio/Cargo por vender/Costo por unidad
    // vendida/Envío/Impuestos) que ML muestra en el tooltip ⓘ al lado de
    // "Recibís" -- lo guardamos tal cual viene, sin inventar ningún campo.
    function readChargesDetail(col) {
      if (!col || !Array.isArray(col.lines)) return null;
      for (const l of col.lines) {
        if (l && l.type === 'charges' && l.totalCharges && l.totalCharges.detail) return l.totalCharges.detail;
      }
      return null;
    }
    info.precioFinal = readMoneyColumn(box.columns && box.columns[2]);
    info.recibis = readMoneyColumn(box.columns && box.columns[3]);
    info.recibisDetalle = readChargesDetail(box.columns && box.columns[3]);
    // El botón real de acción (Participar/Mejorar/Modificar) -- puede estar
    // en cualquier columna (normalmente la última). Lo guardamos completo
    // (itemId, actionType, urlCallback) porque es justo lo que hace falta
    // para pedirle a Mercado Libre el modal real de confirmación -- nunca
    // inventamos su forma, es la que ML mismo manda en el JSON.
    info.button = null;
    if (Array.isArray(box.columns)) {
      for (const col of box.columns) {
        if (!col || !Array.isArray(col.lines)) continue;
        for (const l of col.lines) {
          if (l && l.type === 'button' && l.button) { info.button = l.button; break; }
        }
        if (info.button) break;
      }
    }
    return info;
  }
  function npEsFlashDeUnDia(info) {
    const f = info.fechas && info.fechas.trim();
    if (!f) return false;
    return /^\d{1,2}\s*\/\s*[a-záéíóúñ]+\.?$/i.test(f) && !/\bal\b/i.test(f);
  }
  function npProcessRowGroup(groupJson) {
    const rowInfos = npFindAllWithKeys(groupJson, ['extraInfo', 'id', 'title']);
    if (!rowInfos.length) return null;
    const rowInfo = rowInfos[0];
    const cuotas = (rowInfo.extraInfo || '').trim();
    if (cuotas !== 'Sin cuotas') return null;
    const itemId = npNormalizeItemId(rowInfo.id);
    if (!itemId) return null;
    const allStatusBoxes = npFindBoxesMatching(groupJson, /^ACTIVA$|^PROGRAMADA$|^PAUSADA$|^FINALIZADA$/i).map(npExtractBoxInfo);
    const validStatusBoxes = allStatusBoxes.filter(info => !npEsFlashDeUnDia(info));
    const tieneActivaOProgramada = validStatusBoxes.some(b => b.estado === 'ACTIVA' || b.estado === 'PROGRAMADA');
    if (!tieneActivaOProgramada) return null;
    const nuevaBoxesRaw = npFindBoxesMatching(groupJson, /Nueva propuesta/i);
    const nuevaBoxes = nuevaBoxesRaw.map(npExtractBoxInfo).filter(b => b.aporteML != null);
    if (!nuevaBoxes.length) return null;
    const activaCandidates = validStatusBoxes.filter(b => b.estado === 'ACTIVA');
    const programadaCandidates = validStatusBoxes.filter(b => b.estado === 'PROGRAMADA');
    const activa = activaCandidates[0] || programadaCandidates[0] || null;
    const rows = [];
    for (const nb of nuevaBoxes) {
      if (!activa || activa.precioFinal == null || activa.recibis == null || nb.precioFinal == null || nb.recibis == null) continue;
      const okPrecio = nb.precioFinal <= activa.precioFinal + NP_MAX_DIFF_PRECIO_FINAL;
      const okRecibis = nb.recibis >= activa.recibis - NP_MAX_CAIDA_RECIBIS;
      if (!(okPrecio && okRecibis)) continue;
      rows.push({
        id: itemId,
        title: rowInfo.title || '',
        // Estos 4 campos ya venían en el mismo JSON que ya pedíamos (el de
        // items/refresh) -- tu script original nunca los leía, pero están
        // ahí: son los mismos que Mercado Libre usa para pintar la fila real
        // en Promociones. Nada inventado.
        foto: (Array.isArray(rowInfo.pictures) && rowInfo.pictures[0]) ? rowInfo.pictures[0].replace(/^http:/, 'https:') : null,
        precioLista: rowInfo.price || null,
        deposito: rowInfo.info || null,
        envio: rowInfo.shippingInfo || null,
        promoNombre: nb.nombre || '',
        fechas: nb.fechas || '',
        aportePropio: nb.aportePropio,
        aporteML: nb.aporteML,
        precioFinal: nb.precioFinal,
        recibis: nb.recibis,
        recibisDetalle: nb.recibisDetalle || null,
        // Botón real de "Participar" tal cual lo manda ML (itemId,
        // actionType, urlCallback) -- lo necesitamos para pedir el modal de
        // confirmación real. Si por algún motivo esta caja puntual no trae
        // botón, la fila se muestra igual pero sin la opción de confirmar
        // desde acá (nunca inventamos un botón que no vino en el JSON).
        boton: nb.button || null,
        // ML no nos da (ni tu script original navega a) un link puntual a
        // esta caja específica — te llevamos al Centro de Promociones real
        // en vez de inventar un filtro que capaz no funciona.
        link: 'https://www.mercadolibre.com.ar/publicaciones/listado/promos/',
      });
    }
    return rows.length ? rows : null;
  }
  function npGetRowGroups(json) {
    return npFindAllWithKeys(json, ['id', 'bricks']).filter(o => typeof o.id === 'string' && o.id.indexOf('row_group-') === 0);
  }
  function npGetPaginationTotal(json) {
    const pag = npFindAllWithKeys(json, ['total', 'offset', 'limit']);
    if (pag.length && typeof pag[0].total === 'number') return pag[0].total;
    return null;
  }
  function npFetchPage(page) {
    const url = '/publicaciones/listado/promos/api/items/refresh?viewId=promos&search=&filters=&sort=&page=' + page;
    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': npGetCsrfToken() },
    }).then(r => (r.ok ? r.json() : null));
  }

  // ---- Confirmar una "Nueva propuesta" desde acá mismo (v0.7) ----
  // Esta es la MISMA secuencia de 2 pasos que hace la propia pantalla de
  // Mercado Libre cuando tocás "Participar"/"Mejorar" y después "Confirmar"
  // en el modal -- reconstruida a partir de un HAR real que grabaste vos
  // (no inventada): 1) pedimos el modal real con los datos actualizados
  // (precio, recibís, firma), 2) sólo si el usuario confirma explícitamente
  // acá, mandamos la confirmación con esos mismos datos tal cual vinieron.
  // Pedir el modal es de solo lectura (no une nada todavía); el paso que
  // realmente une la promoción es npConfirmModal.
  function npFetchModal(boton) {
    if (!boton || !boton.urlCallback) return Promise.resolve(null);
    return fetch('/publicaciones/listado/promos/api/modal-ondemand', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': npGetCsrfToken() },
      body: JSON.stringify({ urlCallback: boton.urlCallback, itemId: boton.itemId, viewId: 'promos', actionType: boton.actionType }),
    }).then(r => (r.ok ? r.json() : null)).then(json => (json && json.data && json.data.data) ? json.data.data : null);
  }
  // Arma el body real de confirm-from-modal a partir de la respuesta de
  // npFetchModal, tal cual lo arma la propia pantalla de ML (verificado
  // contra un HAR real: resource_elements = defaultParams + los 6 campos
  // fijos de abajo, tomados literal del ejemplo capturado). Función pura,
  // sin red, para poder testearla sin pegarle a Mercado Libre.
  function npBuildConfirmBody(modalData) {
    if (!modalData || !modalData.defaultParams) return null;
    const finalPriceValue = modalData.finalPrice && modalData.finalPrice.value != null ? modalData.finalPrice.value : null;
    return {
      resource_elements: Object.assign({}, modalData.defaultParams, {
        pricePercentage: null,
        pricePrimePercentage: null,
        pricePrime: null,
        price: finalPriceValue,
        tycChecked: false,
        addItemToCampaignCheck: false,
        recoCampaignId: null,
      }),
      urlCallback: modalData.urlCallback,
      impersonalized: false,
      viewId: modalData.viewId,
      itemId: modalData.itemId,
      actionType: modalData.actionId,
    };
  }
  function npConfirmModal(modalData) {
    const body = npBuildConfirmBody(modalData);
    if (!body) return Promise.resolve({ ok: false, message: 'Faltan datos del modal, no se puede confirmar.' });
    return fetch('/publicaciones/listado/promos/api/confirm-from-modal', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': npGetCsrfToken() },
      body: JSON.stringify(body),
    }).then(r => r.json().then(json => ({ ok: r.ok, json })).catch(() => ({ ok: r.ok, json: null })))
      .then(({ ok, json }) => ({
        ok: ok && !!(json && json.data),
        message: (json && json.data && json.data.message) || (ok ? 'Listo.' : 'Mercado Libre rechazó la confirmación.'),
      }))
      .catch(err => ({ ok: false, message: 'Error de red: ' + (err && err.message || err) }));
  }
  // Recorre TODO el catálogo en Promos, página por página (igual que tu
  // script manual), con una pausa chica entre cada una para no verse como
  // un pico de tráfico raro. Es la tarea más pesada del poller, por eso
  // corre cada varias horas, no cada minuto.
  async function pollNuevaPropuesta() {
    const rows = [];
    let page = 1, totalPages = null;
    try {
      while (page <= 60) { // techo de seguridad (~1500 publicaciones)
        const json = await npFetchPage(page);
        if (!json) break;
        if (page === 1) {
          const total = npGetPaginationTotal(json);
          if (total != null) totalPages = Math.ceil(total / NP_PAGE_SIZE);
        }
        const groups = npGetRowGroups(json);
        if (!groups.length) break;
        groups.forEach(g => { const r = npProcessRowGroup(g); if (r) rows.push(...r); });
        if (totalPages && page >= totalPages) break;
        page++;
        await new Promise(res => setTimeout(res, 250 + Math.round(Math.random() * 250)));
      }
      live.buenasOfertasSinUnir = rows;
      saveLive();
    } catch (e) { /* nunca romper la página de ML por esto */ }
  }

  // Competidores nuevos detectados por ml-bot-competencia (proceso Python
  // aparte, corre en la PC) — ese bot escribe en el mismo documento de
  // Firestore que ya usamos para costos/history (campo "competenciaNuevos").
  // Acá SOLO lo leemos, nunca lo escribimos desde el panel, para no pisar
  // lo que el bot subió. Si CLOUD_CONFIG no está configurado, no hace nada.
  function pollCompetenciaExterna() {
    if (!Cloud.enabled()) return Promise.resolve();
    return Cloud.pull().then(cloud => {
      live.competenciaNuevosVendedores = (cloud && Array.isArray(cloud.competenciaNuevos)) ? cloud.competenciaNuevos : [];
      saveLive();
    }).catch(e => console.warn('[Copiloto] no se pudo leer competenciaNuevos de la nube:', e && e.message));
  }

  // Cada tarea tiene su propio intervalo — las livianas (Resumen) se piden
  // seguido, las pesadas (páginas HTML completas) unas pocas veces por día.
  const POLL_TASKS = [
    { key: 'resumen', ms: 15 * 60 * 1000, run: pollResumen },
    { key: 'publicaciones', ms: 4 * 60 * 60 * 1000, run: pollPublicaciones },
    { key: 'full_stock', ms: 4 * 60 * 60 * 1000, run: pollFullStock },
    { key: 'promos', ms: 4 * 60 * 60 * 1000, run: pollPromos },
    { key: 'nueva_propuesta', ms: 4 * 60 * 60 * 1000, run: pollNuevaPropuesta },
    { key: 'ventas', ms: 6 * 60 * 60 * 1000, run: pollVentas },
    { key: 'reputacion', ms: 12 * 60 * 60 * 1000, run: pollReputacion },
    { key: 'competencia', ms: 12 * 60 * 60 * 1000, run: pollCompetencia },
    { key: 'competencia_externa', ms: 30 * 60 * 1000, run: pollCompetenciaExterna },
  ];

  function backgroundPollTick() {
    drainUpdateRowsQueue();
    for (let i = 0; i < POLL_TASKS.length; i++) {
      const t = POLL_TASKS[i];
      const last = Store.get('poll_' + t.key, 0);
      if (Date.now() - last >= t.ms) {
        Store.set('poll_' + t.key, Date.now());
        t.run();
        break; // una sola tarea pesada por tick — el resto espera al próximo minuto
      }
    }
  }

  // ======================================================================
  // 6. CALENDARIO COMERCIAL ARGENTINO + PALABRAS CLAVE POR CATEGORÍA
  //    (best-effort por título de publicación, ya que no tenemos category_id
  //    en los datos que capturamos — es una señal aproximada, no exacta)
  // ======================================================================
  const CALENDAR_2026 = [
    { name: 'Día del Niño', date: '2026-08-16', keywords: ['juguete', 'muñeca', 'infantil', 'niño', 'niña', 'juego'] },
    { name: 'Primavera / Día de la Madre', date: '2026-10-18', keywords: ['mama', 'madre', 'regalo', 'decoracion', 'jardin', 'plantas'] },
    { name: 'Hot Sale', date: '2026-05-11', keywords: [] },
    { name: 'CyberMonday', date: '2026-11-02', keywords: [] },
    { name: 'Navidad', date: '2026-12-25', keywords: ['navidad', 'decoracion', 'luces', 'arbol', 'regalo'] },
    { name: 'Verano', date: '2026-12-01', keywords: ['pileta', 'playa', 'verano', 'calor', 'ventilador', 'termo'] },
    { name: 'Vuelta a clases', date: '2027-02-15', keywords: ['mochila', 'cartuchera', 'utiles', 'escolar'] },
  ];
  function upcomingCalendarAlerts(publicaciones) {
    const now = new Date();
    const alerts = [];
    CALENDAR_2026.forEach(ev => {
      const d = new Date(ev.date + 'T00:00:00');
      const days = Math.round((d - now) / 86400000);
      if (days >= 0 && days <= 30 && ev.keywords.length) {
        const matches = (publicaciones || []).filter(p => {
          const t = (p.title || '').toLowerCase();
          return ev.keywords.some(k => t.indexOf(k) !== -1);
        });
        if (matches.length) alerts.push({ event: ev.name, days, count: matches.length, items: matches.slice(0, 8) });
      }
    });
    return alerts;
  }

  // ======================================================================
  // 7. DETECCIONES ACTIVAS
  // ======================================================================
  const OPORTUNIDAD_LABELS = { COMPETITIVENESS: 'Competitividad de precio', EXHIBITION: 'Exhibición', STOCK: 'Publicaciones con problema de stock' };

  function computeDetections() {
    const out = {};

    // -- Stock crítico Full --
    const fs = (live.fullStock && live.fullStock.products) || [];
    out.stockCritical = fs.filter(p => p.riskRank <= 2);

    // -- Elegible para campaña y sin oferta activa --
    // cruza tareas ACTION_REQUIRED tipo STOCK/EXHIBITION/COMPETITIVENESS
    // (candidatas totales) contra las que ya tienen oferta (done).
    out.oportunidadesSinUsar = (live.tasksAndRecos || []).map(t => ({
      subtype: t.subtype, done: t.progress.done, total: t.progress.total,
      sinUsar: Math.max(0, t.progress.total - t.progress.done),
      // ML no nos da un link puntual a esa tarea específica en los datos
      // que capturamos — te llevamos al Centro de Promociones (real,
      // verificado) en vez de inventar un filtro que capaz no funciona.
      link: 'https://www.mercadolibre.com.ar/publicaciones/listado/promos/',
    })).filter(t => t.sinUsar > 0);

    // -- Nueva propuesta sin unir (portado de tu script de escaneo real) --
    // Cada fila ya viene con toda la info que vos verías en Promociones
    // (título, nombre de la promo, fechas, aporte propio, aporte ML,
    // precio final, recibís) — no resumimos ni recortamos nada acá.
    out.buenasOfertasSinUnir = live.buenasOfertasSinUnir || [];

    // -- Calendario comercial cruzado con catálogo --
    out.calendario = upcomingCalendarAlerts(live.publicaciones);

    // -- Margen real (necesita costo cargado por el usuario) --
    // OJO: usamos "earnings" (lo que ML ya calcula que te queda neto, DESPUÉS
    // de su comisión) en vez del precio de venta bruto — restar tu costo
    // contra el precio de lista te mentía el margen por la comisión de ML.
    // Si todavía no tenemos earnings para esa publicación (falta que la
    // cola de update-rows la traiga), usamos el precio bruto como aproximación
    // y lo marcamos como tal para no mostrar un número falso con cara de exacto.
    const costs = Store.get('costs', {});
    out.margenReal = (live.publicaciones || []).map(p => {
      const cost = costs[p.familyId];
      if (cost === undefined || cost === null) return null;
      const price = parseAR(p.price);
      const metrics = (live.publicacionesMetrics || {})[p.familyId];
      const earnings = metrics ? parseAR(metrics.earnings) : null;
      if (price === null) return null;
      const base = earnings != null ? earnings : price;
      const esNeto = earnings != null;
      const margenBruto = base - cost;
      const margenPct = base ? (margenBruto / base * 100) : null;
      return { id: p.id, title: p.title, familyId: p.familyId, link: p.link, foto: p.foto || null, price, cost, earnings, margenBruto, margenPct, esNeto };
    }).filter(Boolean);

    // -- Competencia (posición en tu categoría + brechas contra el rival
    //    más cercano, ya calculadas por ML — nosotros solo las cruzamos y
    //    filtramos las que de verdad importan) --
    out.competencia = {
      ranking: live.competenciaRanking || null,
      gaps: (live.competenciaGaps || []).filter(g => g.requiresImprovement),
      headToHead: live.competenciaHeadToHead || null,
      // Publicaciones donde ml-bot-competencia detectó un vendedor nuevo
      // (más reciente primero) — viene de Firestore, no de scans de ML.
      nuevosVendedores: (live.competenciaNuevosVendedores || [])
        .slice()
        .sort((a, b) => String((b && b.detectadoEn) || '').localeCompare(String((a && a.detectadoEn) || ''))),
    };

    // -- Tendencia propia (necesita >= 7 días de historial) --
    const hist = Store.get('history', []) || [];
    const withSales = hist.filter(h => h.sales7dAmount != null);
    if (withSales.length >= 2) {
      const first = withSales[0], lastH = withSales[withSales.length - 1];
      out.tendenciaPropia = { desde: first.date, hasta: lastH.date, puntos: withSales.length, primero: first.sales7dAmount, ultimo: lastH.sales7dAmount };
    } else {
      out.tendenciaPropia = { puntos: withSales.length, faltan: Math.max(0, 7 - withSales.length) };
    }

    return out;
  }

  // Junta lo más urgente de TODAS las categorías en una sola lista rankeada
  // — así arriba de todo mostramos 5-6 cosas accionables (con link real a
  // donde corresponde resolverlas) en vez de 7 secciones completas todas
  // abiertas al mismo tiempo.
  function buildPriorities(d) {
    const items = [];

    (d.stockCritical || []).forEach(p => {
      items.push({
        sev: p.riskRank === 0 ? 100 : Math.max(60, 95 - p.riskRank * 8),
        cls: 'critical',
        label: (p.title || 'Producto').slice(0, 54),
        sub: p.timeToSellOut || 'Stock crítico en Full',
        link: p.link,
        foto: p.foto || null,
      });
    });

    if (d.competencia.ranking && d.competencia.ranking.trend === 'negative') {
      items.push({
        sev: 85,
        cls: 'critical',
        label: 'Bajaste ' + d.competencia.ranking.change + ' puesto(s) en tu categoría',
        sub: 'Posición #' + d.competencia.ranking.position + ' · vs. el período anterior',
        link: null,
      });
    }

    (d.competencia.gaps || []).forEach(g => {
      items.push({
        sev: 55,
        cls: 'opp',
        label: g.name + ': vos ' + g.pctYo + ' vs. ' + g.pctCompetidor + ' tu competencia',
        sub: g.recomendacion || 'Por debajo de tu competencia directa',
        link: g.link,
      });
    });

    if ((d.competencia.nuevosVendedores || []).length) {
      const n0 = d.competencia.nuevosVendedores[0];
      items.push({
        sev: 60,
        cls: 'critical',
        label: d.competencia.nuevosVendedores.length + ' publicación(es) con competidor nuevo',
        sub: (n0 && n0.titulo) ? ('Última: ' + n0.titulo.slice(0, 46)) : 'Detectado por el bot de competencia',
        link: n0 ? n0.link : null,
      });
    }

    (d.oportunidadesSinUsar || []).forEach(o => {
      const ratio = o.total ? o.sinUsar / o.total : 0;
      items.push({
        sev: 35 + Math.round(ratio * 30),
        cls: 'opp',
        label: (OPORTUNIDAD_LABELS[o.subtype] || o.subtype) + ': ' + o.sinUsar + ' sin resolver',
        sub: 'de ' + o.total + ' candidatas totales',
        link: o.link,
      });
    });

    if ((d.buenasOfertasSinUnir || []).length) {
      items.push({
        sev: 45,
        cls: 'opp',
        label: d.buenasOfertasSinUnir.length + ' nueva(s) propuesta(s) de promoción sin unir',
        sub: 'Mejoran o igualan tu oferta activa — mirá el detalle abajo',
        link: 'https://www.mercadolibre.com.ar/publicaciones/listado/promos/',
      });
    }

    (d.calendario || []).forEach(c => {
      items.push({
        sev: Math.max(15, 70 - c.days * 2),
        cls: 'cal',
        label: c.event + ' — en ' + c.days + ' días',
        sub: c.count + ' publicaciones tuyas podrían aprovecharlo',
        link: (c.items[0] || {}).link || null,
      });
    });

    (d.margenReal || []).filter(m => m.margenPct != null && m.margenPct < 15).forEach(m => {
      items.push({
        sev: m.margenPct < 0 ? 80 : 45,
        cls: 'critical',
        label: (m.title || 'Publicación').slice(0, 48) + ': margen ' + m.margenPct.toFixed(0) + '%',
        sub: m.esNeto ? 'Neto de la comisión de ML' : 'Estimado (todavía sin datos de earnings)',
        link: m.link,
        foto: m.foto || null,
      });
    });

    items.sort((a, b) => b.sev - a.sev);
    return items.slice(0, 6);
  }

  // ======================================================================
  // 8. PANEL — en vez de un botón flotante con estética propia, el
  //    copiloto se suma como un ítem más del menú lateral real de ML
  //    (mismas clases CSS que usa "Resumen", "Publicaciones", etc., así
  //    que hereda automáticamente la tipografía, colores e íconos reales
  //    de Mercado Libre sin que nosotros los tengamos que inventar) y el
  //    panel se abre como si fuera una pantalla más, ocupando el mismo
  //    lugar donde ML pinta el contenido de cada sección.
  // ======================================================================
  let shadowRoot, panelBody, panelEl, badgeCountEl;

  // Reutilizamos el Shadow DOM sólo para el contenido del panel (así nuestro
  // propio CSS no choca con el de ML), pero con la paleta y tipografía
  // reales de Mercado Libre (Andes / Proxima Nova) en vez de un tema propio.
  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; }
    .overlay {
      position: fixed; z-index: 2147483000; background: #f5f5f5; color: #333333;
      overflow-y: auto; display: none; font-size: 13px; border-left: 1px solid #e6e6e6;
    }
    .overlay.open { display: block; }
    .phead {
      padding: 18px 24px; background: #fff; border-bottom: 1px solid #e6e6e6;
      position: sticky; top: 0; z-index: 2; display: flex; align-items: flex-start; justify-content: space-between;
    }
    .phead h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; color: #333333; }
    .phead .sub { font-size: 13px; color: #999999; }
    .pclose {
      background: none; border: none; cursor: pointer; color: #999999; font-size: 20px; line-height: 1;
      padding: 4px 6px; border-radius: 4px;
    }
    .pclose:hover { background: #f0f0f0; color: #333333; }
    .pbody { padding: 20px 24px 48px; max-width: 760px; }
    .sec {
      margin-bottom: 18px; background: #fff; border: 1px solid #e6e6e6; border-radius: 6px;
      padding: 16px 18px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);
    }
    .sec h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #999999; margin: 0 0 12px; font-weight: 600; }
    .alert { border-left: 4px solid #cccccc; background: #fafafa; border-radius: 4px; padding: 10px 12px; margin-bottom: 8px; font-size: 13px; line-height: 1.45; }
    .alert.critical { border-left-color: #f23d4f; }
    .alert.opp { border-left-color: #3483fa; }
    .alert.cal { border-left-color: #ffb100; }
    .alert b { display: block; margin-bottom: 3px; color: #333333; }
    .kpi-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
    .kpi-row:last-child { border-bottom: none; }
    .kpi-row .v { font-weight: 600; color: #333333; }
    .empty { color: #999999; font-size: 13px; }
    .cost-input { width: 70px; font-size: 12px; padding: 4px 6px; border: 1px solid #cccccc; border-radius: 4px; }
    a.link { color: #3483fa; text-decoration: none; }
    .np-btn-preview, .np-btn-confirm, .np-btn-cancel { border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; background: #3483fa; color: #ffffff; }
    .np-btn-cancel, .secondary.np-btn-preview { background: #eeeeee; color: #333333; }

    .prio-list { margin-bottom: 20px; }
    .prio-item {
      display: flex; align-items: flex-start; gap: 10px; background: #fff; border: 1px solid #e6e6e6;
      border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; text-decoration: none; color: inherit;
      box-shadow: 0 1px 2px rgba(0,0,0,0.03);
    }
    a.prio-item { cursor: pointer; }
    a.prio-item:hover { border-color: #3483fa; box-shadow: 0 1px 6px rgba(52,131,250,0.18); }
    .item-photo, .prio-photo {
      object-fit: contain; border: 1px solid #eee; border-radius: 4px; flex: none; background: #fff;
    }
    .item-photo { width: 48px; height: 48px; }
    .prio-photo { width: 32px; height: 32px; margin-top: 1px; }
    .item-photo-empty, .prio-photo-empty { background: #f5f5f5; }
    .prio-photo.critical { border-color: #f23d4f; }
    .prio-photo.opp { border-color: #3483fa; }
    .prio-photo.cal { border-color: #ffb100; }
    /* Fila con foto real + texto, para usar DENTRO de .alert (conserva el
       borde de color y el fondo que ya distinguen critical/opp/cal) en vez
       de una línea de texto suelta -- misma idea que ya usa "Nueva
       propuesta sin unir" para publicaciones individuales. */
    .alert-media { display: flex; gap: 10px; align-items: flex-start; }
    .alert-media .item-body { flex: 1; min-width: 0; }
    .alert-media .item-title { display: block; font-size: 13px; color: #333333; font-weight: 600; margin-bottom: 0; }
    .alert-media .item-sub { display: block; font-size: 12px; color: #999999; margin-top: 2px; }
    .prio-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; }
    .prio-dot.critical { background: #f23d4f; }
    .prio-dot.opp { background: #3483fa; }
    .prio-dot.cal { background: #ffb100; }
    .prio-text { flex: 1; min-width: 0; }
    .prio-text b { display: block; font-size: 13px; color: #333333; font-weight: 600; }
    .prio-text .sub { font-size: 12px; color: #999999; margin-top: 1px; }
    .prio-chev { color: #3483fa; font-size: 16px; flex: none; align-self: center; }
    .prio-empty { color: #999999; font-size: 13px; padding: 4px 0 0; }

    details.sec { padding: 0; overflow: hidden; }
    details.sec summary {
      list-style: none; cursor: pointer; padding: 14px 18px; font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.04em; color: #999999; font-weight: 600; display: flex; justify-content: space-between; align-items: center;
    }
    details.sec summary::-webkit-details-marker { display: none; }
    details.sec summary::after { content: '›'; font-size: 16px; transform: rotate(90deg); transition: transform .15s; color: #999999; }
    details.sec[open] summary::after { transform: rotate(270deg); }
    details.sec summary:hover { color: #3483fa; }
    details.sec .dbody { padding: 0 18px 16px; }
    .row-link { color: inherit; text-decoration: none; display: block; }
    .row-link:hover .kpi-row, .row-link:hover .alert { border-color: #3483fa; }
    .alert.linked { cursor: pointer; }
  `;

  // Ícono simple (rayo) para el ítem del menú — mismo tamaño (20x20) y
  // mismo estilo de trazo que los íconos que ya usa Mercado Libre al lado.
  const SIDEBAR_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.24 1.68a.75.75 0 0 1 .397.9L9.98 8.25h4.77a.75.75 0 0 1 .58 1.226l-7.5 9.166a.75.75 0 0 1-1.318-.642L8.19 11.75H3.75a.75.75 0 0 1-.59-1.212l7.13-9a.75.75 0 0 1 .95-.108" fill="#000"></path></svg>';

  function ensurePanel() {
    if (shadowRoot) return;
    const host = document.createElement('div');
    host.id = 'levys-copilot-host';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadowRoot.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="phead"><div><h1>Copiloto</h1><div class="sub">Levys Bazar &middot; se actualiza solo, mientras ten&eacute;s ML abierto</div></div><button type="button" class="pclose" aria-label="Cerrar">&times;</button></div>' +
      '<div class="pbody"></div>';
    shadowRoot.appendChild(overlay);
    panelBody = overlay.querySelector('.pbody');
    panelEl = overlay;

    overlay.querySelector('.pclose').addEventListener('click', () => togglePanel(false));
    window.addEventListener('resize', positionOverlay);
  }

  // El panel se posiciona exactamente donde ML pinta el contenido de cada
  // sección (a la derecha del menú lateral real) — así se siente "una
  // pantalla más" en vez de una ventana flotando encima de todo.
  function positionOverlay() {
    if (!panelEl) return;
    const contentEl = document.querySelector('.nav-sidebar-page__content') || document.getElementById('root-app');
    if (contentEl) {
      const r = contentEl.getBoundingClientRect();
      panelEl.style.top = Math.max(0, r.top) + 'px';
      panelEl.style.left = Math.max(0, r.left) + 'px';
    } else {
      // fallback conservador si por algún motivo no encontramos el layout de ML
      panelEl.style.top = '0px';
      panelEl.style.left = '240px';
    }
    panelEl.style.right = '0px';
    panelEl.style.bottom = '0px';
  }

  function togglePanel(force) {
    ensurePanel();
    positionOverlay();
    const willOpen = force !== undefined ? force : !panelEl.classList.contains('open');
    panelEl.classList.toggle('open', willOpen);
    if (willOpen) render();
  }

  // Arma el <li> del menú lateral con las MISMAS clases que usa ML para
  // "Resumen", "Publicaciones", etc. — así hereda su tipografía, color e
  // interacción (hover, foco) reales en vez de que nosotros la inventemos.
  function buildSidebarItem() {
    const li = document.createElement('li');
    li.className = 'nav-sidebar__section';
    li.id = 'levys-copilot-sidebar-item';
    li.innerHTML =
      '<div class="nav-sidebar__section-container" data-section-id="LEVYS_COPILOTO">' +
        '<a href="#" tabindex="0" class="nav-sidebar__section-heading" data-section-id="LEVYS_COPILOTO">' +
          '<div class="nav-sidebar__section-icon-container" style="position:relative">' +
            '<span class="nav-sidebar__section-icon" data-tooltip="Copiloto">' + SIDEBAR_ICON_SVG + '</span>' +
            '<span class="levys-copilot-badge" style="display:none;position:absolute;top:-2px;right:-6px;background:#f23d4f;color:#fff;border-radius:999px;font-size:9px;min-width:14px;height:14px;line-height:14px;text-align:center;font-weight:700;">0</span>' +
          '</div>' +
          '<div class="nav-sidebar__section-text-container"><p class="nav-sidebar__section-title">Copiloto</p></div>' +
        '</a>' +
      '</div>';
    li.querySelector('a').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    return li;
  }

  // Devuelve true si el ítem ya está insertado (o se acaba de insertar).
  function ensureSidebarEntry() {
    if (document.getElementById('levys-copilot-sidebar-item')) return true;
    const group = document.querySelector('.nav-sidebar__section-group');
    if (!group) return false;
    const item = buildSidebarItem();
    const summaryHeading = group.querySelector('[data-section-id="SUMMARY"]');
    const summarySection = summaryHeading ? summaryHeading.closest('li.nav-sidebar__section') : null;
    if (summarySection && summarySection.parentNode === group) {
      summarySection.insertAdjacentElement('afterend', item);
    } else {
      group.appendChild(item);
    }
    badgeCountEl = item.querySelector('.levys-copilot-badge');
    return true;
  }

  // El menú lateral de ML a veces todavía no está en el DOM cuando corremos
  // (document-start) — reintentamos unas cuantas veces con espera corta en
  // vez de fallar silenciosamente.
  let sidebarRetries = 0;
  function trySidebarInsert() {
    if (ensureSidebarEntry()) return;
    if (sidebarRetries++ < 20) setTimeout(trySidebarInsert, 700);
  }

  function esc(s) { return s === undefined || s === null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // Envuelve una fila en <a> con link real si lo tenemos; si no, la deja
  // como texto plano — nunca inventamos un href.
  function maybeLink(url, innerHtml, cls) {
    if (url) return '<a class="' + (cls || 'row-link') + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + innerHtml + '</a>';
    return innerHtml;
  }

  // Foto real de la publicación (o un placeholder gris del mismo tamaño si
  // no la tenemos) — mismo patrón en todas las listas de publicaciones del
  // panel (Nueva propuesta, Stock crítico, Margen real, Prioridades), para
  // que se vea como una publicación real de ML y no como una línea de texto
  // suelta. 'item' = 48px (fila normal), 'prio' = 32px (tarjeta compacta).
  function photoHtml(url, size, extraCls) {
    const cls = (size === 'prio' ? 'prio-photo' : 'item-photo') + (extraCls ? ' ' + extraCls : '');
    return url
      ? '<img src="' + esc(url) + '" alt="" class="' + cls + '" />'
      : '<div class="' + cls + ' ' + (size === 'prio' ? 'prio-photo' : 'item-photo') + '-empty"></div>';
  }

  // Arma el HTML del área de acción de una fila de "Nueva propuesta sin
  // unir", según en qué paso está su vista previa/confirmación (npPreview).
  // Nunca dispara nada solo -- siempre requiere el click explícito del
  // usuario en cada paso (Ver y confirmar → Confirmar), igual que la
  // pantalla real de Mercado Libre.
  function npRenderAccion(o, st) {
    const fmtMoney = v => (v == null ? '—' : (typeof v === 'string' ? v : '$' + Math.round(v).toLocaleString('es-AR')));
    if (st.estado === 'ok') {
      return '<div style="color:#0ca30c;font-size:12px">&#10003; ' + esc(st.mensaje || 'Confirmado en Mercado Libre.') + ' (se termina de sacar de esta lista en el próximo escaneo)</div>';
    }
    if (st.estado === 'cargando') {
      return '<div class="empty" style="margin:0">Pidiendo los datos reales a Mercado Libre…</div>';
    }
    if (st.estado === 'confirmando') {
      return '<div class="empty" style="margin:0">Confirmando con Mercado Libre…</div>';
    }
    if (st.estado === 'preview' && st.modal) {
      const m = st.modal;
      let h = '<div style="background:#f6f6fa;border-radius:6px;padding:8px 10px;font-size:12px">';
      h += '<div style="font-weight:600;margin-bottom:4px">' + esc(m.title || 'Confirmá los detalles de la promoción') + '</div>';
      h += '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:6px">';
      if (m.originalPrice) h += '<span>Precio original: <b>' + esc(m.originalPrice.formattedValue || fmtMoney(m.originalPrice.value)) + '</b></span>';
      if (m.finalPrice) h += '<span>Precio final: <b>' + fmtMoney(m.finalPrice.value) + '</b></span>';
      if (m.totalCharges) h += '<span>Recibís: <b>' + esc(m.totalCharges.value) + '</b></span>';
      h += '</div>';
      h += '<div style="color:#999;font-size:11px;margin-bottom:6px">Esto es lo que Mercado Libre te devolvió recién, en vivo — si algo no coincide con lo que esperabas, cancelá y no confirmes.</div>';
      h += '<button class="np-btn-confirm" data-np-id="' + esc(o.id) + '">Confirmar</button> ';
      h += '<button class="np-btn-cancel secondary" data-np-id="' + esc(o.id) + '">Cancelar</button>';
      h += '</div>';
      return h;
    }
    if (st.estado === 'error') {
      return '<div style="color:#d03b3b;font-size:12px;margin-bottom:6px">' + esc(st.mensaje || 'Algo falló.') + '</div>' +
        '<button class="np-btn-preview secondary" data-np-id="' + esc(o.id) + '">Reintentar</button>';
    }
    if (o.boton) {
      return '<button class="np-btn-preview" data-np-id="' + esc(o.id) + '">Ver y confirmar</button>';
    }
    return maybeLink(o.link, '<span style="color:#3483FA;font-size:12px">Confirmar en Mercado Libre →</span>');
  }

  function render() {
    ensurePanel();
    const d = computeDetections();
    const posicionBajo = d.competencia.ranking && d.competencia.ranking.trend === 'negative';
    let alertCount = d.stockCritical.length + d.oportunidadesSinUsar.length + d.calendario.length +
      d.competencia.gaps.length + (posicionBajo ? 1 : 0) + d.buenasOfertasSinUnir.length +
      d.competencia.nuevosVendedores.length;
    const priorities = buildPriorities(d);

    let html = '';

    // Prioridades — lo más urgente de TODAS las categorías, junto, rankeado,
    // clickeable (te lleva directo a donde se resuelve). Esto reemplaza
    // tener que leer 7 secciones completas para saber qué hacer primero.
    html += '<div class="prio-list"><h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#999;margin:0 0 10px;font-weight:600">Prioridades ahora</h2>';
    if (priorities.length) {
      priorities.forEach(p => {
        const tag = p.link ? 'a' : 'div';
        const attrs = p.link ? ' href="' + esc(p.link) + '" target="_blank" rel="noopener"' : '';
        html += '<' + tag + ' class="prio-item"' + attrs + '>' +
          (p.foto ? photoHtml(p.foto, 'prio', p.cls) : '<span class="prio-dot ' + p.cls + '"></span>') +
          '<span class="prio-text"><b>' + esc(p.label) + '</b><span class="sub">' + esc(p.sub) + '</span></span>' +
          (p.link ? '<span class="prio-chev">›</span>' : '') +
          '</' + tag + '>';
      });
    } else {
      html += '<div class="prio-empty">Sin alertas urgentes por ahora — o todavía se está terminando de cargar todo (puede tardar unos minutos la primera vez).</div>';
    }
    html += '</div>';

    // Stock crítico
    html += '<details class="sec" data-sec-key="stock_critico"><summary>Stock crítico en Full (' + d.stockCritical.length + ')</summary><div class="dbody">';
    if (d.stockCritical.length) {
      d.stockCritical.slice(0, 12).forEach(p => {
        html += maybeLink(p.link, '<div class="alert critical linked"><div class="alert-media">' +
          photoHtml(p.foto, 'item') +
          '<div class="item-body"><span class="item-title">' + esc((p.title || '').slice(0, 60)) + '</span>' +
          '<span class="item-sub">' + esc(p.timeToSellOut) + '</span></div>' +
          '</div></div>');
      });
      if (d.stockCritical.length > 12) html += '<div class="empty">+' + (d.stockCritical.length - 12) + ' más</div>';
    } else if (live.fullStock) {
      html += '<div class="empty">Sin datos críticos por ahora.</div>';
    } else {
      html += '<div class="empty">Se pide solo en segundo plano (podés esperar, o visitar Publicaciones &gt; Gestión de stock Full).</div>';
    }
    html += '</div></details>';

    // Oportunidades sin usar
    html += '<details class="sec" data-sec-key="oportunidades"><summary>Oportunidades sin usar (' + d.oportunidadesSinUsar.length + ')</summary><div class="dbody">';
    if (d.oportunidadesSinUsar.length) {
      d.oportunidadesSinUsar.forEach(o => {
        html += maybeLink(o.link, '<div class="alert opp linked">' + esc(OPORTUNIDAD_LABELS[o.subtype] || o.subtype) + ': ' + o.sinUsar + ' de ' + o.total + ' sin resolver</div>');
      });
    } else if (live.tasksAndRecos) {
      html += '<div class="empty">No hay tareas pendientes marcadas por ML.</div>';
    } else {
      html += '<div class="empty">Se pide solo en segundo plano (o visitá Publicaciones &gt; Promos).</div>';
    }
    html += '</div></details>';

    // Nueva propuesta sin unir — detalle completo por publicación, igual
    // que lo mostraría Mercado Libre en Promociones (foto, precio,
    // depósito, envío reales), con confirmación real en dos pasos desde
    // acá mismo (vista previa real de ML + un segundo click explícito).
    html += '<details class="sec" data-sec-key="nueva_propuesta"><summary>Nueva propuesta sin unir (' + d.buenasOfertasSinUnir.length + ')</summary><div class="dbody">';
    if (d.buenasOfertasSinUnir.length) {
      const fmtMoney = v => (v == null ? '—' : '$' + Math.round(v).toLocaleString('es-AR'));
      d.buenasOfertasSinUnir.forEach(o => {
        const st = npPreview[o.id] || { estado: 'idle' };
        html += '<div class="alert opp linked" style="display:block;padding:10px 12px">';
        html += '<div style="display:flex;gap:10px">';
        html += o.foto
          ? '<img src="' + esc(o.foto) + '" alt="" style="width:48px;height:48px;object-fit:contain;border:1px solid #eee;border-radius:4px;flex:none;background:#fff" />'
          : '<div style="width:48px;height:48px;border:1px solid #eee;border-radius:4px;flex:none;background:#f5f5f5"></div>';
        html += '<div style="flex:1;min-width:0">';
        html += maybeLink(o.link, '<b>' + esc((o.title || o.id || '').slice(0, 60)) + '</b>');
        html += '<div style="margin-top:2px;color:#777;font-size:11px">' + esc(o.id) +
          (o.precioLista ? ' · ' + esc(o.precioLista) : '') +
          (o.deposito ? ' · ' + esc(o.deposito) : '') +
          (o.envio ? ' · ' + esc(o.envio) : '') + '</div>';
        html += '<div style="margin-top:4px;color:#555;font-size:12px">' + esc(o.promoNombre || 'Nueva propuesta') + (o.fechas ? ' · ' + esc(o.fechas) : '') + '</div>';
        html += '</div></div>';
        html += '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#333">' +
          '<span>Aporte propio: <b>' + fmtMoney(o.aportePropio) + '</b></span>' +
          '<span>Aporte ML: <b>' + fmtMoney(o.aporteML) + '</b></span>' +
          '<span>Precio final: <b>' + fmtMoney(o.precioFinal) + '</b></span>' +
          '<span' + (o.recibisDetalle ? ' title="' + esc((o.recibisDetalle.costs || []).map(c => c.label + ': ' + c.value).join('\n')) + '"' : '') + '>Recibís: <b>' + fmtMoney(o.recibis) + (o.recibisDetalle ? ' ⓘ' : '') + '</b></span>' +
          '</div>';
        html += '<div class="np-action" style="margin-top:8px" data-np-id="' + esc(o.id) + '">' + npRenderAccion(o, st) + '</div>';
        html += '</div>';
      });
    } else if (live.buenasOfertasSinUnir) {
      html += '<div class="empty">No hay propuestas nuevas pendientes por ahora.</div>';
    } else {
      html += '<div class="empty">Se escanea solo en segundo plano cada varias horas (o visitá Publicaciones &gt; Promos).</div>';
    }
    html += '</div></details>';

    // Calendario comercial
    html += '<details class="sec" data-sec-key="calendario"><summary>Calendario comercial · 30 días (' + d.calendario.length + ')</summary><div class="dbody">';
    if (d.calendario.length) {
      d.calendario.forEach(c => {
        const link = (c.items[0] || {}).link || null;
        html += maybeLink(link, '<div class="alert cal linked">' + esc(c.event) + ' — en ' + c.days + ' días: ' + c.count + ' publicaciones podrían aprovecharlo</div>');
      });
    } else {
      html += '<div class="empty">Nada relevante en los próximos 30 días (o falta cargar publicaciones todavía).</div>';
    }
    html += '</div></details>';

    // Margen real (costo cargado a mano)
    html += '<details class="sec" data-sec-key="margen_real"><summary>Margen real</summary><div class="dbody">';
    if (live.publicaciones && live.publicaciones.length) {
      const costs = Store.get('costs', {});
      html += '<div class="empty" style="margin-bottom:8px">Cargá el costo una vez por producto. El % ya descuenta la comisión de ML cuando tenemos ese dato (si no, es estimado sobre precio bruto).</div>';
      live.publicaciones.slice(0, 12).forEach(p => {
        const cost = costs[p.familyId];
        const m = d.margenReal.find(x => x.familyId === p.familyId);
        const titleHtml = esc((p.title || '').slice(0, 34)) + (m && !m.esNeto ? ' <span style="color:#999">(estimado)</span>' : '');
        html += '<div class="kpi-row"><span style="display:flex;align-items:center;gap:8px;min-width:0">' +
          photoHtml(p.foto, 'prio') +
          '<span style="min-width:0">' + maybeLink(p.link, titleHtml) + '</span></span>' +
          '<span style="flex:none">$<input class="cost-input" type="number" min="0" step="1" data-fam="' + esc(p.familyId) + '" value="' + (cost !== undefined ? cost : '') + '" placeholder="costo" />' +
          (m ? ' <b style="color:' + (m.margenPct >= 0 ? '#0ca30c' : '#d03b3b') + '">' + m.margenPct.toFixed(0) + '%</b>' : '') +
          '</span></div>';
      });
    } else {
      html += '<div class="empty">Se pide solo en segundo plano (o visitá Publicaciones).</div>';
    }
    html += '</div></details>';

    // Tendencia propia
    html += '<details class="sec" data-sec-key="tendencia_propia"><summary>Tendencia propia</summary><div class="dbody">';
    if (d.tendenciaPropia.puntos >= 2) {
      const delta = d.tendenciaPropia.ultimo - d.tendenciaPropia.primero;
      const pct = d.tendenciaPropia.primero ? (delta / d.tendenciaPropia.primero * 100).toFixed(1) : '?';
      html += '<div class="kpi-row"><span>Ventas 7d, ' + esc(d.tendenciaPropia.desde) + ' &rarr; ' + esc(d.tendenciaPropia.hasta) + '</span><span class="v">' + (delta >= 0 ? '+' : '') + pct + '%</span></div>';
    } else {
      html += '<div class="empty">Acumulando historial &mdash; faltan ' + d.tendenciaPropia.faltan + ' días más con la pestaña abierta en ML.</div>';
    }
    html += '</div></details>';

    // Competencia
    html += '<details class="sec" data-sec-key="competencia"><summary>Competencia</summary><div class="dbody">';
    if (d.competencia.ranking) {
      const r = d.competencia.ranking;
      const arrow = r.trend === 'negative' ? '&#8595;' : (r.trend === 'positive' ? '&#8593;' : '&rarr;');
      html += '<div class="kpi-row"><span>Tu posición en la categoría</span><span class="v">#' + esc(r.position) + ' ' + arrow + '</span></div>';
      if (d.competencia.gaps.length) {
        html += '<div class="empty" style="margin:8px 0 6px">Por debajo de ' + esc(r.nearestCompetitorAlias || 'tu competencia directa') + ':</div>';
        d.competencia.gaps.forEach(g => {
          html += maybeLink(g.link, '<div class="alert opp linked">' + esc(g.name) + ': vos ' + esc(g.pctYo) + ' vs. ' + esc(g.pctCompetidor) + '</div>');
        });
      }
      if (d.competencia.headToHead && d.competencia.headToHead.competitor) {
        const h = d.competencia.headToHead;
        html += '<div class="kpi-row"><span>Ventas brutas (vos vs. ' + esc(h.competitor.alias) + ')</span><span class="v">' + esc(h.you.grossSales) + ' vs. ' + esc(h.competitor.grossSales) + '</span></div>';
      }
    } else {
      html += '<div class="empty">Se pide solo en segundo plano (unas pocas veces por día).</div>';
    }
    // Nuevos competidores detectados por ml-bot-competencia (proceso Python
    // aparte, en la PC) — vía Firestore, no vía scan de ML.
    if (d.competencia.nuevosVendedores.length) {
      html += '<div class="empty" style="margin:8px 0 6px">Nuevo competidor detectado (bot de competencia):</div>';
      d.competencia.nuevosVendedores.slice(0, 12).forEach(n => {
        const vendedoresTxt = (n.vendedores || [])
          .map(v => esc(v.nombre || 'Vendedor') + (v.precio ? ' a $' + esc(v.precio) : ''))
          .join(', ');
        const fecha = n.detectadoEn ? new Date(n.detectadoEn).toLocaleDateString('es-AR') : '';
        html += maybeLink(n.link, '<div class="alert critical linked">' + esc((n.titulo || n.itemId || 'Publicación').slice(0, 60)) + '</div>');
        if (vendedoresTxt || fecha) {
          html += '<div class="empty" style="margin:0 0 8px 4px">' + vendedoresTxt + (fecha ? (vendedoresTxt ? ' · ' : '') + fecha : '') + '</div>';
        }
      });
    } else if (Cloud.enabled()) {
      html += '<div class="empty" style="margin-top:8px">Sin competidores nuevos detectados por el bot, por ahora.</div>';
    }
    html += '</div></details>';

    // KPIs generales
    html += '<details class="sec" data-sec-key="numeros_hoy"><summary>Números de hoy</summary><div class="dbody">';
    if (live.resumenCards) {
      const rc = live.resumenCards;
      html += '<div class="kpi-row"><span>Ventas brutas 7d</span><span class="v">$' + esc(rc.sales7d.amount) + '</span></div>';
      html += '<div class="kpi-row"><span>Saldo a pagar</span><span class="v">$' + esc(rc.billing.balance) + '</span></div>';
    } else {
      html += '<div class="empty">Se pide solo cada 15 min.</div>';
    }
    html += '<div class="kpi-row"><span>Datos capturados</span><span class="v">' + (live.updatedAt ? new Date(live.updatedAt).toLocaleString('es-AR') : 'todavía ninguno') + '</span></div>';
    html += '</div></details>';

    // render() se llama seguido (cada minuto, y ahora también después de
    // cada paso de "Ver y confirmar"/"Confirmar") -- sin esto, cada
    // llamada reconstruía el HTML entero y te cerraba de nuevo cualquier
    // sección que hubieras abierto a mano. Guardamos qué secciones estaban
    // abiertas ANTES de tirar el HTML viejo, y las volvemos a abrir después.
    const openSecKeys = new Set(
      Array.from(panelBody.querySelectorAll('details.sec[open]')).map(d => d.getAttribute('data-sec-key')).filter(Boolean)
    );
    panelBody.innerHTML = html;
    panelBody.querySelectorAll('details.sec').forEach(d => {
      if (openSecKeys.has(d.getAttribute('data-sec-key'))) d.setAttribute('open', '');
    });

    panelBody.querySelectorAll('.cost-input').forEach(inp => {
      inp.addEventListener('change', () => {
        const fam = inp.getAttribute('data-fam');
        const val = parseFloat(inp.value);
        const costs = Store.get('costs', {});
        if (isNaN(val)) delete costs[fam]; else costs[fam] = val;
        Store.set('costs', costs);
        Cloud.pushCostos(costs);
        render();
      });
      inp.addEventListener('click', e => e.stopPropagation());
    });

    // Nueva propuesta sin unir: cada paso requiere un click explícito del
    // usuario (Ver y confirmar → Confirmar) -- nunca se dispara solo.
    panelBody.querySelectorAll('.np-btn-preview').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.getAttribute('data-np-id');
        const row = (live.buenasOfertasSinUnir || []).find(r => r.id === id);
        if (!row || !row.boton) return;
        npPreview[id] = { estado: 'cargando' };
        render();
        try {
          const modal = await npFetchModal(row.boton);
          npPreview[id] = modal
            ? { estado: 'preview', modal }
            : { estado: 'error', mensaje: 'Mercado Libre no devolvió los datos reales -- probá de nuevo en unos minutos.' };
        } catch (err) {
          npPreview[id] = { estado: 'error', mensaje: 'Error de red: ' + ((err && err.message) || err) };
        }
        render();
      });
    });
    panelBody.querySelectorAll('.np-btn-cancel').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        delete npPreview[btn.getAttribute('data-np-id')];
        render();
      });
    });
    panelBody.querySelectorAll('.np-btn-confirm').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.getAttribute('data-np-id');
        const st = npPreview[id];
        if (!st || st.estado !== 'preview') return;
        npPreview[id] = { estado: 'confirmando' };
        render();
        const result = await npConfirmModal(st.modal);
        npPreview[id] = result.ok
          ? { estado: 'ok', mensaje: result.message }
          : { estado: 'error', mensaje: result.message };
        render();
        // Si confirmó, actualizamos el escaneo real en segundo plano para
        // que la fila se termine de sacar de la lista con datos reales
        // (no la borramos nosotros a mano -- dejamos que el próximo
        // escaneo confirme que ML ya no la muestra como pendiente).
        if (result.ok) pollNuevaPropuesta().then(render);
      });
    });

    if (badgeCountEl) {
      if (alertCount > 0) { badgeCountEl.style.display = 'block'; badgeCountEl.textContent = alertCount > 99 ? '99+' : String(alertCount); }
      else { badgeCountEl.style.display = 'none'; }
    }
  }

  // ======================================================================
  // 9. BOOTSTRAP
  // ======================================================================
  function boot() {
    ensurePanel();
    trySidebarInsert();
    scanCurrentDocument();
    render();
    backgroundPollTick();
    setInterval(backgroundPollTick, 60 * 1000); // cada minuto: drena la cola y ve si hay alguna tarea vencida

    // Sincronización en la nube (si CLOUD_CONFIG está cargado): al
    // arrancar, traemos lo que haya en Firestore y lo combinamos con lo
    // local -- así si alguien más cargó un costo desde otra compu, lo ves
    // acá sin tener que cargarlo de nuevo. Si CLOUD_CONFIG está vacío,
    // Cloud.pull() resuelve null enseguida y esto no hace nada.
    if (Cloud.enabled()) {
      Cloud.pull().then(cloud => {
        const mergedCostos = mergeCostos(Store.get('costs', {}), (cloud && cloud.costos) || {});
        const mergedHistory = mergeHistory(Store.get('history', []), (cloud && cloud.history) || []);
        Store.set('costs', mergedCostos);
        Store.set('history', mergedHistory);
        Cloud.pushCostos(mergedCostos);
        Cloud.pushHistory(mergedHistory);
        render();
      }).catch(e => console.warn('[Copiloto] sync inicial con la nube falló (seguimos local):', e && e.message));
    }

    // Escape hatch manual: si por lo que sea sentís que algo quedó viejo,
    // abrí la consola del navegador (F12) y ejecutá
    // LevysCopiloto.refrescarTodo() para forzar que pida todo de nuevo ya
    // mismo, sin esperar a que venzan los intervalos normales.
    //
    // OJO: se asigna a unsafeWindow, no a window. Tampermonkey corre el
    // script en un sandbox aislado propio (porque usa @grant) -- "window"
    // ahí adentro NO es el mismo objeto que ve la consola real de la
    // página, así que si asignáramos a "window" a secas, esto quedaría
    // invisible para quien lo prueba desde F12. unsafeWindow sí apunta al
    // window real de la página (con los recaudos de seguridad de siempre:
    // acá no le pasamos nada que un script de la página pueda explotar,
    // solo funciones de lectura/diagnóstico).
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).LevysCopiloto = {
      estado: () => live,
      refrescarTodo: () => {
        POLL_TASKS.forEach(t => Store.set('poll_' + t.key, 0));
        backgroundPollTick();
        return 'Refrescando en segundo plano (una fuente por minuto, como siempre)...';
      },
      // No hace falta llamar esto nunca a mano -- es lo mismo que corre
      // solo cada 1 minuto. Queda expuesto por si algún día hace falta
      // diagnosticar por qué algo no se actualizó.
      tick: backgroundPollTick,
      // Diagnóstico de la sincronización en la nube.
      nube: () => ({ configurada: Cloud.enabled() }),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
