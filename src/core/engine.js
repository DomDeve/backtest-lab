// Backtest-Engine: Kerze für Kerze, wie der Live-Bot.
//
// Ablauf je Kerze B (Index i):
//   1. Offene Aufträge aus der Entscheidung nach Kerze i-1 werden zum OPEN von B ausgeführt
//      (Kauf am Ask, Verkauf am Bid, plus Slippage). Das entspricht dem n8n-Lauf ~10 s nach Kerzenschluss.
//   2. Offene Position: SL/TP gegen High/Low von B prüfen (Long: Bid-Seite, Short: Ask-Seite).
//      Gap über den SL -> Ausführung zum Open (schlechter als SL). SL und TP in derselben Kerze ->
//      "Konflikt", Default pessimistisch (SL zuerst), Trade wird markiert.
//   3. Kerze B ist abgeschlossen -> strategy.onBar() entscheidet für die nächste Kerze.
//
// Die Strategie sieht nie Kerzen aus der Zukunft: ctx enthält nur abgeschlossene Kerzen.

import { buildDayContext } from './context.js';

export const ENGINE_DEFAULTS = {
  startBalance: 10000,
  riskPercent: 0.3, // % vom Konto je Trade (wie live)
  compounding: true, // false: Risiko immer vom Startkapital
  pointValue: 1, // EUR je Punkt bei Größe 1 (DE40 bei Capital.com: 1)
  sizeDecimals: 3,
  minSize: 0.001,
  maxSize: 50,
  entrySlippagePts: 0, // gegen dich, bei Markt-Einstieg
  exitSlippagePts: 0, // gegen dich, bei Markt-Ausstieg
  stopSlippagePts: 0, // gegen dich, wenn der SL ausgelöst wird
  commissionPerTrade: 0, // EUR je Round-Turn
  conflictMode: 'pessimistic', // 'pessimistic' (SL zuerst) | 'optimistic' (TP zuerst)
  skipIncompleteDays: false, // true: an Tagen mit Lücken in der Kernzeit nicht handeln
  tz: 'Europe/Berlin',
};

/**
 * Generische Einstiegsfilter (params.filters), damit jede Empfehlung als echter Backtest geprüft werden kann.
 * Format: [{ field:'wd', op:'notIn', values:[1] }, { field:'rangeRel', op:'between', min:0.3, max:1.2 }]
 * Felder: dir, signalHm, hour, wd, alle ctx_*-Merkmale und alle Strategie-Features.
 * Gibt den Grund zurück, wenn ein Filter greift, sonst null.
 */
export function failsFilters(filters, f) {
  if (!filters || !filters.length) return null;
  for (const flt of filters) {
    const v = f[flt.field];
    if (v === undefined || v === null) continue; // unbekannt -> nicht filtern
    const inList = (flt.values || []).map(String).includes(String(v));
    if (flt.op === 'in' && !inList) return flt;
    if (flt.op === 'notIn' && inList) return flt;
    const lo = flt.min ?? -Infinity, hi = flt.max ?? Infinity;
    if (flt.op === 'between' && !(v >= lo && v <= hi)) return flt;
    if (flt.op === 'notBetween' && v >= lo && v <= hi) return flt;
  }
  return null;
}

