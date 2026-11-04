import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcFor } from '../src/core/time.js';
import { cleanBars } from '../src/data/clean.js';
import { TimeframeSeries } from '../src/live/candles.js';
import { compileNode, makeClock, makeDate, makeIntl } from '../src/live/sandbox.js';
import { runLive } from '../src/live/runner.js';
import { buildCatalog } from '../src/live/variants.js';

function mk(date, n, start = '07:00', f = (i) => 100 + i) {
  const t0 = utcFor(date, start, 'UTC');
  return Array.from({ length: n }, (_, i) => {
    const p = f(i);
    return { t: t0 + i * 300000, bo: p, bh: p + 2, bl: p - 2, bc: p + 1, ao: p + 1, ah: p + 3, al: p - 1, ac: p + 2, vol: 10 };
  });
}

test('Kerzen: laufende M15-Kerze = abgeschlossene M5 der Periode + erster Kurs', () => {
  const bars = mk('2026-03-03', 12); // 07:00 .. 07:55 UTC
  const s = new TimeframeSeries(bars, 'M15');
  const v = s.view(4, 3, true); // T = 07:20 -> Periode 07:15, enthält M5 07:15 + Tick 07:20
  assert.equal(v.length, 2); // Daten beginnen 07:00 -> 1 abgeschlossene + laufende
  const run = v[1];
  assert.equal(new Date(run.t).toISOString().slice(11, 16), '07:15');
  assert.equal(run.bo, bars[3].bo); // Open der Periode
  assert.equal(run.bc, bars[4].bo); // aktueller Kurs = Open von 07:20
  assert.equal(run.bh, Math.max(bars[3].bh, bars[4].bo));
  assert.equal(new Date(v[0].t).toISOString().slice(11, 16), '07:00'); // letzte abgeschlossene M15
  assert.equal(v[0].bc, bars[2].bc);
  const closed = s.view(4, 2, false);
  assert.equal(closed.length, 1); // nur 07:00 ist abgeschlossen
});

test('Sandbox: Code sieht simulierte Zeit, Intl liefert Berliner Zeit', () => {
  const clock = makeClock();
  clock.now = Date.parse('2026-07-01T08:05:10Z');
  const run = compileNode(`const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
    return [{ json: { now: Date.now(), h: p.find(x => x.type === 'hour').value, wd: p.find(x => x.type === 'weekday').value, n: $input.all().length, s: ($getWorkflowStaticData('node').k = ($getWorkflowStaticData('node').k || 0) + 1) } }];`);
  const state = {};
  const ctx = { items: [{ json: {} }, { json: {} }], state, DateCls: makeDate(clock), IntlObj: makeIntl() };
  const out = run(ctx)[0].json;
  assert.equal(out.now, clock.now);
  assert.equal(out.h, '10'); // Sommerzeit
  assert.equal(out.wd, 'Wed');
  assert.equal(out.n, 2);
  assert.equal(run(ctx)[0].json.s, 2); // staticData bleibt erhalten
});

test('Runner: Market-Order zum Ask-Open, SL serverseitig, Cron-Zeitpunkt', () => {
  const bars = cleanBars(mk('2026-03-03', 60, '06:00', (i) => (i < 30 ? 100 : 90)), { minBarsPerDay: 5 });
  const code = `const t = new Date().toISOString().slice(11, 16);
    if (t === '07:00') return [{ json: { signal: 'BUY', orderType: 'MARKET', stopLevel: 95, profitLevel: 120, currentPrice: 100 } }];
    return [{ json: { signal: 'NONE' } }];`;
  const v = { id: 't', name: 't', family: 'EURUSD', symbol: 'X', code, featureKeys: [], engine: { startBalance: 1000, riskPercent: 1 } };
  const res = runLive({ bars: bars.bars, days: bars.days, variant: v });
  assert.equal(res.trades.length, 1);
  const t = res.trades[0];
  assert.equal(new Date(t.entryT).toISOString().slice(11, 16), '07:00');
  assert.equal(t.entry, 101); // Ask-Open der 07:00-Kerze
  assert.equal(t.reason, 'SL_GAP'); // Kurs springt um 08:30 auf 90 -> Gap unter SL 95
});

