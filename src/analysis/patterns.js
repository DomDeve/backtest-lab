// Muster-Analyse: in welchen Situationen ist die Strategie stark bzw. schwach?
//
// Jeder Trade wird nach Dimensionen segmentiert (Richtung, Wochentag, Stunde, Marktumfeld, Strategie-Merkmale).
// Für jedes Segment: Ergebnis vs. Rest (Welch-t-Test) + Konsistenz über Zeitabschnitte.
// Weil sehr viele Segmente getestet werden, ist ein einzelner "signifikanter" Treffer wenig wert –
// deshalb zählt vor allem die Konsistenz über die Zeit (Folds) und die Korrektur für Mehrfachtests (BH-q).

import { sum, mean, quantile, welch, round } from './stats.js';
import { WEEKDAYS_DE } from '../core/time.js';

export const FIELD_LABELS = {
  dir: 'Richtung', wd: 'Wochentag', hour: 'Signal-Stunde', ctx_prevDay: 'Vortag', ctx_atr14: 'ATR14 (Tagesrange Ø)',
  ctx_prevRangeRel: 'Vortagesrange / ATR', ctx_gapRel: 'Eröffnungs-Gap / ATR', ctx_trend5Rel: '5-Tage-Trend / ATR',
  ctx_prevRange: 'Vortagesrange (Pkt)', ctx_gapPts: 'Gap (Pkt)',
  rangePts: 'Range (Pkt)', rangeRel: 'Range / ATR', breakoutPts: 'Ausbruch über Range (Pkt)',
  signalMinutesAfterRange: 'Minuten nach Range-Ende', stopPts: 'SL-Abstand (Pkt)', stopRel: 'SL-Abstand / ATR',
  sigma: 'σ (Noise-Profil)', moveFromOpenPct: 'Bewegung seit Open (%)', spreadEntry: 'Spread beim Einstieg',
};
const label = (f) => FIELD_LABELS[f] || f;
const fmtVal = (f, v) => (f === 'wd' ? WEEKDAYS_DE[v] : f === 'hour' ? `${v}:00–${v}:59` : String(v));

// Felder, die keine Einstiegsfilter sein können (erst nach dem Einstieg bekannt) oder redundant sind
const EXCLUDE = new Set(['ctx_month', 'ctx_gapPts', 'ctx_prevRange']);

export function tradeFields(t) {
  return { dir: t.dir, wd: t.wd, hour: Number((t.signalHm || t.entryHm).slice(0, 2)), spreadEntry: t.spreadEntry, ...t.features };
}

/** Segmente bilden: kategorisch direkt, numerisch in Terzile (ab 150 Trades Quartile). */
export function buildSegments(trades, { minN } = {}) {
  const N = trades.length;
  const min = minN ?? Math.max(10, Math.round(N * 0.08));
  const rows = trades.map((t) => ({ t, f: tradeFields(t) }));
  const fields = new Set();
  rows.forEach((r) => Object.keys(r.f).forEach((k) => !EXCLUDE.has(k) && fields.add(k)));
  const segs = [];
  for (const field of fields) {
    const vals = rows.map((r) => r.f[field]).filter((v) => v !== null && v !== undefined);
    if (vals.length < N * 0.6) continue; // zu viele Lücken
    const numeric = vals.every((v) => typeof v === 'number') && new Set(vals).size > 6;
    if (numeric) {
      const k = N >= 150 ? 4 : 3;
      const cuts = Array.from({ length: k - 1 }, (_, i) => quantile(vals, (i + 1) / k));
      const edges = [-Infinity, ...cuts, Infinity];
      for (let b = 0; b < k; b++) {
        const lo = edges[b], hi = edges[b + 1];
        if (b > 0 && lo === edges[b - 1]) continue;
        const inSeg = (v) => v !== null && v !== undefined && v > lo && v <= hi;
        const name = b === 0 ? `≤ ${round(hi, 3)}` : b === k - 1 ? `> ${round(lo, 3)}` : `${round(lo, 3)} – ${round(hi, 3)}`;
        segs.push({ field, kind: 'num', bucket: `${b + 1}/${k}`, valueLabel: name, test: inSeg, filter: { field, op: 'notBetween', min: lo === -Infinity ? null : lo + 1e-9, max: hi === Infinity ? null : hi } });
      }
    } else {
      for (const v of new Set(vals)) segs.push({ field, kind: 'cat', value: v, valueLabel: fmtVal(field, v), test: (x) => x === v, filter: { field, op: 'notIn', values: [v] } });
    }
  }
  return { rows, segs, minN: min };
}

