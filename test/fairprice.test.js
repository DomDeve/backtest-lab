import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessions, runVariant, fpReach, INSTRUMENTS } from '../src/candidates/fairprice.js';

// Synthetische US100-Kerzen (M5) an einem Wintertag: 09:30 New York = 14:30 UTC. Spread 1 Punkt.
function day(pattern) {
  const t0 = Date.parse('2026-01-13T04:30:00Z'); // 120 Kerzen vor Sessionbeginn
  const bars = [];
  let p = 20000;
  for (let i = 0; i < 120; i++) bars.push(mk(t0 + i * 300000, p, p + 2, p - 2, p));
  pattern.forEach(([o, h, l, c], k) => bars.push(mk(t0 + (120 + k) * 300000, o, h, l, c)));
  for (let k = bars.length; k < 120 + 40; k++) { const c = bars[bars.length - 1].bc + 0.5; bars.push(mk(t0 + k * 300000, c, c + 1, c - 1, c)); }
  return bars;
}
// Mitte = Bid + 0,5; Ask = Bid + 1
const mk = (t, o, h, l, c) => ({ t, bo: o - 0.5, bh: h - 0.5, bl: l - 0.5, bc: c - 0.5, ao: o + 0.5, ah: h + 0.5, al: l + 0.5, ac: c + 0.5 });

test('Fair Price: Session 09:30 New York DST-korrekt, FP = Eröffnung der ersten Kerze', () => {
  const bars = day([[20000, 20010, 19998, 20008]]);
  const s = buildSessions(bars, INSTRUMENTS.US100.sessions.main);
  assert.equal(s.length, 1);
  assert.equal(new Date(bars[s[0].i0].t).toISOString().slice(11, 16), '14:30');
  assert.equal(s[0].fp, 20000);
});

test('Fair Price Setup A: grüne Eröffnungskerze, Bruch des Vorhochs -> Long zum nächsten Open, TP = 38/25 R', () => {
  const bars = day([[20000, 20010, 19998, 20008], [20008, 20014, 20006, 20012], [20012, 20020, 20011, 20019], [20019, 20060, 20018, 20058]]);
  const s = buildSessions(bars, INSTRUMENTS.US100.sessions.main);
  const tr = runVariant(bars, s, { setup: 'A', bias: 'off', sl: 25, tp: 38, slip: 0 });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].dir, 'BUY');
  assert.equal(tr[0].reason, 'TP');
  assert.ok(Math.abs(tr[0].R - 38 / 25) < 1e-9);
});

test('Fair Price Setup A: SL und TP in derselben Kerze -> SL', () => {
  const bars = day([[20000, 20010, 19998, 20008], [20008, 20014, 20006, 20012], [20012, 20013, 20011, 20012], [20012, 20080, 19950, 20000]]);
  const s = buildSessions(bars, INSTRUMENTS.US100.sessions.main);
  const tr = runVariant(bars, s, { setup: 'A', bias: 'off', sl: 25, tp: 38, slip: 0 });
  assert.equal(tr[0].reason, 'SL_KONFLIKT');
  assert.ok(tr[0].R < -0.99);
});

test('Fair Price Setup B1: Verschiebungskerze über FP -> Short, nur bei genug Abstand zum FP', () => {
  // Kurs läuft auf +60 über FP, dann grüne Kerze, danach große rote Kerze unter das Tief der Vorkerze
  const pat = [[20000, 20005, 19999, 20004], [20004, 20030, 20003, 20028], [20028, 20055, 20027, 20054], [20054, 20062, 20053, 20060], [20060, 20061, 20040, 20042], [20042, 20043, 20000, 20001]];
  const bars = day(pat);
  const s = buildSessions(bars, INSTRUMENTS.US100.sessions.main);
  const tr = runVariant(bars, s, { setup: 'B1', sl: 25, tp: 38, slip: 0 });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].signal, 'B1');
  assert.equal(tr[0].dir, 'SELL');
  assert.equal(tr[0].reason, 'TP');
  // TP-Strecke 75: Abstand 42 Punkte zum FP < 80 % -> kein Trade
  assert.equal(runVariant(bars, s, { setup: 'B1', sl: 75, tp: 75, slip: 0 }).length, 0);
  const fp = fpReach(bars, s, () => 25)[0];
  assert.equal(fp.reached, true);
  assert.equal(fp.reachedAfterAway, true);
});