test('Katalog: alle Varianten kompilieren, Patches greifen', () => {
  const cat = buildCatalog();
  assert.ok(cat.length >= 40);
  for (const v of cat) assert.doesNotThrow(() => compileNode(v.code), v.id);
  const lb4 = cat.find((v) => v.id === 'ftmo-v6-lb4');
  assert.match(lb4.code, /findSwingHighs\(highs, 4\)/);
  const fresh = cat.find((v) => v.id === 'ftmo-v3-fresh');
  assert.match(fresh.code, /__freshOk\('SELL', sl1\)/);
  const base = cat.find((v) => v.id === 'ftmo-basis');
  assert.doesNotMatch(base.code, /__V/); // Basis = unveränderter Originaltext
});

// ---- EURUSD Sweep -> BOS -> FVG -> Fib-Pullback (Test-Variante eu-sbf)
function sbfItems(sweepClose) {
  const P = (pips) => 1.1 + pips * 0.0001;
  const cap = (t, o, h, l, c) => ({ snapshotTimeUTC: new Date(t).toISOString().slice(0, 19),
    openPrice: { bid: o - 0.00005, ask: o + 0.00005 }, highPrice: { bid: h - 0.00005, ask: h + 0.00005 },
    lowPrice: { bid: l - 0.00005, ask: l + 0.00005 }, closePrice: { bid: c - 0.00005, ask: c + 0.00005 } });
  // [low, high, close] in Pips über 1.1000; Index 44 Swing-Tief, 48 Swing-Hoch, 52 Sweep, 55 BOS, 56 FVG, 57 Impuls-Hoch
  const hlc = [];
  for (let i = 0; i < 44; i++) { const l = 3 + (43 - i) * 0.3; hlc.push([l, l + 3, l + 1.5]); }
  hlc.push([0, 3, 2], [1, 5, 4], [3, 7, 6], [5, 9, 8], [7, 10, 8], [6, 9, 6.5], [4, 7, 4.5], [2, 5, 2.5],
    [-3, 3, sweepClose], [1, 6, 5.5], [5, 9, 8.5], [8.5, 14, 13], [12, 18, 17], [16, 20, 18], [12, 18, 13], [8, 13, 9], [5, 9.5, 6], [4, 4.5, 4]);
  const t0 = Date.parse('2026-03-03T08:00:00Z');
  let prev = hlc[0][2];
  const m5 = hlc.map(([l, h, c], i) => { const o = prev; prev = c; return cap(t0 + i * 300000, P(o), P(Math.max(h, o)), P(Math.min(l, o)), P(c)); });
  const trend = (n, step, ms) => Array.from({ length: n }, (_, i) => { const b = 1.08 + i * step; return cap(t0 - (n - i) * ms, b, b + 0.0004, b - 0.0002, b + 0.0003); });
  return { items: [{ json: { accounts: [{ balance: { balance: 18000 } }] } }, { json: { prices: trend(70, 0.0003, 900000) } }, { json: { prices: m5 } }, { json: { prices: trend(60, 0.0005, 3600000) } }],
    now: t0 + (hlc.length - 1) * 300000 + 10000 };
}

test('EURUSD Sweep→BOS→FVG: Einstieg im Fib-Pullback 0,618–0,75, ohne Sweep kein Signal', () => {
  const v = buildCatalog().find((x) => x.id === 'eu-sbf');
  const run = compileNode(v.code);
  const go = (sweepClose) => {
    const { items, now } = sbfItems(sweepClose);
    const clock = makeClock(); clock.now = now;
    return run({ items, state: {}, DateCls: makeDate(clock), IntlObj: makeIntl() })[0].json;
  };
  const ok = go(1); // Sweep-Kerze schließt wieder über dem Swing-Tief
  assert.equal(ok.signal, 'BUY', ok.reason);
  assert.ok(ok.sbfFib >= 0.618 && ok.sbfFib <= 0.75, `Fib ${ok.sbfFib}`);
  assert.equal(ok.sbfBosMin, 15); // Sweep 52 -> BOS 55
  assert.ok(ok.stopLevel < 1.1 - 0.0003, 'SL hinter dem Sweep-Tief');
  assert.ok(Math.abs(ok.tpDistance / ok.slDistance - 1.5) < 0.02, 'TP = 1,5 × SL (Rundung 5 Stellen)');
  const no = go(-1); // schließt unter dem Tief -> Ausbruch, kein Sweep
  assert.equal(no.signal, 'NONE');
  assert.match(no.reason, /keine Sweep/);
});

