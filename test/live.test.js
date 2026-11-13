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

test('NAS Chop-Filter: MA-Regel und Qualitätsfilter als Code-Patch, Basis unverändert', () => {
  const cat = buildCatalog();
  const v = cat.find((x) => x.id === 'nas-f618-ma0-er04');
  assert.equal(v.base, 'nas-f618atr');
  assert.match(v.code, /const MA_DIST_MIN\s*=\s*0;/);
  assert.match(v.code, /const USE_MA_DISTANCE_FILTER\s*=\s*true;/);
  assert.match(v.code, /"er":0\.4/);
  assert.match(v.code, /__qOk\('BUY', relevantLow, sh1\)/);
  const lb3 = cat.find((x) => x.id === 'nas-f61lb3-ma0');
  assert.match(lb3.code, /const USE_MA_DISTANCE_FILTER\s*=\s*true;/);
  assert.doesNotMatch(cat.find((x) => x.id === 'nas-fib61-lb3').code, /USE_MA_DISTANCE_FILTER\s*=\s*true/);
  assert.match(cat.find((x) => x.id === 'nas-fib61-lb3').code, /MA_DIST_MIN\s*=\s*30;/);
});

// ---------------------------------------------------------------- Phase 0 (06.11.2026): Kerzen wie vom Broker geliefert
import { TimeframeSeries as TFS06 } from '../src/live/candles.js';
import { cleanBars as clean06 } from '../src/data/clean.js';

const mk06 = (iso, mid, spread = 2) => ({ t: Date.parse(iso), bo: mid, bh: mid + 1, bl: mid - 1, bc: mid, ao: mid + spread, ah: mid + 1 + spread, al: mid - 1 + spread, ac: mid + spread, vol: 10 });

test('cleanBars asDelivered: Sonntagabend-Kerzen bleiben in der Historie, sind aber kein Handelstag', () => {
  // So 25.10.2026 22:05 Berlin (21:05 UTC) = Wochenöffnung, Mo 26.10. 30 Kerzen
  const raw = [mk06('2026-10-25T21:05:00Z', 100), mk06('2026-10-25T21:10:00Z', 101)];
  for (let k = 0; k < 30; k++) raw.push(mk06(new Date(Date.parse('2026-10-26T08:00:00Z') + k * 300000).toISOString(), 102 + k));
  raw.push({ ...mk06('2026-10-26T10:30:00Z', 200), ao: 199.5, ac: 199.5 }); // gekreuzt (Ask < Bid)
  const std = clean06(raw, { session: { from: '09:00', to: '11:00' } });
  const del = clean06(raw, { session: { from: '09:00', to: '11:00' }, asDelivered: true });
  assert.equal(std.bars.some((b) => b.date === '2026-10-25'), false);
  assert.equal(del.bars.filter((b) => b.date === '2026-10-25').length, 2);
  assert.deepEqual(del.days.map((d) => d.date), ['2026-10-26']);
  const crossed = del.bars.find((b) => b.t === Date.parse('2026-10-26T10:30:00Z'));
  assert.equal(crossed.ao, 199.5); // unverändert, wie geliefert
});

test('TimeframeSeries.view noTick: keine laufende M5-Kerze, M15 nur aus abgeschlossenen M5', () => {
  const bars = [];
  for (let k = 0; k < 12; k++) bars.push(mk06(new Date(Date.parse('2026-10-27T08:00:00Z') + k * 300000).toISOString(), 100 + k));
  const i = 7; // Lauf um 08:35 UTC (bars[7] = neue Kerze)
  const m5 = new TFS06(bars, 'M5');
  const withTick = m5.view(i, 4, true), noTick = m5.view(i, 4, true, true);
  assert.equal(withTick.at(-1).running, true);
  assert.equal(noTick.length, 4);
  assert.equal(noTick.at(-1).t, bars[6].t); // letzte = zuletzt abgeschlossene
  const m15 = new TFS06(bars, 'M15');
  const r = m15.view(i, 3, true, true).at(-1); // laufende M15 (08:30) = nur die abgeschlossene 08:30-M5
  assert.equal(r.t, Date.parse('2026-10-27T08:30:00Z'));
  assert.equal(r.bc, bars[6].bc);
  const atBoundary = new TFS06(bars, 'M15').view(9, 3, true, true); // 08:45 = Periodenbeginn -> keine laufende M15
  assert.equal(atBoundary.at(-1).t, Date.parse('2026-10-27T08:30:00Z'));
  assert.equal(atBoundary.at(-1).running, undefined);
});

