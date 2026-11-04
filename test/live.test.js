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