test('EURUSD Muster-Filter: Mi/Fr und ADX 30–35 als Code-Patch, Basis unverändert', () => {
  const cat = buildCatalog();
  const v = cat.find((x) => x.id === 'eu-c4-mifr-adx');
  assert.equal(v.base, 'eu-c4');
  assert.match(v.code, /utcDay === 3 \|\| utcDay === 5\) return none\("Mi\/Fr-Filter"\)/);
  assert.match(v.code, /adx >= 30 && adx < 35/);
  assert.doesNotMatch(cat.find((x) => x.id === 'eu-c4').code, /Mi\/Fr-Filter/);
  const only = cat.find((x) => x.id === 'eu-c3-mifr');
  assert.match(only.code, /Mi\/Fr-Filter/);
  assert.doesNotMatch(only.code, /ADX-Filter 30–35/);
  // Filter greift vor jeder Signal-Logik: Mittwoch -> NONE mit Grund
  const { items, now } = sbfItems(1);
  const clock = makeClock(); clock.now = now + 86400000; // 04.03.2026 = Mittwoch
  const out = compileNode(cat.find((x) => x.id === 'eu-sbf-mifr-adx').code)({ items, state: {}, DateCls: makeDate(clock), IntlObj: makeIntl() })[0].json;
  assert.equal(out.signal, 'NONE');
  assert.equal(out.reason, 'Mi/Fr-Filter');
});

test('Muster-Filter DE40/NAS als Code-Patch: Fundstellen greifen, Basis unverändert', () => {
  const cat = buildCatalog();
  const de = cat.find((x) => x.id === 'de40-combo-mf');
  assert.match(de.code, /ADX_MIN: 30,/);
  assert.match(de.code, /FILTER_MONTAG/);
  assert.match(de.code, /!\(z\.depth >= 0\.2 && z\.depth <= 0\.35\)/);
  assert.doesNotMatch(cat.find((x) => x.id === 'de40-combo').code, /FILTER_MONTAG/);
  const a30 = cat.find((x) => x.id === 'de40-basis-adx30');
  assert.match(a30.code, /ADX_MIN: 30,/);
  assert.doesNotMatch(a30.code, /FILTER_MONTAG/);
  const n = cat.find((x) => x.id === 'nas-f618-l2r1ext-h15');
  assert.match(n.code, /US-Eröffnung/);
  assert.match(n.code, /"type":"fractal","L":2,"R":1/);
  assert.doesNotMatch(cat.find((x) => x.id === 'nas-f618atr').code, /US-Eröffnung|__SW/);
  // Sandbox: um 15:10 Berlin (Sommerzeit, 13:10 UTC) greift die Sperre vor jeder Signal-Logik
  const clock = makeClock(); clock.now = Date.parse('2026-06-16T13:10:10Z');
  const run = compileNode(cat.find((x) => x.id === 'nas-f618-h15').code);
  const m15 = Array.from({ length: 220 }, (_, i) => ({ snapshotTimeUTC: '2026-06-14T00:00:00', openPrice: { bid: 100, ask: 101 }, highPrice: { bid: 102, ask: 103 }, lowPrice: { bid: 99, ask: 100 }, closePrice: { bid: 100, ask: 101 } }));
  const out = run({ items: [{ json: { prices: m15 } }, { json: { prices: m15.slice(0, 60) } }, { json: {} }], state: {}, DateCls: makeDate(clock), IntlObj: makeIntl() })[0].json;
  assert.match(out.error, /keine Signale 15:00/);
});
