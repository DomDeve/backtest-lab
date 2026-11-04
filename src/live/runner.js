// Live-Code-Engine: simuliert den kompletten n8n-Ablauf eines Bots über historische M5-Kerzen.
//
//   Cron (Mo–Fr 06:00–20:55 Berlin, alle 5 Min)
//     -> Strategie-Code-Node (ORIGINALTEXT, siehe sandbox.js) mit den Kerzen, die der Broker zu T liefern würde
//     -> Order-Prüfung wie im Workflow (Combined Check / Position Check, je Familie unten portiert)
//     -> Broker: Limit-Orders (GTD, Löschen), Market-Orders, SL/TP serverseitig auf jeder M5-Kerze (24/7)
//
// Broker-Regeln: BUY-Limit füllt, wenn Ask <= Limit (Gap: zum besseren Open), SELL-Limit wenn Bid >= Limit.
// Long schließt am Bid, Short am Ask. SL+TP in derselben Kerze -> SL (pessimistisch, markiert).
// In der Füll-Kerze zählt ein TP nur, wenn die Kerze jenseits des TP schließt (Reihenfolge sonst unbekannt).

import { local } from '../core/time.js';
import { buildDayContext } from '../core/context.js';
import { failsFilters } from '../core/engine.js';
import { TimeframeSeries, toCapital, toBridge } from './candles.js';
import { compileNode, makeClock, makeDate, makeIntl } from './sandbox.js';

const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const H = 3600000;

// Zeitfenster, in denen der jeweilige Code überhaupt etwas tut (aus den Zeitfiltern der Code-Nodes)
const ACTIVE = {
  NAS: { tz: 'UTC', from: '07:00', to: '18:59' }, // utcHour < 7 || >= 19 -> NONE
  NAS_FTMO: { tz: 'UTC', from: '07:00', to: '18:59' },
  EURUSD: { tz: 'UTC', from: '06:00', to: '18:59' }, // utcHour >= 19 || < 6 -> NONE
  DE40: { tz: 'Europe/Berlin', from: '10:00', to: '17:29' }, // Phase CLOSED / OPENING_RANGE -> NONE
};

export const LIVE_ENGINE_DEFAULTS = {
  startBalance: 10000, riskPercent: 1, compounding: true, pointValue: 1,
  cronFrom: '06:00', cronTo: '20:55', cronTz: 'Europe/Berlin', // Schedule Trigger */5 6-20 * * 1-5
  totalBalance: 18000, // was der Code als Kontostand sieht (nur Sizing im Code, Backtest rechnet eigenes Risiko)
  conflictMode: 'pessimistic', tz: 'Europe/Berlin',
};

const reasonKey = (s) => String(s || '').replace(/\(.*?\)/g, '').replace(/[-+]?\d[\d.,:]*\s*%?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);

