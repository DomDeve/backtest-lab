// Kennzahlen eines Trade-Sets. Primär in R (risikonormiert, unabhängig von Kontogröße), zusätzlich in EUR/%.
import { sum, mean, std, median, tTestMean, bootstrapMeanCI, round } from './stats.js';

export function maxDrawdown(series) {
  let peak = -Infinity, dd = 0, ddStart = null, ddEnd = null, curStart = null;
  series.forEach((v, i) => {
    if (v > peak) { peak = v; curStart = i; }
    if (peak - v > dd) { dd = peak - v; ddStart = curStart; ddEnd = i; }
  });
  return { dd, ddStart, ddEnd };
}

export function summarize(trades, { startBalance = 10000 } = {}) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const R = trades.map((t) => t.R);
  const wins = R.filter((x) => x > 0), losses = R.filter((x) => x <= 0);
  const grossWin = sum(wins), grossLoss = -sum(losses);

  // R-Kurve + Drawdown in R
  let cum = 0;
  const curveR = [0, ...R.map((x) => (cum += x))];
  const ddR = maxDrawdown(curveR);

  // Konto-Kurve + Drawdown in %
  let bal = startBalance;
  const curveBal = [bal, ...trades.map((t) => (bal += t.pnl))];
  let peak = startBalance, ddPct = 0;
  for (const v of curveBal) { peak = Math.max(peak, v); ddPct = Math.max(ddPct, (peak - v) / peak); }

  // Serien
  let streak = 0, maxLoseStreak = 0, wstreak = 0, maxWinStreak = 0;
  for (const x of R) {
    if (x <= 0) { streak++; wstreak = 0; } else { wstreak++; streak = 0; }
    maxLoseStreak = Math.max(maxLoseStreak, streak); maxWinStreak = Math.max(maxWinStreak, wstreak);
  }

  // Tagesergebnisse (FTMO: Tagesverlust-Limit)
  const byDay = {};
  for (const t of trades) (byDay[t.exitDate || t.date] ||= []).push(t);
  let b = startBalance, worstDayPct = 0, posDays = 0;
  for (const d of Object.keys(byDay).sort()) {
    const p = sum(byDay[d].map((t) => t.pnl));
    const pct = p / b;
    worstDayPct = Math.min(worstDayPct, pct);
    if (p > 0) posDays++;
    b += p;
  }

  const tt = tTestMean(R);
  const ci = bootstrapMeanCI(R);
  const months = new Set(trades.map((t) => t.date.slice(0, 7))).size;
  const winnersMfe = trades.filter((t) => t.R > 0 && t.mfeR > 0);
  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;

  return {
    n,
    winRate: round(wins.length / n, 3),
    avgR: round(mean(R), 3),
    medianR: round(median(R), 3),
    sumR: round(sum(R), 2),
    stdR: round(std(R), 3),
    avgWinR: round(mean(wins), 3),
    avgLossR: round(mean(losses), 3),
    payoff: losses.length && wins.length ? round(mean(wins) / Math.abs(mean(losses)), 2) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    sqn: round((Math.sqrt(Math.min(n, 100)) * mean(R)) / std(R), 2),
    tStat: round(tt.t, 2),
    pValue: round(tt.p, 4),
    avgRci90: [round(ci[0], 3), round(ci[1], 3)],
    maxDDR: round(ddR.dd, 2),
    maxDDPct: round(ddPct * 100, 2),
    worstDayPct: round(worstDayPct * 100, 2),
    positiveDaysPct: round((posDays / Object.keys(byDay).length) * 100, 1),
    maxLoseStreak,
    maxWinStreak,
    tradesPerMonth: round(n / Math.max(1, months), 1),
    avgMinutesHeld: round(mean(trades.map((t) => t.minutesHeld)), 0),
    netPnl: round(sum(trades.map((t) => t.pnl)), 2),
    returnPct: round((sum(trades.map((t) => t.pnl)) / startBalance) * 100, 2),
    mfeCapture: winnersMfe.length ? round(mean(winnersMfe.map((t) => t.R / t.mfeR)), 3) : null,
    conflicts: trades.filter((t) => t.conflict).length,
    exits: reasons,
    curveR: curveR.map((x) => round(x, 3)),
  };
}

/** Ergebnis je Kalenderquartal/-monat für Stabilitätsprüfung */
export function byPeriod(trades, key = (t) => t.date.slice(0, 7)) {
  const g = {};
  for (const t of trades) (g[key(t)] ||= []).push(t.R);
  return Object.keys(g).sort().map((k) => ({ period: k, n: g[k].length, sumR: round(sum(g[k]), 2), avgR: round(mean(g[k]), 3) }));
}

export const quarterOf = (t) => `${t.date.slice(0, 4)}-Q${Math.floor((Number(t.date.slice(5, 7)) - 1) / 3) + 1}`;