// ---------------------------------------------------------------- Session-Tabelle (config/sessions.yaml), 07.11.2026
import { loadSessions, sessionUtc, sessionHmIn, isTradingDay, parseYaml, cleanSession } from '../src/core/sessions.js';

test('Sessions: NY-Eröffnung in Berlin 14:30 in den DST-Sonderwochen (März / Ende Okt.–Anfang Nov.), sonst 15:30', () => {
  for (const d of ['2025-03-10', '2025-03-28', '2026-03-09', '2026-03-27', '2025-10-27', '2025-10-31', '2026-10-26', '2026-10-30']) assert.equal(sessionHmIn('US100', d), '14:30', d);
  for (const d of ['2025-03-06', '2025-03-31', '2026-03-31', '2026-10-23', '2025-11-03', '2026-11-02', '2026-07-15', '2026-01-15']) assert.equal(sessionHmIn('US100', d), '15:30', d);
  assert.equal(new Date(sessionUtc('US100', '2026-03-10').open).toISOString(), '2026-03-10T13:30:00.000Z');
  assert.equal(new Date(sessionUtc('DE40', '2026-03-10').open).toISOString(), '2026-03-10T08:00:00.000Z');
  assert.equal(sessionHmIn('EURUSD', '2026-03-10', 'Europe/Berlin', 'open', 'newyork'), '13:30'); // 08:30 NY
  assert.equal(sessionHmIn('EURUSD', '2026-03-10', 'Europe/Berlin', 'open', 'london'), '08:00'); // 07:00 London
});

test('Sessions: Wochenende und Börsenfeiertag erzeugen keine Session', () => {
  assert.equal(sessionUtc('US100', '2026-11-07'), null); // Samstag
  assert.equal(sessionUtc('DE40', '2026-11-08'), null); // Sonntag
  assert.equal(sessionUtc('US100', '2026-11-26'), null); // Thanksgiving
  assert.equal(sessionUtc('DE40', '2026-12-24'), null); // Heiligabend Xetra
  assert.equal(isTradingDay('DE40', '2026-11-26'), true); // US-Feiertag betrifft Xetra nicht
  assert.notEqual(sessionUtc('BTCUSD', '2026-11-07'), null); // 24/7 ohne Kalender
});

test('Sessions: YAML-Leser und Kernzeit für cleanBars', () => {
  const y = parseYaml('a:\n  b: "09:30" # Kommentar\n  c: [2026-01-01, 2026-12-25]\n  d: true\nx: "a # b"\n');
  assert.deepEqual(y, { a: { b: '09:30', c: ['2026-01-01', '2026-12-25'], d: true }, x: 'a # b' });
  assert.deepEqual(cleanSession('US100'), { from: '09:30', to: '15:55', tz: 'America/New_York' });
  const S = loadSessions();
  for (const [k, e] of Object.entries(S.epics)) {
    assert.ok(e.calendar in S.calendars, k);
    for (const s of Object.values(e.sessions)) assert.ok(/^\d\d:\d\d$/.test(s.open_local) && s.tz, k);
    if (!e.orb_vwap) assert.ok(e.exclude_reason, k);
  }
});

