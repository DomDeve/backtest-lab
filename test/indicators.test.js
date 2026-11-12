// Indikatoren (tools/indicators.js) gegen unabhängige, naive Nachrechnung + Lookahead-Probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCalc, COLS } from '../tools/indicators.js';

function series(n, seed = 7) { let s = seed, p = 100; const out = [];
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < n; i++) { const o = p; const c = o + (rnd() - 0.5) * 2; const h = Math.max(o, c) + rnd() * 0.5, l = Math.min(o, c) - rnd() * 0.5; p = c;
    out.push({ t: Date.UTC(2020, 0, 6, 8, 0) + i * 300000, o, h, l, c, spread: 0.1, v: 1 + rnd() }); }
  return out; }
const col = (name) => COLS.indexOf(name);
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const session = (date) => ({ open: Date.parse(date + 'T08:00:00Z'), close: Date.parse(date + 'T16:30:00Z') });

const B = series(600);
const rows = (() => { const st = makeCalc('DE40', { session }); return B.map((b) => st(b)); })();

test('EMA/SMA wie naive Rechnung', () => {
  const c = B.map((b) => b.c);
  const sma = (i, n) => c.slice(i - n + 1, i + 1).reduce((a, x) => a + x, 0) / n;
  let e = sma(49, 50); for (let i = 50; i < 400; i++) e += (2 / 51) * (c[i] - e);
  assert.ok(close(rows[399][col('ema50')], e)); assert.ok(close(rows[399][col('sma200')], sma(399, 200)));
  assert.ok(Number.isNaN(rows[198][col('sma200')]));
});

test('RSI14 (Wilder) und ATR14 wie naive Rechnung', () => {
  const c = B.map((b) => b.c); let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } g /= 14; l /= 14;
  for (let i = 15; i <= 300; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  assert.ok(close(rows[300][col('rsi14')], 100 - 100 / (1 + g / l)));
  const tr = B.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l));
  let a = tr.slice(0, 14).reduce((x, y) => x + y, 0) / 14; for (let i = 14; i <= 300; i++) a = (a * 13 + tr[i]) / 14;
  assert.ok(close(rows[300][col('atr14')], a));
});

test('Bollinger 20/2 (Population) und Donchian', () => {
  const w = B.slice(281, 301).map((b) => b.c); const m = w.reduce((a, x) => a + x, 0) / 20; const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / 20);
  assert.ok(close(rows[300][col('bb_up')], m + 2 * sd)); assert.ok(close(rows[300][col('bb_lo')], m - 2 * sd));
  assert.equal(rows[300][col('don20_hi')], Math.max(...B.slice(281, 301).map((b) => b.h)));
});

test('kein Lookahead: Werte zu t hängen nicht von späteren Kerzen ab', () => {
  const st = makeCalc('DE40', { session }); const part = B.slice(0, 350).map((b) => st(b));
  const changed = B.map((b, i) => (i >= 350 ? { ...b, c: b.c + 50, h: b.h + 50, l: b.l + 50, o: b.o + 50 } : b));
  const st2 = makeCalc('DE40', { session }); const full = changed.map((b) => st2(b));
  for (let k = 0; k < COLS.length; k++) { const a = part[349][k], b = full[349][k]; assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, COLS[k]); }
});

test('Session-VWAP und Eröffnungsspanne 30 min', () => {
  const st = makeCalc('DE40', { session }); const day = B.slice(0, 120); const r = day.map((b) => st(b)); // 08:00 bis 17:55 UTC
  const i0 = 0, k = 10; let pv = 0, v = 0; for (let i = i0; i <= k; i++) { const tp = (day[i].h + day[i].l + day[i].c) / 3; pv += tp * day[i].v; v += day[i].v; }
  assert.ok(close(r[k][col('vwap_sess')], pv / v));
  assert.ok(Number.isNaN(r[4][col('or30_hi')])); // 08:20 – Spanne noch nicht fertig
  assert.equal(r[5][col('or30_hi')], Math.max(...day.slice(0, 6).map((b) => b.h))); // 08:25-Kerze schließt 08:30
  assert.equal(r[103][col('in_session')], 0); // 16:35 UTC nach Schluss
});

test('M15 aus M5: exakte Aggregation, nur abgeschlossene Perioden', async () => {
  const { aggregate } = await import('../tools/indicators.js');
  const m5 = series(7).map((b, i) => ({ ...b, t: Date.UTC(2020, 0, 6, 8, 0) + i * 300000 }));
  const m15 = [...aggregate(m5, 15)];
  assert.equal(m15.length, 3); // 08:00, 08:15, 08:30 (letzte unvollständig, am Datenende ausgegeben)
  const g = m5.slice(0, 3);
  assert.deepEqual([m15[0].o, m15[0].h, m15[0].l, m15[0].c], [g[0].o, Math.max(...g.map((b) => b.h)), Math.min(...g.map((b) => b.l)), g[2].c]);
  assert.ok(close(m15[0].v, g.reduce((s, b) => s + b.v, 0)));
});

test('M15: Eröffnungsspanne erst nach Ablauf der 30 min, H4: Spalten leer', () => {
  const m15 = [...Array(12)].map((_, i) => ({ t: Date.UTC(2020, 0, 6, 8, 0) + i * 900000, o: 100, h: 101 + i, l: 99 - i, c: 100, spread: 0.1, v: 1 }));
  const st = makeCalc('DE40', { session, barMin: 15 }); const r = m15.map((b) => st(b));
  assert.ok(Number.isNaN(r[0][col('or30_hi')])); assert.equal(r[1][col('or30_hi')], 102); // 08:15-Kerze schließt 08:30
  const st4 = makeCalc('DE40', { session, barMin: 240, blank: [col('or30_hi'), col('h1_ema50')] });
  assert.ok(Number.isNaN(st4(m15[0])[col('h1_ema50')]));
});
