// DE40 Confluence 3 FTMO (d_ftmo): Familie DE40_FTMO = DAX Combined Check1 + Prepare Order Body DE1, Bridge-Kerzen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanBars } from '../src/data/clean.js';
import { toBridge } from '../src/live/candles.js';
import { runLive } from '../src/live/runner.js';
import { buildCatalog } from '../src/live/variants.js';
import { profileName } from '../src/core/costs.js';


test('Katalog ftmo-de40-c3: Originaltext aus strategies-live/ftmo, Familie DE40_FTMO, Kostenprofil ftmo', () => {
  const v = buildCatalog().find((x) => x.id === 'ftmo-de40-c3');
  assert.ok(v);
  assert.equal(v.family, 'DE40_FTMO');
  assert.equal(v.symbol, 'DE40');
  assert.equal(v.code, fs.readFileSync(new URL('../strategies-live/ftmo/DE40_Confluence_3_FTMO.js', import.meta.url), 'utf8'));
  assert.equal(profileName(v), 'ftmo');
  assert.equal(v.engine.riskPercent, 0.5);
  // Bridge-Format wie live (GET /candles): tick_volume statt volume – der Code liest c.tick_volume für das Volumenprofil
  const b = toBridge({ t: Date.parse('2026-03-04T09:00:00Z'), bo: 1, bh: 3, bl: 0, bc: 2, ao: 2, ah: 4, al: 1, ac: 3, vol: 77 });
  assert.deepEqual(b, { time: Date.parse('2026-03-04T09:00:00Z') / 1000, open: 1.5, high: 3.5, low: 0.5, close: 2.5, tick_volume: 77, spread: 0 });
});

// Synthetischer Verlauf Mo 02.03. – Mi 04.03.2026 (CET): Vortag mit drei Volumen-Clustern 1000 / 1052 / 1103 und dünnen Übergängen,
// Mittwoch Aufwärtstrend ab 08:00 Berlin, ab 11:30 Berlin Einbruch durch das Limit und den SL.
function synthDay() {
  const bars = [];
  const add = (t, o, c, rng, vol) => {
    const hi = Math.max(o, c) + rng, lo = Math.min(o, c) - rng;
    bars.push({ t, bo: o - 0.5, bh: hi - 0.5, bl: lo - 0.5, bc: c - 0.5, ao: o + 0.5, ah: hi + 0.5, al: lo + 0.5, ac: c + 0.5, vol });
  };
  const at = (s) => Date.parse(s + 'Z');
  let k = 0;
  for (let t = at('2026-03-02T00:00:00'); t < at('2026-03-04T16:00:00'); t += 300000, k++) {
    const d = new Date(t).toISOString(), day = d.slice(0, 10), hm = d.slice(11, 16), w = k % 2 ? 2 : -2;
    const lin = (from, base, step) => base + ((t - at(from)) / 300000) * step;
    if (day === '2026-03-02') add(t, 1000 + w, 1000 - w, 2, 100);
    else if (day === '2026-03-03') {
      if (hm < '10:00') add(t, 1000 + w, 1000 - w, 2, 500);
      else if (hm < '10:30') { const p = lin('2026-03-03T10:00:00', 1000, 8); add(t, p, p + 8, 2, 5); }
      else if (hm < '13:00') add(t, 1052 + w, 1052 - w, 2, 500);
      else if (hm < '13:30') { const p = lin('2026-03-03T13:00:00', 1052, 8.5); add(t, p, p + 8.5, 2, 5); }
      else add(t, 1103 + w, 1103 - w, 2, 500);
    } else if (hm < '07:00') { const p = lin('2026-03-04T00:00:00', 1103, -0.4); add(t, p, p - 0.4, 2, 100); }
    else if (hm < '10:30') { const p = lin('2026-03-04T07:00:00', 1069, 1.2); add(t, p, p + 1.6, 1, 100); }
    else { const p = lin('2026-03-04T10:30:00', 1120, -3); add(t, p, p - 3, 1, 100); }
  }
  return cleanBars(bars, { minBarsPerDay: 5, asDelivered: true });
}