const r = (x, d = 2) =>(x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * @param {object} a
 * @param {Array} a.bars   bereinigte Kerzen (clean.js)
 * @param {Array} a.days   Tagesindex (clean.js)
 * @param {object} a.strategy Strategie-Modul
 * @param {object} [a.params] Parameter-Overrides
 * @param {object} [a.engine] Engine-Overrides
 * @param {{from?:string,to?:string}} [a.range] nur Tage in diesem Bereich handeln (Historie davor bleibt sichtbar)
 */
export function runBacktest({ bars, days, strategy, params = {}, engine = {}, range = {} }) {
  const E = { ...ENGINE_DEFAULTS, ...engine };
  const P = { ...strategy.defaults, ...params };
  const state = strategy.createState ? strategy.createState(P) : {};
  const dayCtx = buildDayContext(bars, days);

  let balance = E.startBalance;
  let pos = null;
  let pending = null; // { type:'ENTER'|'EXIT', ... , decidedIdx }
  const trades = [];
  const events = { signals: 0, rejected: { invalidStop: 0, sizeTooSmall: 0, incompleteDay: 0, alreadyInPosition: 0, outOfRange: 0 }, conflicts: 0, gapStops: 0 };
  const dailyEquity = [];

  let tradesToday = 0;
  let dayIdx = -1;
  let dayBars = [];
  let byHm = {};
  const prevDays = []; // Kerzen-Arrays früherer Tage (für Profile wie NoiseB)

  const inRange = (date) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

  const closePos = (B, i, price, reason, extra = {}) => {
    const sg = pos.dir === 'BUY' ? 1 : -1;
    const pts = (price - pos.entry) * sg;
    const pnl = pts * pos.size * E.pointValue - E.commissionPerTrade;
    balance += pnl;
    const t = {
      id: trades.length + 1, strategy: strategy.name, date: pos.date, wd: pos.wd, dir: pos.dir,
      signalHm: pos.signalHm, entryHm: pos.entryHm, entryT: pos.entryT, entry: r(pos.entry, 2), stop: r(pos.stop0, 2), tp: r(pos.tp, 2),
      exitHm: B.hm, exitSignalHm: extra.exitSignalHm ?? B.hm, exitDate: B.date, exitT: B.t, exit: r(price, 2), reason, pts: r(pts, 2), riskPts: r(pos.riskPts, 2),
      R: r(pts / pos.riskPts, 3), size: pos.size, riskMoney: r(pos.riskMoney, 2), pnl: r(pnl, 2), balanceAfter: r(balance, 2),
      mfePts: r(pos.mfe, 2), maePts: r(pos.mae, 2), mfeR: r(pos.mfe / pos.riskPts, 3), maeR: r(pos.mae / pos.riskPts, 3),
      barsHeld: i - pos.entryIdx + 1, minutesHeld: Math.round((B.t - pos.entryT) / 60000) + 5,
      conflict: !!extra.conflict, spreadEntry: r(pos.spreadEntry, 2), entryIdx: pos.entryIdx, exitIdx: i,
      features: { ...pos.features, ...(dayCtx[pos.date] || {}) },
    };
    trades.push(t);
    pos = null;
    return t;
  };

  for (let i = 0; i < bars.length; i++) {
    const B = bars[i];

    // --- Tageswechsel ---
    if (B.date !== (days[dayIdx]?.date)) {
      // offene Exit-Order vom Vortag: zum letzten Schlusskurs des Vortags schließen
      if (pending?.type === 'EXIT' && pos) {
        const L = bars[i - 1];
        closePos(L, i - 1, pos.dir === 'BUY' ? L.bc - E.exitSlippagePts : L.ac + E.exitSlippagePts, pending.reason + '_EOD');
      }
      if (pending?.type === 'ENTER') events.rejected.outOfRange++;
      pending = null;
      if (dayIdx >= 0) {
        prevDays.push(dayBars);
        if (prevDays.length > (strategy.historyDays || 60)) prevDays.shift();
        dailyEquity.push({ date: days[dayIdx].date, balance: r(balance, 2) });
      }
      while (days[dayIdx + 1] && days[dayIdx + 1].date !== B.date) dayIdx++;
      dayIdx++;
      dayBars = [];
      byHm = {};
      tradesToday = 0;
      if (strategy.onDay) strategy.onDay({ date: B.date, day: days[dayIdx], prevDays, state, params: P });
    }

    // --- 1. offene Aufträge zum Open ausführen ---
    let enteredThisBar = false;
    if (pending) {
      if (pending.type === 'EXIT' && pos) {
        closePos(B, i, pos.dir === 'BUY' ? B.bo - E.exitSlippagePts : B.ao + E.exitSlippagePts, pending.reason, { exitSignalHm: pending.signalHm });
      } else if (pending.type === 'ENTER' && !pos) {
        const a = pending;
        const entry = a.dir === 'BUY' ? B.ao + E.entrySlippagePts : B.bo - E.entrySlippagePts;
        const riskPts = a.dir === 'BUY' ? entry - a.stop : a.stop - entry;
        const base = E.compounding ? balance : E.startBalance;
        const riskMoney = (base * E.riskPercent) / 100;
        const refDist = Math.abs((a.refPrice ?? entry) - a.stop);
        const size = Math.min(E.maxSize, Number((riskMoney / (refDist * E.pointValue)).toFixed(E.sizeDecimals)));
        if (!(riskPts > 0)) events.rejected.invalidStop++;
        else if (!(size >= E.minSize)) events.rejected.sizeTooSmall++;
        else {
          pos = {
            dir: a.dir, entry, stop: a.stop, stop0: a.stop,
            tp: a.tpR ? entry + (a.dir === 'BUY' ? 1 : -1) * a.tpR * riskPts : (a.tp ?? null), riskPts, size, riskMoney: riskPts * size * E.pointValue,
            date: B.date, wd: B.wd, entryHm: B.hm, entryT: B.t, entryIdx: i, signalHm: a.signalHm, features: a.features || {},
            mfe: 0, mae: 0, spreadEntry: B.ao - B.bo,
          };
          tradesToday++;
          enteredThisBar = true;
        }
      }
      pending = null;
    }

    // --- 2. SL/TP innerhalb der Kerze ---
    if (pos) {
      const L = pos.dir === 'BUY';
      // MFE/MAE auf der Seite, zu der man schließen könnte
      const fav = L ? B.bh - pos.entry : pos.entry - B.al;
      const adv = L ? pos.entry - B.bl : B.ah - pos.entry;
      // Gap über den Stop (nicht in der Einstiegskerze)
      const gapStop = !enteredThisBar && (L ? B.bo <= pos.stop : B.ao >= pos.stop);
      const slHit = L ? B.bl <= pos.stop : B.ah >= pos.stop;
      const tpHit = pos.tp != null && (L ? B.bh >= pos.tp : B.al <= pos.tp);
      if (gapStop) {
        pos.mae = Math.max(pos.mae, adv);
        events.gapStops++;
        closePos(B, i, L ? B.bo - E.stopSlippagePts : B.ao + E.stopSlippagePts, 'SL_GAP');
      } else if (slHit || tpHit) {
        const conflict = slHit && tpHit;
        if (conflict) events.conflicts++;
        const takeSL = slHit && (!tpHit || E.conflictMode !== 'optimistic');
        // MFE/MAE nur bis zum (angenommenen) Ausstieg zählen; bei Konflikt ist die Gegenseite unbekannt
        if (takeSL) {
          pos.mae = Math.max(pos.mae, Math.abs(pos.entry - pos.stop));
          if (!conflict) pos.mfe = Math.max(pos.mfe, fav);
        } else {
          pos.mfe = Math.max(pos.mfe, Math.abs(pos.tp - pos.entry));
          if (!conflict) pos.mae = Math.max(pos.mae, adv);
        }
        if (takeSL) closePos(B, i, L ? pos.stop - E.stopSlippagePts : pos.stop + E.stopSlippagePts, 'SL', { conflict });
        else closePos(B, i, pos.tp, 'TP', { conflict });
      } else {
        pos.mfe = Math.max(pos.mfe, fav);
        pos.mae = Math.max(pos.mae, adv);
      }
    }

    // --- 3. Kerze abgeschlossen -> Strategie entscheidet ---
    dayBars.push(B);
    byHm[B.hm] = B;
    const ctx = {
      bar: B, i, date: B.date, hm: B.hm, dayBars, byHm, prevDays, day: days[dayIdx], dayContext: dayCtx[B.date],
      position: pos ? { dir: pos.dir, entry: pos.entry, stop: pos.stop, tp: pos.tp, entryHm: pos.entryHm, features: pos.features } : null,
      tradesToday, state, params: P,
    };
    const actions = strategy.onBar(ctx) || [];
    for (const a of actions) {
      if (a.type === 'ENTER') {
        events.signals++;
        if (pos || pending) { events.rejected.alreadyInPosition++; continue; }
        if (!inRange(B.date)) { events.rejected.outOfRange++; continue; }
        if (E.skipIncompleteDays && !days[dayIdx].complete) { events.rejected.incompleteDay++; continue; }
        const why = failsFilters(P.filters, { dir: a.dir, signalHm: B.hm, hour: Number(B.hm.slice(0, 2)), wd: B.wd, ...(dayCtx[B.date] || {}), ...(a.features || {}) });
        if (why) { events.rejected.filtered = (events.rejected.filtered || 0) + 1; continue; }
        pending = { ...a, signalHm: a.signalHm ?? B.hm, decidedIdx: i };
      } else if (a.type === 'EXIT' && pos && !pending) {
        pending = { type: 'EXIT', reason: a.reason || 'EXIT', signalHm: B.hm };
      } else if (a.type === 'MODIFY' && pos) {
        if (a.stop != null) pos.stop = a.stop;
        if (a.tp !== undefined) pos.tp = a.tp;
      }
    }
  }

  // Datenende
  if (pos) {
    const L = bars[bars.length - 1];
    closePos(L, bars.length - 1, pos.dir === 'BUY' ? L.bc : L.ac, 'END');
  }
  if (dayIdx >= 0) dailyEquity.push({ date: days[dayIdx].date, balance: r(balance, 2) });

  const tradedDays = days.filter((d) => inRange(d.date));
  return {
    strategy: { id: strategy.id, name: strategy.name, symbol: strategy.symbol },
    params: P, engine: E, trades, events, dailyEquity: dailyEquity.filter((d) => inRange(d.date)),
    startBalance: E.startBalance, endBalance: r(balance, 2),
    period: tradedDays.length ? { from: tradedDays[0].date, to: tradedDays[tradedDays.length - 1].date, days: tradedDays.length } : null,
  };
}
