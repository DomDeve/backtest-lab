// Robustheit: Stabilität über die Zeit, Monte-Carlo-Drawdowns, FTMO-Challenge-Simulation, Risiko-Empfehlung.
import { mean, quantile, sum, rng, round } from './stats.js';
import { byPeriod, quarterOf } from './metrics.js';

/** Stabilität: Anteil positiver Quartale/Monate, erste vs. zweite Hälfte */
export function stability(trades) {
  const q = byPeriod(trades, quarterOf);
  const m = byPeriod(trades);
  const sorted = [...trades].sort((a, b) => a.entryT - b.entryT);
  const h = Math.floor(sorted.length / 2);
  const a = sorted.slice(0, h).map((t) => t.R), b = sorted.slice(h).map((t) => t.R);
  return {
    quarters: q,
    months: m,
    positiveQuartersPct: q.length ? round((q.filter((x) => x.sumR > 0).length / q.length) * 100, 1) : null,
    positiveMonthsPct: m.length ? round((m.filter((x) => x.sumR > 0).length / m.length) * 100, 1) : null,
    firstHalfAvgR: round(mean(a), 3),
    secondHalfAvgR: round(mean(b), 3),
  };
}

function maxDDPct(Rs, riskPct) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of Rs) {
    eq *= 1 + (r * riskPct) / 100;
    if (eq > peak) peak = eq;
    dd = Math.max(dd, (peak - eq) / peak);
  }
  return dd * 100;
}

/** Monte-Carlo: Reihenfolge der Trades mischen -> Verteilung des maximalen Drawdowns */
export function monteCarloDD(R, riskPct, { runs = 2000, seed = 7, ddLimitPct = 10 } = {}) {
  if (R.length < 10) return null;
  const rand = rng(seed);
  const dds = [];
  const a = [...R];
  for (let k = 0; k < runs; k++) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    dds.push(maxDDPct(a, riskPct));
  }
  return {
    riskPct, p50: round(quantile(dds, 0.5), 2), p95: round(quantile(dds, 0.95), 2), p99: round(quantile(dds, 0.99), 2),
    probOverLimit: round(dds.filter((d) => d >= ddLimitPct).length / runs, 3), ddLimitPct,
  };
}

/**
 * FTMO-artige Challenge simulieren: Trades zufällig (mit Zurücklegen) ziehen, bis Ziel erreicht,
 * Max-Verlust gerissen, Tagesverlust gerissen oder Zeit abgelaufen.
 * Achtung: basiert auf der Backtest-Verteilung -> eher optimistisch.
 */
export function challengeSim(trades, riskPct, { target = 10, maxLoss = 10, dailyLoss = 5, days = 60, runs = 3000, seed = 11, tradingDays } = {}) {
  // Trades je Handelstag gruppieren, damit Tagesverluste realistisch sind
  const byDay = {};
  for (const t of trades) (byDay[t.date] ||= []).push(t.R);
  const dayList = Object.values(byDay);
  if (dayList.length < 10) return null;
  // Anteil Tage ohne Trade berücksichtigen (tradingDays = Handelstage im Testzeitraum)
  const pTradeDay = Math.min(1, dayList.length / Math.max(tradingDays || dayList.length, dayList.length));
  const rand = rng(seed);
  let pass = 0, fail = 0;
  const daysToPass = [];
  for (let k = 0; k < runs; k++) {
    let eq = 100;
    let done = false;
    for (let d = 1; d <= days && !done; d++) {
      if (rand() > pTradeDay) continue;
      const dayStart = eq;
      for (const r of dayList[Math.floor(rand() * dayList.length)]) {
        eq *= 1 + (r * riskPct) / 100; // Risiko vom aktuellen Konto (wie der Bot); Limits relativ zum Start (wie FTMO)
        if (eq <= 100 - maxLoss || dayStart - eq >= dailyLoss) { fail++; done = true; break; }
        if (eq >= 100 + target) { pass++; daysToPass.push(d); done = true; break; }
      }
    }
  }
  return {
    riskPct, target, maxLoss, days,
    passProb: round(pass / runs, 3), failProb: round(fail / runs, 3), timeoutProb: round(1 - (pass + fail) / runs, 3),
    medianDaysToPass: daysToPass.length ? quantile(daysToPass, 0.5) : null,
  };
}

/** Höchstes Risiko je Trade, bei dem P(Max-DD >= Limit) <= maxProb */
export function suggestRisk(R, { ddLimitPct = 10, maxProb = 0.05, candidates = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2] } = {}) {
  let best = null;
  const table = [];
  for (const c of candidates) {
    const mc = monteCarloDD(R, c, { runs: 1000, ddLimitPct });
    if (!mc) return null;
    table.push(mc);
    if (mc.probOverLimit <= maxProb) best = c;
  }
  return { suggested: best, table };
}

/** In-Sample / Out-of-Sample nach Datum (Default 60/40) */
export function splitByDate(days, isShare = 0.6) {
  const d = days.map((x) => x.date);
  const cut = d[Math.floor(d.length * isShare)];
  return { is: { from: d[0], to: d[Math.floor(d.length * isShare) - 1] }, oos: { from: cut, to: d[d.length - 1] } };
}

export { sum };
