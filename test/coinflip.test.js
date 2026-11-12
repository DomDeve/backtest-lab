import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, coinflip, mulberry32 } from '../tools/coinflip.js';

const bar = (t, mid, sp = 1, rng = 2) => ({ t, bo: mid - sp / 2, bh: mid + rng - sp / 2, bl: mid - rng - sp / 2, bc: mid - sp / 2, ao: mid + sp / 2, ah: mid + rng + sp / 2, al: mid - rng + sp / 2, ac: mid + sp / 2 });

test('Simulator: TP, SL, SL-Vorrang, Gap', () => {
  const up = [0, 1, 2, 3, 4, 5, 6].map((k) => bar(k * 300000, 100 + k * 5));
  assert.equal(simulate(up, 0, 'BUY', 100.5, 10, 10), 1);    // Long läuft zum TP
  assert.ok(Math.abs(simulate(up, 0, 'SELL', 99.5, 10, 10) + 1.1) < 1e-9); // Short: Open springt über SL -> −1,1R
  const flat = [bar(0, 100), bar(300000, 100, 1, 12)]; assert.equal(simulate(flat, 0, 'BUY', 100.5, 10, 10), -1); // SL und TP in einer Kerze -> SL
  const gap = [bar(0, 100), bar(300000, 70)];
  assert.ok(simulate(gap, 0, 'BUY', 100.5, 10, 20) < -2);    // Gap: Fill zum Open, schlechter als −1R
});

test('Coinflip: Richtung mit Information -> kleines p, reine Drift -> großes p', () => {
  const rnd = mulberry32(3); const smart = [], drift = [];
  for (let i = 0; i < 400; i++) { const up = rnd() < 0.5; smart.push({ orig: up ? 'BUY' : 'SELL', R: 0, rL: up ? 1 : -1, rS: up ? -1 : 1 });
    drift.push({ orig: 'BUY', R: 0, rL: rnd() < 0.55 ? 1 : -1, rS: rnd() < 0.45 ? 1 : -1 }); }
  assert.ok(coinflip(smart, { runs: 300 }).p < 0.01);
  const d = coinflip(drift.map((o, i) => ({ ...o, orig: i % 2 ? 'BUY' : 'SELL' })), { runs: 300 }); assert.ok(d.p > 0.05);
});

test('Auswahl mittesten: beste von N wird bestraft, echtes Signal bleibt erkennbar', async () => {
  const { coinflipSelect } = await import('../tools/coinflip.js');
  const rnd = mulberry32(11); const T = [...Array(300)].map((_, i) => i * 300000);
  const noise = (seed) => { const r = mulberry32(seed); return T.map((t) => ({ t, orig: r() < 0.5 ? 'BUY' : 'SELL', R: 0, rL: r() < 0.5 ? 1 : -1, rS: r() < 0.5 ? 1 : -1 })); };
  const sets = [...Array(20)].map((_, k) => ({ id: 'z' + k, name: 'z' + k, O: noise(100 + k) }));
  const r = coinflipSelect(sets, { runs: 300 });
  assert.ok(r.best.pSel > 0.05, 'beste Zufallsvariante darf nach Auswahl-Korrektur nicht signifikant sein');
  const smart = T.map((t) => { const up = rnd() < 0.5; return { t, orig: up ? 'BUY' : 'SELL', R: 0, rL: up ? 1 : -1, rS: up ? -1 : 1 }; });
  const r2 = coinflipSelect([...sets, { id: 's', name: 's', O: smart }], { runs: 300 });
  assert.equal(r2.best.id, 's'); assert.ok(r2.best.pSel < 0.01);
});
