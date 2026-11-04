#!/usr/bin/env node
// Exportiert den Gesamtvergleich als CSV (für Dashboards/Tabellen):
//   out/live/vergleich_varianten.csv, vergleich_monate.csv, datenpruefung.csv
import fs from 'node:fs';
import path from 'node:path';
import { loadResults } from '../src/report/compare.js';
import { mean, sum, round } from '../src/analysis/stats.js';

const dir = process.argv[2] || 'out/live';
const res = loadResults(dir);
const byId = Object.fromEntries(res.map((r) => [r.id, r]));
const q = (v) => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '' : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows) => [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(q).join(','))].join('\n');

const order = ['NAS100 F618ATR FTMO', 'NAS100 Fib', 'NAS100 F618ATR ATR', 'NAS100 v5.0', 'DE40 LVN', 'DE40 ORB60', 'EURUSD'];
const gi = (g) => { const i = order.findIndex((o) => g.startsWith(o)); return i < 0 ? 99 : i; };
const rows = res.sort((a, b) => gi(a.group) - gi(b.group) || (a.base ? 1 : 0) - (b.base ? 1 : 0) || a.id.localeCompare(b.id)).map((r) => {
  const s = r.summary || {};
  const base = r.base ? byId[r.base] : null;
  let d = {};
  if (base) {
    const mid = base.mid;
    const sp = (j) => [j.trades.filter((t) => t.date < mid).map((t) => t.R), j.trades.filter((t) => t.date >= mid).map((t) => t.R)];
    const [a1, a2] = sp(r), [b1, b2] = sp(base);
    const d1 = mean(a1) - mean(b1), d2 = mean(a2) - mean(b2), s1 = sum(a1) - sum(b1), s2 = sum(a2) - sum(b2);
    d = { delta_avg_r: round(s.avgR - base.summary.avgR, 3), delta_h1: round(d1, 3), delta_h2: round(d2, 3), delta_sum_r: round(s.sumR - base.summary.sumR, 2), better_both_halves: d1 > 0 && d2 > 0 && s1 >= 0 && s2 >= 0 ? 'ja' : 'nein' };
  } else d = { delta_avg_r: null, delta_h1: null, delta_h2: null, delta_sum_r: null, better_both_halves: '' };
  return {
    id: r.id, group: r.group, name: r.name, description: r.desc || '', base: r.base || '', instrument: r.symbol || 'DE40',
    period_from: r.period?.from, period_to: r.period?.to, trades: s.n || 0, trades_per_month: s.tradesPerMonth, fill_rate: r.events?.orderFillRate ?? null,
    win_rate: s.winRate, avg_r: s.avgR, avg_r_ci_low: s.avgRci90?.[0], avg_r_ci_high: s.avgRci90?.[1], sum_r: s.sumR, profit_factor: s.profitFactor, p_value: s.pValue,
    max_dd_r: s.maxDDR, max_lose_streak: s.maxLoseStreak, avg_r_first_half: round(mean(r.h1), 3), avg_r_second_half: round(mean(r.h2), 3),
    positive_quarters_pct: r.stability?.positiveQuartersPct ?? null, verdict: r.vd.t, ...d,
    orders_cancelled: r.events?.cancelled ?? null, cancelled_would_fill: r.events?.cancelledWouldFill ?? null,
    worst_day_usd_at_100k_05pct: r.family === 'NAS_FTMO' && s.worstDayPct != null ? round(s.worstDayPct * 1000, 0) : null,
    top_recommendation: (r.recommendations || []).find((x) => ['empfohlen', 'Warnung'].includes(x.status))?.title || '',
  };
});
fs.writeFileSync(path.join(dir, 'vergleich_varianten.csv'), csv(rows));
const months = [];
for (const r of res) for (const m of r.stability?.months || []) months.push({ id: r.id, name: r.name, group: r.group, month: m.period, trades: m.n, sum_r: m.sumR });
fs.writeFileSync(path.join(dir, 'vergleich_monate.csv'), csv(months));
const auditFile = 'out/datenpruefung/datenpruefung.json';
if (fs.existsSync(auditFile)) {
  const a = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  const rowsA = Object.entries(a.instruments).map(([s, x]) => ({ instrument: s, period_from: x.period.from, period_to: x.period.to, trading_days: x.tradingDays, window: x.window, window_completeness_pct: x.windowCompleteness, missing_weekdays: x.missingWeekdays.length, missing_weekday_list: x.missingWeekdays.join(' '), days_with_gaps: x.daysWithGaps, largest_gaps: x.worstGapDays.slice(0, 4).map((g) => `${g.date}: ${g.missing} Kerzen (${g.blocks})`).join(' | ') }));
  fs.writeFileSync(path.join(dir, 'datenpruefung.csv'), csv(rowsA));
}
console.log(`${rows.length} Varianten, ${months.length} Monatszeilen -> ${dir}`);
