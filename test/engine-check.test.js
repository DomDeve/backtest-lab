// Engine-Gegenprobe auf synthetischem Zufallspfad (Martingal): Zufallseinstiege müssen in Bid-Basis ≈ 0 liefern,
// jeder Trade muss sich unabhängig nachrechnen lassen, und eine eingepflanzte Kante (Orakel) muss sichtbar sein.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcFor } from '../src/core/time.js';
import { cleanBars } from '../src/data/clean.js';
import { runBacktest } from '../src/core/engine.js';
import { mulberry32, windows, testStrategy, resimulate } from '../tools/engine-check.js';

function synthetic(nDays = 250, seed = 42) {
  const rnd = mulberry32(seed), gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const raw = [];
  let p = 20000, d = new Date('2025-01-02T12:00:00Z'), n = 0;
  while (n < nDays) {
    const wd = d.getUTCDay(), date = d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 86400000);
    if (wd === 0 || wd === 6) continue;
    n++;
    const t0 = utcFor(date, '08:00');
    for (let i = 0; i < 132; i++) { // 08:00–19:00 Berlin
      const o = p, path = [o];
      for (let k = 0; k < 5; k++) path.push(path.at(-1) + gauss() * 2);
      p = path.at(-1);
      const h = Math.max(...path), l = Math.min(...path), s = 1;
      raw.push({ t: t0 + i * 300000, bo: o - s / 2, bh: h - s / 2, bl: l - s / 2, bc: p - s / 2, ao: o + s / 2, ah: h + s / 2, al: l + s / 2, ac: p + s / 2 });
    }
  }
  return cleanBars(raw, { session: { from: '09:00', to: '17:25' } });
}

test('Engine-Gegenprobe: Zufallseinstiege ≈ 0 in Bid-Basis, Nachrechnung identisch, Orakel-Kante sichtbar', () => {
  const { bars, days } = synthetic();
  const W = windows('DE40', bars);
  const E = { startBalance: 1e6, riskPercent: 0.1, compounding: false, maxSize: 1e9, minSize: 0, sizeDecimals: 6 };
  const rb = [];
  let n = 0, same = 0;
  for (let s = 1; s <= 10; s++) {
    const strat = testStrategy({ mode: 'random', seed: s, tpR: 1, bars, W, epic: 'DE40' });
    const out = runBacktest({ bars, days, strategy: strat, engine: E });
    for (const t of out.trades) {
      rb.push(t.R + t.spreadEntry / t.riskPts);
      const decided = (j) => { const B = bars[j], w = W[B.date]; return j >= t.entryIdx && (!w || B.date !== t.date || B.t + 5 * 60000 >= w.close - 10 * 60000); };
      const x = resimulate(bars, { ...t, stop: strat.log[t.entryIdx], tpR: 1 }, decided);
      const rr = (t.dir === 'BUY' ? x.px - x.e : x.e - x.px) / x.risk;
      n++; if (x.j === t.exitIdx && Math.abs(rr - t.R) < 0.002) same++;
    }
  }
  const m = rb.reduce((a, b) => a + b, 0) / rb.length;
  assert.ok(rb.length > 3000, `zu wenige Trades: ${rb.length}`);
  assert.ok(Math.abs(m) < 0.05, `Zufall in Bid-Basis nicht ≈ 0: ${m}`);
  assert.equal(same, n, 'unabhängige Nachrechnung weicht ab');
  const oracle = runBacktest({ bars, days, strategy: testStrategy({ mode: 'oracle', seed: 1, q: 1, bars, W, epic: 'DE40' }), engine: E });
  const mo = oracle.trades.reduce((a, t) => a + t.R, 0) / oracle.trades.length;
  assert.ok(mo > 0.5, `Orakel-Kante nicht sichtbar: ${mo}`);
});
