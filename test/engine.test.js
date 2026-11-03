import { test } from 'node:test';
import assert from 'node:assert/strict';
import { local, utcFor, hmList } from '../src/core/time.js';
import { cleanBars } from '../src/data/clean.js';
import { loadBars } from '../src/data/load.js';
import { runBacktest, failsFilters } from '../src/core/engine.js';
import { simulateVariant } from '../src/analysis/exits.js';
import { tTwoSidedP } from '../src/analysis/stats.js';
import { loadLive, compareLive } from '../src/analysis/compare.js';
import orb from '../src/strategies/de40-orb60.js';

// Hilfen: Kerzen aus Mid-Werten (Spread 2) für einen Tag ab 09:00 Berlin
function mkDay(date, mids, startHm = '09:00', spread = 2) {
  const t0 = utcFor(date, startHm);
  return mids.map(([o, h, l, c], i) => ({
    t: t0 + i * 300000,
    bo: o - spread / 2, bh: h - spread / 2, bl: l - spread / 2, bc: c - spread / 2,
    ao: o + spread / 2, ah: h + spread / 2, al: l + spread / 2, ac: c + spread / 2,
  }));
}
const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p + 1, p - 1, p]);

// Mini-Strategie: kauft nach Kerze 0, SL/TP fest
const scripted = (actions) => ({
  id: 'x', name: 'x', defaults: {}, onBar: (ctx) => actions[ctx.dayBars.length - 1] || [],
});

test('Zeit: DST-sichere Umrechnung Berlin', () => {
  assert.equal(new Date(utcFor('2026-03-30', '09:00')).toISOString(), '2026-03-30T07:00:00.000Z'); // Sommerzeit
  assert.equal(new Date(utcFor('2026-11-02', '09:00')).toISOString(), '2026-11-02T08:00:00.000Z'); // Winterzeit
  assert.equal(local(Date.parse('2026-10-25T00:30:00Z')).hm, '02:30');
  assert.deepEqual(hmList('09:00', '09:15'), ['09:00', '09:05', '09:10', '09:15']);
});

test('Bereinigung: Duplikat, Ask<Bid, kaputte OHLC, Raster', () => {
  const bars = mkDay('2026-11-02', flat(30));
  const dirty = [...bars, { ...bars[3] }, { ...bars[4], t: bars[4].t + 60000 }];
  dirty[5] = { ...dirty[5], ao: dirty[5].bo - 1 };
  dirty[6] = { ...dirty[6], bh: dirty[6].bl - 1 };
  const c = cleanBars(dirty, { minBarsPerDay: 5 });
  assert.equal(c.report.dropped.duplicate, 1);
  assert.equal(c.report.dropped.offGrid, 1);
  assert.equal(c.report.dropped.askBelowBid, 1);
  assert.equal(c.report.dropped.ohlcBroken, 1);
  assert.equal(c.bars.length, 28);
});

test('Engine: Einstieg zum Open der nächsten Kerze am Ask, SL intrabar am Bid', () => {
  const mids = flat(10);
  mids[1] = [101, 102, 100, 101]; // Einstiegskerze: Open 101 -> Ask 102
  mids[3] = [100, 100, 89, 90]; // SL 92 wird gerissen (Bid-Low 88)
  const bars = mkDay('2026-11-02', mids);
  const c = cleanBars(bars, { minBarsPerDay: 5 });
  const r = runBacktest({ bars: c.bars, days: c.days, strategy: scripted({ 0: [{ type: 'ENTER', dir: 'BUY', stop: 92 }] }), engine: { startBalance: 10000, riskPercent: 1 } });
  const t = r.trades[0];
  assert.equal(t.entryHm, '09:05');
  assert.equal(t.entry, 102);
  assert.equal(t.exitHm, '09:15');
  assert.equal(t.reason, 'SL');
  assert.equal(t.R, -1);
  assert.equal(t.size, 10); // 100 € / 10 Pkt
});

