// Ausstiegs-Analyse: Was wäre mit DENSELBEN Einstiegen bei anderem Ausstieg passiert?
//
// Alle Varianten beenden einen Trade höchstens so spät wie das Original. Damit ist der Kursverlauf
// vollständig bekannt und es gibt keine Annahmen über "was danach passiert wäre".
// Ausführung wie in der Engine: Long schließt am Bid, Short am Ask; SL+TP in einer Kerze -> SL (pessimistisch).

import { sum, mean, round } from './stats.js';

/**
 * @param {object} t   Trade aus der Engine
 * @param {Array} bars bereinigte Kerzen
 * @param {{tpR?:number, beR?:number, stopMult?:number, timeExitHm?:string}} v
 * @returns {{R:number, reason:string}}  R bezogen auf das (ggf. engere) Risiko der Variante
 */
export function simulateVariant(t, bars, v) {
  const L = t.dir === 'BUY';
  const sg = L ? 1 : -1;
  const risk0 = Math.abs(t.entry - t.stop);
  const risk = risk0 * (v.stopMult ?? 1);
  let stop = t.entry - sg * risk;
  const tp = v.tpR ? t.entry + sg * v.tpR * risk : null;
  let beArmed = false;
  for (let i = t.entryIdx; i <= t.exitIdx; i++) {
    const B = bars[i];
    if (v.timeExitHm && t.entryHm < v.timeExitHm && (B.date !== t.date || B.hm >= v.timeExitHm) && i > t.entryIdx) {
      const px = L ? B.bo : B.ao;
      return { R: ((px - t.entry) * sg) / risk, reason: 'TIME' };
    }
    if (beArmed) stop = t.entry;
    const slHit = L ? B.bl <= stop : B.ah >= stop;
    const tpHit = tp != null && (L ? B.bh >= tp : B.al <= tp);
    // Original-Ausstieg in dieser Kerze? Zum Open (Markt) oder per SL – dann kein Weiterlaufen
    const isExitBar = i === t.exitIdx;
    if (isExitBar && !['SL', 'SL_GAP', 'TP'].includes(t.reason)) {
      // Original ist zum Open dieser Kerze ausgestiegen -> Varianten konnten nur vorher greifen
      return { R: ((t.exit - t.entry) * sg) / risk, reason: 'ORIG_' + t.reason };
    }
    if (slHit) {
      const gap = i > t.entryIdx && (L ? B.bo <= stop : B.ao >= stop);
      const px = gap ? (L ? B.bo : B.ao) : stop;
      return { R: ((px - t.entry) * sg) / risk, reason: stop === t.entry ? 'BE' : 'SL' };
    }
    if (tpHit) return { R: v.tpR, reason: 'TP' };
    if (v.beR && !beArmed) {
      const fav = L ? B.bh - t.entry : t.entry - B.al;
      if (fav >= v.beR * risk) beArmed = true; // ab nächster Kerze SL auf Einstand
    }
    if (isExitBar) break;
  }
  return { R: ((t.exit - t.entry) * sg) / risk, reason: 'ORIG_' + t.reason };
}

export const DEFAULT_VARIANTS = [
  { key: 'tp1', label: 'Fester TP 1R', tpR: 1 },
  { key: 'tp1.5', label: 'Fester TP 1,5R', tpR: 1.5 },
  { key: 'tp2', label: 'Fester TP 2R', tpR: 2 },
  { key: 'tp3', label: 'Fester TP 3R', tpR: 3 },
  { key: 'be1', label: 'SL auf Einstand ab +1R', beR: 1 },
  { key: 'be1.5', label: 'SL auf Einstand ab +1,5R', beR: 1.5 },
  { key: 'sl0.75', label: 'Engerer SL (0,75×)', stopMult: 0.75 },
  { key: 'sl0.5', label: 'Engerer SL (0,5×)', stopMult: 0.5 },
  { key: 't1300', label: 'Zeit-Exit 13:00', timeExitHm: '13:00' },
  { key: 't1500', label: 'Zeit-Exit 15:00', timeExitHm: '15:00' },
  { key: 't1600', label: 'Zeit-Exit 16:00', timeExitHm: '16:00' },
];

export function analyzeExits(trades, bars, variants = DEFAULT_VARIANTS) {
  if (!trades.length) return { variants: [], mfe: null };
  const sorted = [...trades].sort((a, b) => a.entryT - b.entryT);
  const half = Math.floor(sorted.length / 2);
  const firstIds = new Set(sorted.slice(0, half).map((t) => t.id));
  const base = trades.map((t) => t.R);
  const baseH1 = trades.filter((t) => firstIds.has(t.id)).map((t) => t.R);
  const baseH2 = trades.filter((t) => !firstIds.has(t.id)).map((t) => t.R);
  const res = variants.map((v) => {
    const sims = trades.map((t) => ({ id: t.id, ...simulateVariant(t, bars, v) }));
    const R = sims.map((s) => s.R);
    const h1 = sims.filter((s) => firstIds.has(s.id)).map((s) => s.R);
    const h2 = sims.filter((s) => !firstIds.has(s.id)).map((s) => s.R);
    const d1 = mean(h1) - mean(baseH1), d2 = mean(h2) - mean(baseH2);
    return {
      key: v.key, label: v.label, spec: v, avgR: round(mean(R), 3), sumR: round(sum(R), 2),
      winRate: round(R.filter((x) => x > 0).length / R.length, 3),
      deltaAvgR: round(mean(R) - mean(base), 3), deltaH1: round(d1, 3), deltaH2: round(d2, 3),
      robust: d1 > 0 && d2 > 0,
    };
  }).sort((a, b) => b.deltaAvgR - a.deltaAvgR);

  // MFE/MAE-Profil
  const losers = trades.filter((t) => t.R <= 0);
  const winners = trades.filter((t) => t.R > 0);
  const share = (arr, f) => (arr.length ? round(arr.filter(f).length / arr.length, 3) : null);
  const mfe = {
    losersReached1R: share(losers, (t) => t.mfeR >= 1),
    losersReached05R: share(losers, (t) => t.mfeR >= 0.5),
    winnersMaxAdverseOver05R: share(winners, (t) => t.maeR > 0.5),
    winnersMaxAdverseOver075R: share(winners, (t) => t.maeR > 0.75),
    avgWinnerCapture: winners.length ? round(mean(winners.map((t) => (t.mfeR > 0 ? t.R / t.mfeR : 1))), 3) : null,
    avgMfeR: round(mean(trades.map((t) => t.mfeR)), 3),
    avgMaeR: round(mean(trades.map((t) => t.maeR)), 3),
  };
  return { baseAvgR: round(mean(base), 3), variants: res, mfe };
}
