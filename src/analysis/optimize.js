// Parameter-Optimierung OHNE Selbstbetrug:
//   * Raster wird einmal komplett gerechnet (jede Kombination über alle Tage).
//   * Auswahl nur auf In-Sample, Bewertung auf Out-of-Sample.
//   * Walk-Forward (verankert): wiederholt "auf Vergangenheit wählen, auf nächstem Abschnitt testen".
//     Die zusammengesetzten Test-Abschnitte sind die realistischste Schätzung für live.
//   * Spearman-Korrelation IS vs. OOS über alle Kombinationen: ~0 oder negativ = Parameter-Ranking ist Zufall.
//   * Plateau-Check: liegt das Optimum auf einem Plateau (Nachbarn ähnlich gut) oder auf einer Spitze?

import { runBacktest } from '../core/engine.js';
import { mean, std, sum, round } from './stats.js';

export function gridCombos(grid, max = 400) {
  const keys = Object.keys(grid || {});
  let combos = [{}];
  for (const k of keys) combos = combos.flatMap((c) => grid[k].map((v) => ({ ...c, [k]: v })));
  if (combos.length > max) throw new Error(`Raster zu groß (${combos.length} Kombinationen, max ${max}). Raster verkleinern.`);
  return combos;
}

function score(R, minTrades) {
  if (R.length < minTrades) return -Infinity;
  // avgR, bestraft für wenige Trades (Standardfehler) -> konservativ
  return mean(R) - std(R) / Math.sqrt(R.length);
}

function spearman(a, b) {
  const rank = (x) => { const s = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], k) => (r[i] = k)); return r; };
  const ra = rank(a), rb = rank(b);
  const ma = mean(ra), mb = mean(rb);
  const num = sum(ra.map((x, i) => (x - ma) * (rb[i] - mb)));
  const den = Math.sqrt(sum(ra.map((x) => (x - ma) ** 2)) * sum(rb.map((x) => (x - mb) ** 2)));
  return den ? num / den : NaN;
}

const keyOf = (c) => JSON.stringify(c);

export function optimize({ bars, days, strategy, baseParams = {}, engine = {}, grid, isShare = 0.6, minTrades = 30, wfFolds = 4 }) {
  const g = grid || strategy.grid;
  const combos = gridCombos(g);
  const dates = days.map((d) => d.date);
  const cut = dates[Math.floor(dates.length * isShare)];
  const runs = combos.map((c) => {
    const res = runBacktest({ bars, days, strategy, params: { ...baseParams, ...c }, engine });
    const tr = res.trades;
    const isR = tr.filter((t) => t.date < cut).map((t) => t.R);
    const oosR = tr.filter((t) => t.date >= cut).map((t) => t.R);
    return {
      params: c, trades: tr, nIS: isR.length, nOOS: oosR.length,
      isAvgR: round(mean(isR), 3), oosAvgR: round(mean(oosR), 3), isSumR: round(sum(isR), 2), oosSumR: round(sum(oosR), 2),
      isScore: score(isR, Math.round(minTrades * isShare)), oosScore: score(oosR, Math.round(minTrades * (1 - isShare))),
    };
  });
  const valid = runs.filter((r) => Number.isFinite(r.isScore));
  valid.sort((a, b) => b.isScore - a.isScore);
  const best = valid[0] || null;
  const both = valid.filter((r) => Number.isFinite(r.oosAvgR));
  const rho = both.length >= 5 ? round(spearman(both.map((r) => r.isAvgR), both.map((r) => r.oosAvgR)), 3) : null;

  // Plateau: Nachbarn = genau ein Parameter anders (benachbarter Rasterwert)
  let plateau = null;
  if (best) {
    const nb = [];
    for (const k of Object.keys(g)) {
      const vals = g[k];
      const idx = vals.findIndex((v) => keyOf(v) === keyOf(best.params[k]));
      for (const j of [idx - 1, idx + 1]) {
        if (j < 0 || j >= vals.length) continue;
        const n = runs.find((r) => keyOf(r.params) === keyOf({ ...best.params, [k]: vals[j] }));
        if (n) nb.push(n);
      }
    }
    const nbAvg = mean(nb.map((n) => n.isAvgR));
    plateau = { neighbors: nb.length, neighborsAvgR: round(nbAvg, 3), bestAvgR: best.isAvgR, ratio: best.isAvgR > 0 ? round(nbAvg / best.isAvgR, 2) : null };
  }

  // Verankerter Walk-Forward
  const wf = [];
  const testShare = (1 - 0.4) / wfFolds;
  const oosTrades = [];
  for (let k = 0; k < wfFolds; k++) {
    const trainEnd = dates[Math.floor(dates.length * (0.4 + k * testShare))];
    const testEnd = k === wfFolds - 1 ? '9999-12-31' : dates[Math.floor(dates.length * (0.4 + (k + 1) * testShare))];
    let pick = null, pickScore = -Infinity;
    for (const r of runs) {
      const s = score(r.trades.filter((t) => t.date < trainEnd).map((t) => t.R), Math.round(minTrades * 0.4));
      if (s > pickScore) { pickScore = s; pick = r; }
    }
    if (!pick) continue;
    const test = pick.trades.filter((t) => t.date >= trainEnd && t.date < testEnd);
    oosTrades.push(...test);
    wf.push({ fold: k + 1, trainTo: trainEnd, testTo: testEnd === '9999-12-31' ? dates[dates.length - 1] : testEnd, params: pick.params, nTest: test.length, testAvgR: round(mean(test.map((t) => t.R)), 3), testSumR: round(sum(test.map((t) => t.R)), 2) });
  }
  const wfR = oosTrades.map((t) => t.R);

  return {
    combos: combos.length, cut, minTrades,
    table: runs.map(({ trades, ...r }) => ({ ...r, isScore: round(r.isScore, 3), oosScore: round(r.oosScore, 3) })).sort((a, b) => (b.isScore ?? -1e9) - (a.isScore ?? -1e9)),
    best: best ? { params: best.params, isAvgR: best.isAvgR, oosAvgR: best.oosAvgR, nIS: best.nIS, nOOS: best.nOOS } : null,
    spearmanIsOos: rho, plateau,
    walkForward: { folds: wf, n: wfR.length, avgR: round(mean(wfR), 3), sumR: round(sum(wfR), 2) },
  };
}