// ---- Strategie-Review FTMO (12.11.2026)
test('Runner NAS_FTMO: Tageslimit zählt nur gefüllte Orders (d_ftmo seit 10.11.2026), ftmoCountAll = alter Stand', () => {
  const bars = cleanBars(mk('2026-03-03', 60, '06:00', () => 100), { minBarsPerDay: 5 });
  // 07:00 Order weit weg (füllt nie, verfällt nach 1 h), danach drei füllbare Orders im Abstand > 30 Min
  const code = `const t = new Date().toISOString().slice(11, 16);
    const S = { '07:00': [50, 40, 120, 1], '08:20': [99.5, 90, 101.5, 24], '09:00': [99.5, 89, 101.5, 24], '09:40': [99.5, 88, 101.5, 24] }[t];
    if (!S) return [{ json: { signal: 'NONE' } }];
    return [{ json: { signal: 'BUY', limitLevel: S[0], stopLevel: S[1], profitLevel: S[2], currentPrice: 100, expirationHours: S[3], size: 1 } }];`;
  const v = (eng) => ({ id: 't', name: 't', family: 'NAS_FTMO', symbol: 'US100', code, featureKeys: [], opts: { ftmo: true },
    engine: { startBalance: 100000, riskPercent: 0.5, newsFilter: false, ...eng } });
  const neu = runLive({ bars: bars.bars, days: bars.days, variant: v({}) });
  const alt = runLive({ bars: bars.bars, days: bars.days, variant: v({ ftmoCountAll: true }) });
  assert.equal(neu.trades.length, 2); // verfallene Order zählt nicht, 09:40 blockiert (2 gefüllt)
  assert.equal(alt.trades.length, 1); // alt: 07:00 + 08:20 platziert -> Tageslimit
});

test('Review-Patches FTMO: Punkt-Schwellen × Kurs/ref und Stundenfilter greifen, Basis unverändert', async () => {
  const cat = buildCatalog();
  const base = cat.find((v) => v.id === 'ftmo-basis');
  const px = cat.find((v) => v.id === 'ftmo-rv-px20k');
  assert.match(px.code, /const __px = currentClose \/ 20000;/);
  assert.equal((px.code.match(/\* __px/g) || []).length, 8);
  const h = cat.find((v) => v.id === 'ftmo-rv-h1516');
  assert.match(h.code, /\[15,16\]\.includes\(__bh\)/);
  assert.doesNotMatch(base.code, /__px|__bh/);
  // Stundenfilter in der Sandbox: 15:10 Berlin (14:10 UTC im Winter) -> NONE mit Filtergrund
  const run = compileNode(cat.find((v) => v.id === 'ftmo-rv-h15').code);
  const clock = makeClock(); clock.now = Date.parse('2026-03-03T14:10:10Z');
  const m15 = Array.from({ length: 250 }, (_, i) => ({ time: i, open: 100, high: 101, low: 99, close: 100 }));
  const out = run({ items: [{ json: { body: m15 } }, { json: { body: m15.slice(0, 50) } }, { json: { lot_size: 100 } }], state: {}, DateCls: makeDate(clock), IntlObj: makeIntl(clock), logs: [] });
  assert.match(out[0].json.error, /Berlin-Stunde 15/);
});

test('Review-Patches FTMO 13.11.2026: ATR-Pause und TP-Extension setzen genau eine Konstante', () => {
  const cat = buildCatalog();
  const base = cat.find((v) => v.id === 'ftmo-basis').code;
  const cases = [['ftmo-rv-atroff', 'USE_ATR_FILTER', 'false'], ['ftmo-rv-atr12', 'ATR_MIN_PCT', '1.2'], ['ftmo-rv-atr14', 'ATR_MIN_PCT', '1.4'],
    ['ftmo-rv-atr18', 'ATR_MIN_PCT', '1.8'], ['ftmo-rv-ext05', 'FIB_EXTENSION', '0.5'], ['ftmo-rv-ext0786', 'FIB_EXTENSION', '0.786'], ['ftmo-rv-ext1', 'FIB_EXTENSION', '1']];
  for (const [id, k, val] of cases) {
    const c = cat.find((v) => v.id === id).code;
    assert.match(c, new RegExp(`const ${k}\\s*=\\s*${val.replace('.', '\\.')};`), id);
    const diff = c.split('\n').filter((l, i) => l !== base.split('\n')[i]);
    assert.equal(diff.length, 1, id);
  }
});
