// Kandidaten K1 (einfacher ORB), K2 (ORB-Retest) und K5 (VWAP-EMA-Cross) – Auftrag vom 07.11.2026.
//
// Ausführung (alle drei): Signal bei Kerzenschluss, Einstieg zum Open der Folgekerze (Kauf Ask, Verkauf Bid) + Slippage.
// SL/TP intrabar auf M5 auf der passenden Seite (Long: Bid, Short: Ask); SL und TP in derselben Kerze -> SL (pessimistisch);
// Gap über SL -> Fill zum Open. Exit spätestens zum Session-Ende (Schluss der letzten Kerze). Sessions enden immer am selben
// Tag -> freitags ist alles geschlossen. Kein Lookahead: ATR/EMA/VWAP/Range nur aus abgeschlossenen Kerzen.
// Kosten: net = mit Bid/Ask + Slippage; gross = Mitte ohne Slippage (Kostenanteil = (gross − net) / gross).
//
// K2 ORB-Retest:
//   Opening Range (OR) = erste orMin Minuten (M5-Mitte). Ausbruch = Schluss (TF M5|M15) jenseits OR-Hoch/-Tief.
//   Folgekerze schließt wieder in der Range = Fakeout -> diese Richtung heute gesperrt (fade: Gegenrichtung, Ziel
//   gegenüberliegende Range-Seite, Stop hinter dem Fakeout-Extrem + Spread + 0,1 ATR).
//   Retest: Kerze erreicht den gebrochenen Rand (± tol × ATR14 des TF) und schließt wieder jenseits des Rands -> Einstieg.
//   Schließt vorher eine Kerze in der Range (oder durch die Range), ist die Richtung gesperrt. Retest bis Start + 120 min.
//   Stop hinter dem Retest-Extrem + Spread + 0,1 ATR, mindestens 0,5 × ATR14(M15). Ziel tgt R, optional Einstand ab 1R.
//   Max. 1 Trade/Tag. Filter F1–F5 werden als Merkmale am Trade gespeichert und in der Auswertung angewendet.
// K1: erster M5-Schluss jenseits der Range -> Market, Stop gegenüberliegende Range-Seite, Ziel 1,5R, max. 1 Trade/Tag.
// K5 VWAP-EMA-Cross:
//   VWAP (Tick-Volumen, typischer Preis) verankert zum Session-Start bzw. 00:00 Börsenzeit. EMA n auf TF-Schlusskursen.
//   Long: EMA schließt über VWAP (vorher ≤), Short spiegelbildlich. Exit: Gegen-Cross (Schluss) -> nächstes Open,
//   optional Ziel 2R. Initialstop stopAtr × ATR14(TF). Einstiege nur Start+15 min … Ende−30 min, max. 2 Trades/Tag,
//   kein Re-Entry innerhalb von 3 TF-Kerzen nach einem Exit. Seitwärts-Filter: |EMA−VWAP| > 0,3 ATR in den letzten 6 Kerzen.

import { utcFor, local } from '../core/time.js';
import { epicSession, isTradingDay } from '../core/sessions.js';

const M5 = 300000, M15 = 900000;

// ---------------------------------------------------------------- Vorberechnung je Epic
export function prepare(bars) {
  const n = bars.length;
  const mo = new Float64Array(n), mh = new Float64Array(n), ml = new Float64Array(n), mc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    mo[i] = (b.bo + b.ao) / 2; mh[i] = (b.bh + b.ah) / 2; ml[i] = (b.bl + b.al) / 2; mc[i] = (b.bc + b.ac) / 2;
  }
  const atr5 = wilderAtr(mh, ml, mc, 14);
  // globale M15-Kerzen (UTC-Viertelstunden)
  const q = { start: [], end: [], o: [], h: [], l: [], c: [], v: [] };
  const m15Of = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const blk = Math.floor(bars[i].t / M15);
    const k = q.start.length - 1;
    if (k < 0 || Math.floor(bars[q.start[k]].t / M15) !== blk) {
      q.start.push(i); q.end.push(i); q.o.push(mo[i]); q.h.push(mh[i]); q.l.push(ml[i]); q.c.push(mc[i]); q.v.push(bars[i].vol || 0);
    } else {
      q.end[k] = i; q.h[k] = Math.max(q.h[k], mh[i]); q.l[k] = Math.min(q.l[k], ml[i]); q.c[k] = mc[i]; q.v[k] += bars[i].vol || 0;
    }
    m15Of[i] = q.start.length - 1;
  }
  q.atr = wilderAtr(q.h, q.l, q.c, 14);
  const idxOf = new Map(bars.map((b, i) => [b.t, i]));
  return { bars, n, mo, mh, ml, mc, atr5, q, m15Of, idxOf, ema: {} };
}