export function runLive({ bars, days, variant, engine = {}, range = {}, params = {} }) {
  const E = { ...LIVE_ENGINE_DEFAULTS, ...(variant.engine || {}), ...engine };
  const V = variant;
  const opts = V.opts || {};
  const filters = params.filters || [];
  const run = compileNode(V.code);
  const clock = makeClock();
  const DateCls = makeDate(clock);
  const IntlObj = makeIntl();
  const state = {};
  const dayCtx = buildDayContext(bars, days);
  const S = {};
  const series = (tf) => (S[tf] ||= new TimeframeSeries(bars, tf));
  const inRange = (date) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

  let balance = E.startBalance;
  const orders = [];
  const ghosts = [];
  let positions = [];
  const trades = [];
  const own = []; // eigene platzierte Orders (staticData.ownOrders des Workflows)
  const stats = { ticks: 0, signals: 0, placed: 0, filled: 0, cancelled: 0, cancelledWouldFill: 0, expired: 0, blocked: {}, filtered: 0, conflicts: 0, gapStops: 0, fillBarStops: 0, flattened: 0, dailyHalts: 0, errors: {} };
  const reasonCount = {};
  let prevReasons = new Set();
  const dailyPnl = {};
  let haltDay = null;
  let id = 0;

  // ---------------------------------------------------------------- Broker
  const openPosition = (o, B, i, fill, how) => {
    const riskPts = Math.abs(fill - o.stop);
    if (!(riskPts > 0)) return null;
    const base = E.compounding ? balance : E.startBalance;
    const riskMoney = (base * E.riskPercent) / 100;
    const size = riskMoney / (riskPts * E.pointValue);
    const L = local(B.t, E.tz);
    const p = {
      id: ++id, orderId: o.id, dir: o.dir, entry: fill, stop: o.stop, tp: o.tp, riskPts, size, riskMoney,
      date: L.date, wd: L.weekday, entryHm: L.hm, entryT: B.t, entryIdx: i, signalHm: o.signalHm, signalDate: o.signalDate,
      features: { ...o.features, post_waitMin: Math.round((B.t - o.placedT) / 60000), ...(dayCtx[o.signalDate] || {}) },
      mfe: 0, mae: 0, spreadEntry: B.ao - B.bo, how, orderType: o.type,
    };
    positions.push(p);
    stats.filled++;
    return p;
  };
  const closePos = (p, B, i, price, reason, extra = {}) => {
    const sg = p.dir === 'BUY' ? 1 : -1;
    const pts = (price - p.entry) * sg;
    const pnl = pts * p.size * E.pointValue;
    balance += pnl;
    const L = local(B.t, E.tz);
    (dailyPnl[L.date] ||= { realized: 0 }).realized += pnl;
    trades.push({
      id: trades.length + 1, strategy: V.name, date: p.date, wd: p.wd, dir: p.dir, signalHm: p.signalHm, entryHm: p.entryHm, entryT: p.entryT,
      entry: r(p.entry, 5), stop: r(p.stop, 5), tp: r(p.tp, 5), exitHm: L.hm, exitSignalHm: L.hm, exitDate: L.date, exitT: B.t, exit: r(price, 5), reason,
      pts: r(pts, 5), riskPts: r(p.riskPts, 5), R: r(pts / p.riskPts, 3), size: r(p.size, 4), riskMoney: r(p.riskMoney, 2), pnl: r(pnl, 2), balanceAfter: r(balance, 2),
      mfePts: r(p.mfe, 5), maePts: r(p.mae, 5), mfeR: r(p.mfe / p.riskPts, 3), maeR: r(p.mae / p.riskPts, 3),
      barsHeld: i - p.entryIdx + 1, minutesHeld: Math.round((B.t - p.entryT) / 60000) + 5, conflict: !!extra.conflict, spreadEntry: r(p.spreadEntry, 5),
      entryIdx: p.entryIdx, exitIdx: i, features: p.features, orderType: p.orderType, fill: p.how,
    });
    positions = positions.filter((x) => x !== p);
  };
  const touches = (o, B) => (o.dir === 'BUY' ? B.al <= o.level : B.bh >= o.level);

  const processBar = (B, i) => {
    // Limit-Orders: Ablauf, Füllung
    for (const o of orders) {
      if (o.status !== 'OPEN') continue;
      if (o.expiresT <= B.t) { o.status = 'EXPIRED'; stats.expired++; continue; }
      if (!touches(o, B)) continue;
      const gap = o.dir === 'BUY' ? B.ao <= o.level : B.bo >= o.level;
      const fill = gap ? (o.dir === 'BUY' ? B.ao : B.bo) : o.level;
      o.status = 'FILLED';
      const p = openPosition(o, B, i, fill, gap ? 'GAP' : 'LIMIT');
      if (p) p.fillIntrabar = !gap;
    }
    for (const g of ghosts) {
      if (g.done) continue;
      if (g.expiresT <= B.t) { g.done = true; continue; }
      if (touches(g, B)) { g.done = true; g.wouldFill = true; stats.cancelledWouldFill++; }
    }
    // Positionen: SL/TP
    for (const p of [...positions]) {
      const L = p.dir === 'BUY';
      const fav = L ? B.bh - p.entry : p.entry - B.al;
      const adv = L ? p.entry - B.bl : B.ah - p.entry;
      const fillBar = p.entryIdx === i;
      const gapStop = !fillBar && (L ? B.bo <= p.stop : B.ao >= p.stop);
      const slHit = L ? B.bl <= p.stop : B.ah >= p.stop;
      let tpHit = p.tp != null && (L ? B.bh >= p.tp : B.al <= p.tp);
      if (fillBar && p.fillIntrabar && tpHit) tpHit = L ? B.bc >= p.tp : B.ac <= p.tp;
      if (gapStop) { p.mae = Math.max(p.mae, adv); stats.gapStops++; closePos(p, B, i, L ? B.bo : B.ao, 'SL_GAP'); continue; }
      if (slHit || tpHit) {
        const conflict = slHit && tpHit;
        if (conflict) stats.conflicts++;
        if (fillBar && slHit) stats.fillBarStops++;
        const takeSL = slHit && (!tpHit || E.conflictMode !== 'optimistic');
        if (takeSL) { p.mae = Math.max(p.mae, p.riskPts); if (!conflict) p.mfe = Math.max(p.mfe, fav); closePos(p, B, i, p.stop, 'SL', { conflict }); }
        else { p.mfe = Math.max(p.mfe, Math.abs(p.tp - p.entry)); if (!conflict) p.mae = Math.max(p.mae, adv); closePos(p, B, i, p.tp, 'TP', { conflict }); }
        continue;
      }
      p.mfe = Math.max(p.mfe, fav); p.mae = Math.max(p.mae, adv);
    }
  };

  const placeLimit = (T, L, o) => {
    const ord = { id: ++id, type: 'LIMIT', status: 'OPEN', placedT: T, signalHm: L.hm, signalDate: L.date, ...o };
    orders.push(ord);
    stats.placed++;
    own.push({ id: ord.id, placedAt: T, direction: o.dir, level: o.level, stopLevel: o.stop, profitLevel: o.tp });
    return ord;
  };
  const cancel = (o, T) => {
    o.status = 'CANCELLED'; o.cancelT = T; stats.cancelled++;
    ghosts.push({ dir: o.dir, level: o.level, expiresT: o.expiresT });
  };
  const myOpenOrders = () => orders.filter((o) => o.status === 'OPEN');
  const block = (why) => { stats.blocked[why] = (stats.blocked[why] || 0) + 1; return null; };

  // ---------------------------------------------------------------- Strategie-Lauf
  const views = (i, spec) => spec.map(([tf, n, running, fmt]) => (fmt === 'bridge' ? series(tf).view(i, n, running).map(toBridge) : series(tf).view(i, n, running).map(toCapital)));
  const callStrategy = (i, items) => {
    const logs = [];
    let out;
    try { out = run({ items, state, DateCls, IntlObj, logs })?.[0]?.json || { signal: 'NONE', error: 'leer' }; }
    catch (e) { out = { signal: 'NONE', error: 'EXCEPTION ' + e.message }; stats.errors[e.message] = (stats.errors[e.message] || 0) + 1; }
    // Filter-Statistik: Grund zählt, wenn er neu auftaucht (nicht jeden Lauf desselben Setups)
    const reasons = new Set();
    if (out.signal === 'NONE') { const k = reasonKey(out.reason || out.error); if (k) reasons.add(k); }
    for (const l of logs) if (!/^NAS100 (FIB|FTMO)|^\[|^US100/.test(l) && /blockiert|zu niedrig|zu groß|zu klein|bereits|Pause|V-Filter|verworfen|Minimum/.test(l)) reasons.add(reasonKey(l.split('|')[0]));
    for (const k of reasons) if (!prevReasons.has(k)) reasonCount[k] = (reasonCount[k] || 0) + 1;
    prevReasons = reasons;
    if (out.error && /EXCEPTION|TypeError|ReferenceError/.test(out.error)) stats.errors[out.error] = (stats.errors[out.error] || 0) + 1;
    return out;
  };

  const tickFeatures = (out, L, dir) => {
    const f = { dir, signalHm: L.hm, hour: Number(L.hm.slice(0, 2)), wd: L.weekday, ...(dayCtx[L.date] || {}) };
    const lim = Number(out.limitLevel ?? out.level), st = Number(out.stopLevel), tpl = Number(out.profitLevel), cp = Number(out.currentPrice);
    const scale = V.pip || 1;
    if (lim > 0 && st > 0) f.slDist = r(Math.abs(lim - st) / scale, 2);
    if (lim > 0 && tpl > 0) f.tpDist = r(Math.abs(tpl - lim) / scale, 2);
    if (lim > 0 && cp > 0 && out.orderType === 'LIMIT') f.distToEntry = r(Math.abs(cp - lim) / scale, 2);
    for (const k of V.featureKeys || []) {
      let v = k.includes('.') ? k.split('.').reduce((o, x) => o?.[x], out) : out[k];
      if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) v = Number(v);
      if (v !== undefined && v !== null && v !== '') f[k.replace('.', '_')] = v;
    }
    return f;
  };

  // ---------------------------------------------------------------- Familien (Order-Prüfung wie im Workflow)
  const family = {
    // d_ilikebigbots: Code Strategie NAS -> Signal NAS -> Combined Check NAS (v8) -> Should Cancel? -> PLACE LIMIT
    NAS(i, T, L, B) {
      const items = views(i, [['M15', 200, true], ['H4', 100, true]]).map((p) => ({ json: { prices: p } }));
      items.push({ json: { accounts: [{ balance: { balance: E.totalBalance } }] } });
      const out = callStrategy(i, items);
      return nasLikeCheck(out, T, L, B, { epicDayUtc: true, expiresH: 24 });
    },
    // d_ftmo: closed-only Kerzen von der cTrader-Bridge, gleiche Combined-Check-Logik, FTMO-Schutz
    NAS_FTMO(i, T, L, B) {
      const items = views(i, [['M15', 250, false, 'bridge'], ['H4', 150, false, 'bridge']]).map((p) => ({ json: { body: p } }));
      items.push({ json: { lot_size: 100, volume_step: 0.01, volume_min: 0.01, volume_max: 1000 } });
      const out = callStrategy(i, items);
      return nasLikeCheck(out, T, L, B, { epicDayUtc: true, expiresH: out.expirationHours || 24 });
    },
    // d_ilikebigbots: Code Strategie DE40 -> Signal DE (signal && limitLevel>0) -> DAX Combined Check v3
    DE40(i, T, L, B) {
      const [m5, h1, m15] = views(i, [['M5', 200, true], ['H1', 150, true], ['M15', 200, true]]);
      const items = [{ json: { prices: m5 } }, { json: { accounts: [{ balance: { balance: E.totalBalance } }] } }, { json: { prices: h1 } }, { json: { prices: m15 } }];
      const out = callStrategy(i, items);
      if (out.signal === 'NONE' || !(Number(out.limitLevel) > 0)) return;
      stats.signals++;
      const dir = out.signal;
      const feat = tickFeatures(out, L, dir);
      if (failsFilters(filters, feat) || !inRange(L.date)) { stats.filtered++; return; }
      const price = Number(out.currentPrice);
      const open = myOpenOrders();
      let shouldCancel = false, invalid = false;
      if (open.length && price > 0) {
        const o = open[0];
        const ref = o.dir === 'BUY' ? o.stop + 8 : o.stop - 8;
        invalid = o.dir === 'BUY' ? price < ref : price > ref;
        shouldCancel = invalid;
      }
      const activeOrder = open.length > 0 && !invalid;
      const recent = own.some((o) => o.placedAt >= T - 30 * 60000);
      const dup = own.find((o) => o.placedAt >= T - 24 * H && o.direction === dir && Math.abs(o.level - Number(out.limitLevel)) < 0.5);
      const today = local(T, 'Europe/Berlin').date;
      const count = own.filter((o) => local(o.placedAt, 'Europe/Berlin').date === today).length;
      if (activeOrder) return block('Aktive Order');
      if (positions.length) return block('Aktive Position');
      if (recent) return block('Order < 30 Min');
      if (count >= 2) return block('Tageslimit 2');
      if (dup) return block('Dublette');
      if (shouldCancel) cancel(open[0], T);
      const gtd = Date.parse(String(out.goodTillDate) + 'Z');
      placeLimit(T, L, { dir, level: Number(out.limitLevel), stop: Number(out.stopLevel), tp: Number(out.profitLevel), expiresT: Number.isFinite(gtd) ? gtd : T + 4 * H, features: feat });
    },
    // d_ilikebigbots: Code Strategie EURUSD Cx -> Signal EURUSD -> Position Check -> MARKET bzw. LIMIT (C5)
    EURUSD(i, T, L, B) {
      const [m15, m5, h1] = views(i, [['M15', 300, true], ['M5', 300, true], ['H1', 200, true]]);
      const items = [{ json: { accounts: [{ balance: { balance: E.totalBalance } }] } }, { json: { prices: m15 } }, { json: { prices: m5 } }, { json: { prices: h1 } }];
      const out = callStrategy(i, items);
      if (out.signal === 'NONE' || !out.signal) return;
      stats.signals++;
      const dir = out.signal;
      const feat = tickFeatures(out, L, dir);
      if (failsFilters(filters, feat) || !inRange(L.date)) { stats.filtered++; return; }
      if (positions.length) return block('Aktive Position');
      if (out.orderType === 'LIMIT') {
        placeLimit(T, L, { dir, level: Number(out.level), stop: Number(out.stopLevel), tp: Number(out.profitLevel), expiresT: Date.parse(String(out.goodTillDate) + 'Z'), features: feat });
      } else {
        const o = { id: ++id, type: 'MARKET', dir, stop: Number(out.stopLevel), tp: Number(out.profitLevel), placedT: T, signalHm: L.hm, signalDate: L.date, features: feat };
        stats.placed++;
        openPosition(o, B, i, dir === 'BUY' ? B.ao : B.bo, 'MARKET');
      }
    },
  };

  function nasLikeCheck(out, T, L, B, { expiresH }) {
    const open = myOpenOrders();
    const price = Number(out.currentPrice) || 0;
    let invalid = false;
    if (open.length && price > 0) {
      const o = open[0];
      const ref = (o.level + o.tp) / 2;
      invalid = o.dir === 'BUY' ? price > ref : price < ref;
      // Variante "Lösch-Regel ohne neues Signal": sofort löschen
      if (invalid && opts.cancelWithoutSignal) { cancel(o, T); open.length = 0; invalid = false; }
    }
    if (out.signal === 'NONE' || !out.signal) return;
    stats.signals++;
    const dir = out.signal;
    const feat = tickFeatures(out, L, dir);
    if (failsFilters(filters, feat) || !inRange(L.date)) { stats.filtered++; return; }
    const activeOrder = open.length > 0 && !invalid;
    const recent = own.some((o) => o.placedAt >= T - 30 * 60000);
    const lim = Number(out.limitLevel), st = Number(out.stopLevel), tp = Number(out.profitLevel);
    const dup = own.find((o) => o.placedAt >= T - 24 * H && o.direction === dir && Math.abs(o.level - lim) < 0.5 && Math.abs(o.stopLevel - st) < 0.5 && Math.abs(o.profitLevel - tp) < 0.5);
    const todayUtc = new Date(T).toISOString().slice(0, 10);
    const count = own.filter((o) => new Date(o.placedAt).toISOString().slice(0, 10) === todayUtc).length;
    if (activeOrder) return block('Aktive Order');
    if (positions.length) return block('Aktive Position');
    if (recent) return block('Order < 30 Min');
    if (count >= 2) return block('Tageslimit 2');
    if (dup) return block('Dublette');
    if (opts.ftmo && haltDay === L.date) return block('FTMO Tagesverlust-Sperre');
    if (invalid) cancel(open[0], T); // Should Cancel? (Signal liegt vor)
    placeLimit(T, L, { dir, level: lim, stop: st, tp, expiresT: T + expiresH * H, features: { ...feat, lots: Number(out.size) || null } });
  }

  // ---------------------------------------------------------------- Hauptschleife
  const famFn = family[V.family];
  if (!famFn) throw new Error('Unbekannte Familie ' + V.family);
  for (let i = 0; i < bars.length; i++) {
    const B = bars[i];
    const T = B.t;
    const L = local(T, E.cronTz);
    clock.now = T + 10000; // Lauf ~10 s nach dem 5-Min-Wechsel
    // FTMO: Freitag 20:30 Glattstellen (eigener Cron) + Tagesverlust-Schutz
    if (opts.ftmo) {
      if (L.weekday === 5 && L.hm === '20:30') {
        for (const o of myOpenOrders()) { o.status = 'CANCELLED'; stats.cancelled++; }
        for (const p of [...positions]) { closePos(p, B, i, p.dir === 'BUY' ? B.bo : B.ao, 'FREITAG_FLAT'); stats.flattened++; }
      }
      const dp = dailyPnl[L.date]?.realized || 0;
      const open = positions.reduce((s, p) => s + ((p.dir === 'BUY' ? B.bo - p.entry : p.entry - B.ao) * p.size * E.pointValue), 0);
      if (haltDay !== L.date && -(dp + open) >= E.startBalance * (opts.dailyStopPct ?? 4) / 100) {
        haltDay = L.date; stats.dailyHalts++;
        for (const o of myOpenOrders()) { o.status = 'CANCELLED'; stats.cancelled++; }
        for (const p of [...positions]) { closePos(p, B, i, p.dir === 'BUY' ? B.bo : B.ao, 'FTMO_TAGESSTOPP'); stats.flattened++; }
      }
    }
    if (L.weekday >= 1 && L.weekday <= 5 && L.hm >= E.cronFrom && L.hm <= E.cronTo) {
      stats.ticks++;
      // Außerhalb der Handelszeit kehrt der Code sofort ohne Zustandsänderung zurück -> Aufruf sparen
      const act = ACTIVE[V.family];
      const hm = act.tz === 'UTC' ? new Date(T).toISOString().slice(11, 16) : L.hm;
      if (hm >= act.from && hm <= act.to) famFn(i, T, L, B);
    }
    processBar(B, i);
  }
  // offene Positionen zum Datenende schließen
  const Lb = bars[bars.length - 1];
  for (const p of [...positions]) closePos(p, Lb, bars.length - 1, p.dir === 'BUY' ? Lb.bc : Lb.ac, 'END');

  const tradedDays = days.filter((d) => inRange(d.date));
  const topReasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([reason, n]) => ({ reason, n }));
  const lots = trades.map((t) => t.features?.lots).filter((x) => Number.isFinite(x));
  return {
    strategy: { id: V.id, name: V.name, symbol: V.symbol },
    params: { ...params, variant: V.id }, engine: E, trades,
    events: { ...stats, orderFillRate: stats.placed ? r(stats.filled / stats.placed, 3) : null, avgLots: lots.length ? r(lots.reduce((a, b) => a + b, 0) / lots.length, 2) : null, maxLots: lots.length ? Math.max(...lots) : null },
    filterReasons: topReasons,
    dailyEquity: [], startBalance: E.startBalance, endBalance: r(balance, 2),
    period: tradedDays.length ? { from: tradedDays[0].date, to: tradedDays[tradedDays.length - 1].date, days: tradedDays.length } : null,
  };
}