test('DE40_FTMO mit Originalcode: synthetischer Tag erzeugt LVN-Limit um 10:00 Berlin, Gültigkeit bis ≈ 19:00, Füllung + SL', () => {
  const { bars, days } = synthDay();
  const v = buildCatalog().find((x) => x.id === 'ftmo-de40-c3');
  const outs = [];
  const res = runLive({ bars, days, variant: v, engine: { newsFilter: false }, params: { trace: ({ T, out }) => { if (out.signal !== 'NONE') outs.push({ T, out }); } } });
  assert.deepEqual(res.events.errors, {});
  assert.equal(outs.length, 2); // 10:00 Signal, später zweites Setup (blockiert: Order aktiv)
  const s = outs[0];
  assert.equal(new Date(s.T).toISOString().slice(11, 16), '09:00'); // 10:00 Berlin = erster Lauf in PRIME_ENTRY
  assert.equal(s.out.signal, 'BUY');
  assert.equal(s.out.orderType, 'LIMIT');
  assert.equal(s.out.limitLevel, 1068.5);
  assert.equal(s.out.stopLevel, 1053.5); // SL_MIN 15
  assert.equal(s.out.profitLevel, 1103.5); // HVN des Vortags
  assert.ok(s.out.confluenceScore >= 3);
  assert.equal(s.out.expirationHours, 9); // 10:00 -> 19:00 Berlin, ganze Stunden
  assert.equal(res.events.placed, 1);
  assert.equal(res.events.blocked['Aktive Order'], 1);
  assert.equal(res.trades.length, 1);
  const t = res.trades[0];
  assert.equal(t.dir, 'BUY');
  assert.equal(t.entry, 1068.5);
  assert.equal(t.reason, 'SL');
  assert.equal(t.Rgross, -1);
});

// Stub-Code: prüft die Eingänge wie Merge DAX sie liefert und gibt feste Signale zurück -> Order-Prüfung isoliert testen.
test('DE40_FTMO Order-Prüfung: Eingänge, aktive Order blockiert, Invalidierung (SL ± 8) löscht, SL/TP-Lage, Tagesstopp', () => {
  const t0 = Date.parse('2026-03-03T00:00:00Z');
  const raw = Array.from({ length: 12 * 20 }, (_, i) => ({ t: t0 + i * 300000, bo: 100, bh: 101, bl: 99, bc: 100, ao: 101, ah: 102, al: 100, ac: 101, vol: 10 }));
  const { bars, days } = cleanBars(raw, { minBarsPerDay: 5, asDelivered: true });
  const code = `const it = $input.all();
    const m5 = it[0].json.body, fx = it[1].json.body, h1 = it[2].json.body, m15 = it[3].json.body;
    const now = Date.now();
    if (it.length !== 4) throw new Error('Eingänge ' + it.length);
    if (!(m5.at(-1).time * 1000 < now - 5000 && m5.at(-1).time * 1000 >= now - 310000)) throw new Error('M5 nicht abgeschlossen');
    if (!(m5.length <= 300 && h1.length <= 250 && m15.length <= 400)) throw new Error('Anzahl');
    if (!('tick_volume' in m5[0]) || !(fx.at(-1).close > 0.5 && fx.at(-1).close < 2)) throw new Error('Format');
    const t = new Date(now).toISOString().slice(11, 16);
    const S = { '09:00': ['BUY', 90, 80, 120, 100], '09:40': ['BUY', 95, 85, 120, 100], '10:20': ['BUY', 96, 86, 120, 85], '11:00': ['SELL', 110, 120, 105, 100] }[t];
    if (!S) return [{ json: { signal: 'NONE', limitLevel: 0 } }];
    return [{ json: { signal: S[0], orderType: 'LIMIT', limitLevel: S[1], stopLevel: S[2], profitLevel: S[3], currentPrice: S[4], size: 1, expirationHours: 9 } }];`;
  const v = { id: 't', name: 't', family: 'DE40_FTMO', symbol: 'DE40', code, featureKeys: [], opts: { ftmo: true }, engine: { startBalance: 100000, riskPercent: 0.5, newsFilter: false } };
  const res = runLive({ bars, days, variant: v });
  assert.deepEqual(res.events.errors, {});
  // 09:00 platziert (90/80), 09:40 blockiert (Kurs 100 > 80 + 8 -> Order gültig), 10:20 Kurs 85 < 88 -> löschen + neue Order,
  // 11:00 SELL: neue Order 96/86 aktiv? 100 > 94 -> gültig -> blockiert
  assert.equal(res.events.placed, 2);
  assert.equal(res.events.cancelled, 1);
  assert.equal(res.events.blocked['Aktive Order'], 2);

  // Prepare Order Body DE1 wirft bei falscher SL/TP-Lage -> keine Order
  const bad = { ...v, code: code.replace("'09:00': ['BUY', 90, 80, 120, 100]", "'09:00': ['BUY', 90, 95, 120, 100]") };
  const r2 = runLive({ bars, days, variant: bad });
  assert.equal(r2.events.blocked['Order-Body SL/TP falsch'], 1);

  // Schutz-Check STOP (Tagesverlust) -> Strategie läuft an diesem Tag nicht mehr
  const halt = { ...v, opts: { ftmo: true, dailyStopPct: -1 } }; // Sperre sofort
  const r3 = runLive({ bars, days, variant: halt });
  assert.equal(r3.events.placed, 0);
  assert.ok(r3.events.blocked['FTMO Tagesverlust-Sperre'] > 0);
});