test('Engine: SL und TP in derselben Kerze -> pessimistisch SL, markiert', () => {
  const mids = flat(10);
  mids[2] = [101, 130, 80, 100];
  const bars = mkDay('2026-11-02', mids);
  const c = cleanBars(bars, { minBarsPerDay: 5 });
  const r = runBacktest({ bars: c.bars, days: c.days, strategy: scripted({ 0: [{ type: 'ENTER', dir: 'BUY', stop: 90, tp: 120 }] }) });
  assert.equal(r.trades[0].reason, 'SL');
  assert.equal(r.trades[0].conflict, true);
  const r2 = runBacktest({ bars: c.bars, days: c.days, strategy: scripted({ 0: [{ type: 'ENTER', dir: 'BUY', stop: 90, tp: 120 }] }), engine: { conflictMode: 'optimistic' } });
  assert.equal(r2.trades[0].reason, 'TP');
});

test('Engine: Gap über den SL wird zum (schlechteren) Open ausgeführt', () => {
  const mids = flat(10);
  mids[3] = [80, 82, 78, 81];
  const bars = mkDay('2026-11-02', mids);
  const c = cleanBars(bars, { minBarsPerDay: 5 });
  const r = runBacktest({ bars: c.bars, days: c.days, strategy: scripted({ 0: [{ type: 'ENTER', dir: 'BUY', stop: 90 }] }) });
  assert.equal(r.trades[0].reason, 'SL_GAP');
  assert.equal(r.trades[0].exit, 79); // Bid-Open
  assert.ok(r.trades[0].R < -1);
});

test('Filter: notIn / notBetween', () => {
  assert.ok(failsFilters([{ field: 'wd', op: 'notIn', values: [5] }], { wd: 5 }));
  assert.equal(failsFilters([{ field: 'wd', op: 'notIn', values: [5] }], { wd: 4 }), null);
  assert.ok(failsFilters([{ field: 'rangeRel', op: 'notBetween', min: 0.5, max: 1 }], { rangeRel: 0.7 }));
  assert.equal(failsFilters([{ field: 'rangeRel', op: 'notBetween', min: null, max: 0.4 }], { rangeRel: 0.7 }), null);
});

test('Ausstiegs-Variante: fester TP greift vor dem Original-Ausstieg', () => {
  const mids = flat(12);
  mids[4] = [101, 125, 100, 110];
  const bars = mkDay('2026-11-02', mids);
  const c = cleanBars(bars, { minBarsPerDay: 5 });
  const r = runBacktest({ bars: c.bars, days: c.days, strategy: scripted({ 0: [{ type: 'ENTER', dir: 'BUY', stop: 92 }], 8: [{ type: 'EXIT', reason: 'T' }] }) });
  const t = r.trades[0];
  assert.equal(t.reason, 'T');
  const v = simulateVariant(t, c.bars, { tpR: 2 });
  assert.equal(v.reason, 'TP');
  assert.equal(v.R, 2);
});

test('Statistik: t-Verteilung p-Wert', () => {
  assert.ok(Math.abs(tTwoSidedP(2.0, 30) - 0.0546) < 0.002);
  assert.ok(Math.abs(tTwoSidedP(0, 10) - 1) < 1e-6);
});

test('ECHTE DATEN: ORB60 am 02.11.2026 identisch mit Live-Trade (ft_trades)', () => {
  // Kerzen: n8n Data Table volume_compare (Capital.com DE40, Mid + Spread)
  const { bars } = loadBars('test/fixtures/de40-capital-2026-11-02.csv');
  const c = cleanBars(bars, { minBarsPerDay: 10 });
  const r = runBacktest({ bars: c.bars, days: c.days, strategy: orb, engine: { startBalance: 30289.75, riskPercent: 0.3 } });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.dir, 'BUY');
  assert.equal(t.signalHm, '10:05');
  assert.equal(t.entryHm, '10:10');
  assert.equal(t.stop, 25800.5); // live SL
  assert.equal(t.reason, 'SL');
  assert.equal(t.exitHm, '13:15'); // live Ausstieg_hm
  assert.equal(t.pts, -76.3); // live BT_Pkt aus dem Abend-Abgleich
  assert.equal(t.size, 1.215); // live Menge
  const live = loadLive('data/live/ft_trades.json', { strategyName: 'FT ORB60 DE40' });
  const cmp = compareLive(r.trades, live, { from: '2026-11-02', to: '2026-11-02' });
  assert.equal(cmp.matchRate, 1);
});