function wilderAtr(h, l, c, p) {
  const n = h.length, out = new Float64Array(n);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    a = i < p ? (a * i + tr) / (i + 1) : (a * (p - 1) + tr) / p;
    out[i] = a;
  }
  return out;
}

function emaSeries(vals, len) {
  const out = new Float64Array(vals.length), k = 2 / (len + 1);
  let e = vals[0];
  for (let i = 0; i < vals.length; i++) { e = i === 0 ? vals[0] : vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function getEma(P, tf, len) {
  const key = tf + len;
  if (!P.ema[key]) P.ema[key] = emaSeries(tf === 'M5' ? P.mc : P.q.c, len);
  return P.ema[key];
}

// ---------------------------------------------------------------- Sessions je Tag
/** def: { epic, session, open_local?, tz?, close_local?, fxEndHours?, fxEndLatestBerlin? } -> [{ date, S, E, i0, i1, expected, have }] */
export function sessionDays(P, def) {
  const s = epicSession(def.epic, def.session);
  const open = def.open_local || s.open_local, tz = def.tz || s.tz, close = def.close_local || s.close_local;
  const dates = [...new Set(P.bars.map((b) => local(b.t, tz).date))].sort();
  const out = [];
  for (const date of dates) {
    const wd = new Date(date + 'T12:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6 || !isTradingDay(def.epic, date)) continue; // nur Mo–Fr (auch Krypto, FTMO-Wochenendregel)
    const S = utcFor(date, open, tz);
    let E = utcFor(date, close, def.closeTz || tz);
    if (def.fxEndHours) E = Math.min(S + def.fxEndHours * 3600000, utcFor(date, def.fxEndLatestBerlin || '22:00', 'Europe/Berlin'));
    if (!(E > S)) continue;
    let i0 = lowerBound(P.bars, S), i1 = lowerBound(P.bars, E) - 1;
    const expected = Math.round((E - S) / M5), have = i1 >= i0 ? i1 - i0 + 1 : 0;
    out.push({ date, S, E, i0, i1, expected, have, tz });
  }
  return out;
}
function lowerBound(bars, t) { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; } return lo; }

/** Tages-ATR(20) aus Tageskerzen (Börsen-Ortszeit, Mitte) – Wert je Datum aus den 20 Vortagen. */
export function dailyAtr(P, tz, len = 20) {
  const d = new Map();
  for (let i = 0; i < P.n; i++) {
    const k = local(P.bars[i].t, tz).date;
    const x = d.get(k);
    if (!x) d.set(k, { h: P.mh[i], l: P.ml[i], c: P.mc[i] }); else { x.h = Math.max(x.h, P.mh[i]); x.l = Math.min(x.l, P.ml[i]); x.c = P.mc[i]; }
  }
  const keys = [...d.keys()].sort(), out = {}, trs = [];
  for (let j = 0; j < keys.length; j++) {
    if (trs.length >= len) out[keys[j]] = trs.slice(-len).reduce((s, x) => s + x, 0) / len;
    const x = d.get(keys[j]), p = j ? d.get(keys[j - 1]) : null;
    const wd = new Date(keys[j] + 'T12:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) trs.push(p ? Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)) : x.h - x.l);
  }
  return out;
}

// ---------------------------------------------------------------- Positionsführung
/** Einstieg zum Open von Kerze j; läuft bis SL/TP/exitAt (Open) oder Session-Ende (Schluss iEnd). */
function runPosition(P, j, dir, stop, tgtR, iEnd, slip, { be = false, exitAt = null } = {}) {
  const B = P.bars;
  const fill = dir > 0 ? B[j].ao + slip : B[j].bo - slip;
  let risk = Math.abs(fill - stop);
  if (!(risk > 0) || (dir > 0 && stop >= fill) || (dir < 0 && stop <= fill)) return null;
  const target = tgtR ? fill + dir * tgtR * risk : null;
  let sl = stop, beDone = false, mae = 0, exit = null, xi = iEnd, why = 'END', exSlip = slip;
  const spreadIn = B[j].ao - B[j].bo;
  for (let i = j; i <= iEnd; i++) {
    const b = B[i];
    if (exitAt !== null && i === exitAt && i > j) { exit = dir > 0 ? b.bo - slip : b.ao + slip; xi = i; why = 'X'; break; }
    const lo = dir > 0 ? b.bl : b.ah, hi = dir > 0 ? b.bh : b.al; // ungünstige / günstige Seite
    const op = dir > 0 ? b.bo : b.ao;
    const adv = dir > 0 ? fill - b.bl : b.ah - fill;
    if (i > j && (dir > 0 ? op <= sl : op >= sl)) { exit = op - dir * slip; xi = i; why = beDone ? 'BE' : 'SL'; mae = Math.max(mae, adv); break; }
    const slHit = dir > 0 ? lo <= sl : lo >= sl;
    const tpHit = target !== null && (dir > 0 ? hi >= target : hi <= target);
    if (slHit) { exit = sl - dir * slip; xi = i; why = beDone ? 'BE' : 'SL'; mae = Math.max(mae, Math.min(adv, Math.abs(fill - sl) + Math.abs(slip))); break; }
    mae = Math.max(mae, adv);
    if (tpHit) { exit = target; xi = i; why = 'TP'; exSlip = 0; break; }
    if (be && !beDone && (dir > 0 ? b.bh - fill : fill - b.al) >= risk) { sl = fill; beDone = true; } // gilt ab nächster Kerze
  }
  if (exit === null) { const b = B[iEnd]; exit = dir > 0 ? b.bc - slip : b.ac + slip; xi = iEnd; }
  const spreadOut = B[xi].ao - B[xi].bo;
  const rn = ((exit - fill) * dir) / risk;
  const cost = spreadIn / 2 + slip + spreadOut / 2 + exSlip;
  return { j, xi, dir, fill, exit, risk, rn, rg: rn + cost / risk, mae: Math.max(0, mae) / risk, why };
}

const rec = (P, day, p, f = null) => [day.date, P.bars[p.j].t, p.dir, r4(p.rn), r4(p.rg), r4(Math.min(p.mae, 3)), p.why, P.bars[p.xi].t, ...(f ? f.map(r4) : [])];
const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

// ---------------------------------------------------------------- OR je Tag (für K1/K2 und F1/F3-Historie)
export function openingRanges(P, days, orMin) {
  const nb = orMin / 5;
  return days.map((d) => {
    if (d.have < d.expected * 0.9 || d.i1 - d.i0 + 1 < nb) return null;
    let h = -Infinity, l = Infinity, v = 0, ok = 0;
    for (let i = d.i0; i < d.i0 + nb; i++) { if (P.bars[i].t >= d.S + orMin * 60000) break; h = Math.max(h, P.mh[i]); l = Math.min(l, P.ml[i]); v += P.bars[i].vol || 0; ok++; }
    return ok === nb && h > l ? { h, l, v, size: h - l } : null;
  });
}

// TF-Kerzen einer Session ab Index a (M5: jede Kerze; M15: Blöcke ab Session-Start) -> [{ s, e, o, h, l, c, t }]
function sessionCandles(P, d, tf) {
  const out = [];
  const step = tf === 'M5' ? M5 : M15;
  for (let i = d.i0; i <= d.i1; ) {
    const blk = Math.floor((P.bars[i].t - d.S) / step);
    let e = i, h = P.mh[i], l = P.ml[i];
    while (e + 1 <= d.i1 && Math.floor((P.bars[e + 1].t - d.S) / step) === blk) { e++; h = Math.max(h, P.mh[e]); l = Math.min(l, P.ml[e]); }
    out.push({ s: i, e, o: P.mo[i], h, l, c: P.mc[e], tEnd: d.S + (blk + 1) * step, atr: tf === 'M5' ? P.atr5[e] : P.q.atr[P.m15Of[e]] });
    i = e + 1;
  }
  return out;
}

// ---------------------------------------------------------------- K1
export function runK1(P, days, ors, { slip, tgt = 1.5 }) {
  const out = [];
  days.forEach((d, k) => {
    const R = ors[k]; if (!R) return;
    const C = sessionCandles(P, d, 'M5');
    for (let c = 0; c < C.length - 1; c++) {
      if (P.bars[C[c].s].t < d.S + ors.orMin * 60000) continue;
      const dir = C[c].c > R.h ? 1 : C[c].c < R.l ? -1 : 0;
      if (!dir) continue;
      const p = runPosition(P, C[c + 1].s, dir, dir > 0 ? R.l : R.h, tgt, d.i1, slip);
      if (p) out.push(rec(P, d, p));
      break;
    }
  });
  return out;
}

// ---------------------------------------------------------------- K2
/** v: { orMin, tf, tol, tgt, be, fade } ; ctx: { ors, orHist (F1/F3), datr } */
export function runK2(P, days, ctx, v, slip) {
  const out = [];
  const { ors, avgSize, avgVol, datr } = ctx;
  days.forEach((d, k) => {
    const R = ors[k]; if (!R) return;
    const C = sessionCandles(P, d, v.tf);
    const orEnd = d.S + v.orMin * 60000, deadline = d.S + 120 * 60000;
    const atr15At = (i) => P.q.atr[P.m15Of[i]];
    const banned = { 1: false, '-1': false };
    let pend = null; // { dir, bk, followed }
    const inside = (c) => c <= R.h && c >= R.l;
    const feat = (bc) => [R.size / avgSize[k], datr[d.date] ? R.size / datr[d.date] : null, R.v / avgVol[k], (bc.h - bc.l) / R.size, bc.h > bc.l ? Math.abs(bc.c - bc.o) / (bc.h - bc.l) : 0];
    for (let c = 0; c < C.length - 1; c++) {
      const K = C[c];
      if (P.bars[K.s].t < orEnd) continue;
      if (K.tEnd > deadline) break;
      if (pend) {
        const dir = pend.dir, edge = dir > 0 ? R.h : R.l;
        if (!pend.followed) {
          pend.followed = true;
          if (inside(K.c)) {
            banned[dir] = true;
            if (v.fade) { // Gegenrichtung, Ziel gegenüberliegende Range-Seite
              const ext = dir > 0 ? Math.max(pend.bc.h, K.h) : Math.min(pend.bc.l, K.l);
              const sp = P.bars[K.e].ao - P.bars[K.e].bo;
              const stop = ext + dir * (sp + 0.1 * K.atr);
              const fd = -dir, fillEst = fd > 0 ? P.bars[C[c + 1].s].ao : P.bars[C[c + 1].s].bo;
              const tgtPx = fd > 0 ? R.h : R.l, rr = Math.abs(tgtPx - fillEst) / Math.abs(fillEst - stop);
              if (rr > 0.2) { const p = runPosition(P, C[c + 1].s, fd, stop, rr, d.i1, slip); if (p) { out.push(rec(P, d, p, [...feat(pend.bc), 1])); return; } }
            }
            pend = null;
          }
        } else if (inside(K.c) || (dir > 0 ? K.c < R.l : K.c > R.h)) { banned[dir] = true; pend = null; }
        if (pend && pend.followed && pend.bk !== c) {
          const touch = dir > 0 ? K.l <= edge + v.tol * K.atr : K.h >= edge - v.tol * K.atr;
          const back = dir > 0 ? K.c > edge : K.c < edge;
          if (touch && back) {
            const ext = dir > 0 ? K.l : K.h;
            const sp = P.bars[K.e].ao - P.bars[K.e].bo;
            let stop = ext - dir * (sp + 0.1 * K.atr);
            const j = C[c + 1].s, fillEst = dir > 0 ? P.bars[j].ao + slip : P.bars[j].bo - slip;
            const minStop = 0.5 * atr15At(K.e);
            if (Math.abs(fillEst - stop) < minStop) stop = fillEst - dir * minStop;
            const p = runPosition(P, j, dir, stop, v.tgt, d.i1, slip, { be: v.be });
            if (p) out.push(rec(P, d, p, [...feat(pend.bc), 0]));
            return;
          }
        }
        if (pend) continue;
      }
      const dir = K.c > R.h ? 1 : K.c < R.l ? -1 : 0;
      if (dir && !banned[dir]) pend = { dir, bk: c, followed: false, bc: K };
    }
  });
  return out;
}

export function k2Context(P, days, orMin) {
  const ors = openingRanges(P, days, orMin);
  ors.orMin = orMin;
  const avg = (key) => ors.map((_, k) => { const prev = []; for (let j = k - 1; j >= 0 && prev.length < 20; j--) if (ors[j]) prev.push(ors[j][key]); return prev.length >= 10 ? prev.reduce((s, x) => s + x, 0) / prev.length : null; });
  return { ors, avgSize: avg('size'), avgVol: avg('v'), datr: dailyAtr(P, days[0]?.tz || 'UTC') };
}

// ---------------------------------------------------------------- K5
/** v: { anchor: 'session'|'midnight', tf, ema, stopAtr, tgt (null|2), side: 0|1|-1, flat: bool } */
export function runK5(P, days, v, slip) {
  const out = [];
  const E = getEma(P, v.tf, v.ema);
  days.forEach((d) => {
    if (d.have < d.expected * 0.9) return;
    const anchorT = v.anchor === 'session' ? d.S : utcFor(d.date, '00:00', d.tz);
    const vw = new Map();
    let pv = 0, vv = 0;
    for (let i = lowerBound(P.bars, anchorT); i <= d.i1; i++) {
      const w = Math.max(P.bars[i].vol || 0, 1);
      pv += ((P.mh[i] + P.ml[i] + P.mc[i]) / 3) * w; vv += w; vw.set(i, pv / vv);
    }
    const C = sessionCandles(P, d, v.tf);
    const em = C.map((K) => (v.tf === 'M5' ? E[K.e] : E[P.m15Of[K.e]]));
    const wv = C.map((K) => vw.get(K.e));
    const dist = C.map((K, c) => Math.abs(em[c] - wv[c]) / (K.atr || 1));
    const winFrom = d.S + 15 * 60000, winTo = d.E - 30 * 60000;
    let trades = 0, cool = -99;
    for (let c = 1; c < C.length - 1 && trades < 2; c++) {
      if (c - cool <= 3 || wv[c - 1] === undefined) continue;
      const tEntry = P.bars[C[c + 1].s].t;
      if (tEntry < winFrom || tEntry > winTo) continue;
      const dir = em[c] > wv[c] && em[c - 1] <= wv[c - 1] ? 1 : em[c] < wv[c] && em[c - 1] >= wv[c - 1] ? -1 : 0;
      if (!dir || (v.side && v.side !== dir)) continue;
      if (v.flat && Math.max(...dist.slice(Math.max(0, c - 5), c + 1)) <= 0.3) continue;
      const j = C[c + 1].s;
      const fillEst = dir > 0 ? P.bars[j].ao + slip : P.bars[j].bo - slip;
      const stop = fillEst - dir * v.stopAtr * C[c].atr;
      const p0 = runPosition(P, j, dir, stop, v.tgt, d.i1, slip);
      if (!p0) continue;
      let exitAt = null;
      for (let c2 = c + 1; c2 < C.length - 1; c2++) {
        if (C[c2].e >= p0.xi) break;
        if (dir > 0 ? em[c2] < wv[c2] : em[c2] > wv[c2]) { exitAt = C[c2 + 1].s; break; }
      }
      const p = exitAt !== null ? runPosition(P, j, dir, stop, v.tgt, d.i1, slip, { exitAt }) : p0;
      out.push(rec(P, d, p));
      trades++;
      let c3 = c + 1;
      while (c3 < C.length - 1 && C[c3].e < p.xi) c3++;
      cool = c3; c = c3;
    }
  });
  return out;
}