/** Chronologische Folds (für Konsistenz-Prüfung) */
export function folds(trades, k = 3) {
  const sorted = [...trades].sort((a, b) => a.entryT - b.entryT);
  const size = Math.ceil(sorted.length / k);
  return Array.from({ length: k }, (_, i) => new Set(sorted.slice(i * size, (i + 1) * size).map((t) => t.id)));
}

function benjaminiHochberg(list) {
  const valid = list.filter((x) => Number.isFinite(x.p)).sort((a, b) => a.p - b.p);
  const m = valid.length;
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    prev = Math.min(prev, (valid[i].p * m) / (i + 1));
    valid[i].q = round(prev, 4);
  }
}

export function analyzePatterns(trades, opts = {}) {
  const N = trades.length;
  if (N < 20) return { tooFew: true, n: N, segments: [], strengths: [], weaknesses: [] };
  const { rows, segs, minN } = buildSegments(trades, opts);
  const allR = trades.map((t) => t.R);
  const avgAll = mean(allR);
  const F = folds(trades, 3);
  const out = [];
  for (const s of segs) {
    const inR = [], outR = [];
    const foldIn = F.map(() => []), foldOut = F.map(() => []);
    for (const r of rows) {
      const hit = s.test(r.f[s.field]);
      (hit ? inR : outR).push(r.t.R);
      F.forEach((fs, i) => { if (fs.has(r.t.id)) (hit ? foldIn[i] : foldOut[i]).push(r.t.R); });
    }
    if (inR.length < minN || outR.length < minN) continue;
    const w = welch(inR, outR);
    const diff = mean(inR) - mean(outR);
    const sameSign = foldIn.map((fi, i) => (fi.length >= 3 && foldOut[i].length >= 3 ? Math.sign(mean(fi) - mean(foldOut[i])) === Math.sign(diff) : null)).filter((x) => x !== null);
    out.push({
      field: s.field, fieldLabel: label(s.field), kind: s.kind, valueLabel: s.valueLabel, bucket: s.bucket ?? null,
      n: inR.length, share: round(inR.length / N, 3), avgR: round(mean(inR), 3), sumR: round(sum(inR), 2),
      winRate: round(inR.filter((x) => x > 0).length / inR.length, 3), restAvgR: round(mean(outR), 3),
      diffR: round(diff, 3), p: round(w.p, 4), foldsConsistent: sameSign.filter(Boolean).length, foldsTested: sameSign.length,
      foldAvgR: foldIn.map((fi) => (fi.length ? round(mean(fi), 3) : null)),
      filter: s.filter,
    });
  }
  benjaminiHochberg(out);
  const consistent = (x) => x.foldsTested >= 2 && x.foldsConsistent === x.foldsTested;
  const weaknesses = out
    .filter((x) => x.diffR < 0 && x.avgR < Math.min(0, avgAll) + 1e-9 && x.p < 0.2 && x.sumR < 0)
    .map((x) => ({ ...x, consistent: consistent(x) }))
    .sort((a, b) => (b.consistent - a.consistent) || (a.sumR - b.sumR));
  const strengths = out
    .filter((x) => x.diffR > 0 && x.avgR > Math.max(0, avgAll) && x.p < 0.2)
    .map((x) => ({ ...x, consistent: consistent(x) }))
    .sort((a, b) => (b.consistent - a.consistent) || (b.sumR - a.sumR));
  return { n: N, minN, avgR: round(avgAll, 3), tested: out.length, segments: out, strengths: strengths.slice(0, 8), weaknesses: weaknesses.slice(0, 8) };
}

/** Kompakte Tabelle je Dimension (für den Report), z.B. Ergebnis je Wochentag/Stunde/Richtung */
export function dimensionTable(trades, field) {
  const g = new Map();
  for (const t of trades) {
    const v = tradeFields(t)[field];
    if (v === undefined || v === null) continue;
    if (!g.has(v)) g.set(v, []);
    g.get(v).push(t.R);
  }
  return [...g.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).map(([v, R]) => ({
    value: fmtVal(field, v), n: R.length, avgR: round(mean(R), 3), sumR: round(sum(R), 2), winRate: round(R.filter((x) => x > 0).length / R.length, 3),
  }));
}
