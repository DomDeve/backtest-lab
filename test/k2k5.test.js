// Kandidaten K1/K2/K5: Regeln an konstruierten Kerzen (DE40, Di 10.03.2026, Session 09:00 Berlin = 08:00 UTC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, sessionDays, k2Context, runK1, runK2, runK5 } from '../src/candidates/k2k5.js';

const T0 = Date.parse('2026-03-10T06:00:00Z');
// mids: [o,h,l,c] je 5 Minuten ab 06:00 UTC; Bid = Mitte − 0,5, Ask = Mitte + 0,5
function mkBars(path) {
  return path.map(([o, h, l, c], i) => ({ t: T0 + i * 300000, bo: o - 0.5, bh: h - 0.5, bl: l - 0.5, bc: c - 0.5, ao: o + 0.5, ah: h + 0.5, al: l + 0.5, ac: c + 0.5, vol: 10 }));
}
function scenario(follow, after) {
  const p = [];
  for (let i = 0; i < 24; i++) p.push([100, 101, 99, 100]); // 06:00–07:55 Vorlauf (ATR ≈ 2)
  p.push([100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]); // 08:00–08:10 OR 99–101
  p.push([100, 102.5, 100, 102.2]); // 08:15 Ausbruch
  p.push(follow); // 08:20 Folgekerze
  for (const x of after) p.push(x);
  while (p.length < 24 + 3 + 2 + after.length + 100) { const c = p.at(-1)[3]; p.push([c, c + 0.6, c - 0.2, c + 0.4]); } // stetig steigend
  return mkBars(p);
}
const day = (P) => sessionDays(P, { epic: 'DE40', session: 'cash' }).filter((d) => d.date === '2026-03-10');

test('K2: Retest am gebrochenen Rand -> Long zum Open der Folgekerze, Ziel 2R erreicht', () => {
  const bars = scenario([102.2, 102.8, 101.8, 102.5], [[102.5, 102.6, 101.1, 101.6]]); // 08:25 Retest (Tief 101,1, Schluss > 101)
  const P = prepare(bars), D = day(P), ctx = k2Context(P, D, 15);
  const tr = runK2(P, D, ctx, { orMin: 15, tf: 'M5', tol: 0.1, tgt: 2, be: false, fade: false }, 0);
  assert.equal(tr.length, 1);
  assert.equal(new Date(tr[0][1]).toISOString().slice(11, 16), '08:30');
  assert.equal(tr[0][2], 1);
  assert.equal(tr[0][6], 'TP');
  assert.ok(Math.abs(tr[0][3] - 2) < 1e-6);
});

test('K2: Fakeout (Folgekerze schließt in der Range) sperrt die Richtung; Fade handelt die Gegenrichtung', () => {
  const bars = scenario([102.2, 102.3, 100.2, 100.5], [[100.5, 101.6, 100.4, 101.4], [101.4, 101.5, 100.8, 101.3]]);
  const P = prepare(bars), D = day(P), ctx = k2Context(P, D, 15);
  const v = { orMin: 15, tf: 'M5', tol: 0.2, tgt: 2, be: false, fade: false };
  assert.equal(runK2(P, D, ctx, v, 0).filter((t) => t[2] > 0).length, 0);
  const f = runK2(P, D, ctx, { ...v, fade: true }, 0);
  assert.equal(f.length, 1);
  assert.equal(f[0][2], -1);
  assert.equal(f[0][13], 1); // als Fade markiert
});

test('K1: erster Schluss jenseits der Range -> Market, Stop gegenüberliegende Seite, Ziel 1,5R', () => {
  const bars = scenario([102.2, 102.8, 101.8, 102.5], []);
  const P = prepare(bars), D = day(P), ctx = k2Context(P, D, 15);
  const tr = runK1(P, D, ctx.ors, { slip: 0, tgt: 1.5 });
  assert.equal(tr.length, 1);
  assert.equal(new Date(tr[0][1]).toISOString().slice(11, 16), '08:20');
  assert.equal(tr[0][6], 'TP');
  assert.ok(Math.abs(tr[0][3] - 1.5) < 1e-6);
});

test('K5: EMA kreuzt VWAP nach oben -> Long frühestens 15 min nach Session-Start, max. 2 Trades', () => {
  const p = [];
  for (let i = 0; i < 30; i++) p.push([100, 100.3, 99.7, 100]);
  for (let i = 0; i < 40; i++) { const c = 100 + i * 0.3; p.push([c, c + 0.5, c - 0.1, c + 0.3]); }
  for (let i = 0; i < 40; i++) { const c = 112 - i * 0.3; p.push([c, c + 0.1, c - 0.5, c - 0.3]); }
  for (let i = 0; i < 60; i++) p.push([100, 100.3, 99.7, 100]);
  const P = prepare(mkBars(p)), D = day(P);
  const tr = runK5(P, D, { anchor: 'session', tf: 'M5', ema: 11, stopAtr: 1.5, tgt: null, side: 0, flat: false }, 0);
  assert.ok(tr.length >= 1 && tr.length <= 2);
  assert.ok(tr[0][1] >= Date.parse('2026-03-10T08:15:00Z'));
  assert.equal(tr[0][2], 1);
  assert.ok(tr.every((t) => t[7] <= Date.parse('2026-03-10T16:30:00Z')));
});
