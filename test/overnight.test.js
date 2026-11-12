// Overnight-Kandidat: Einstieg zum Session-Schluss, Ausstieg zur nächsten Eröffnung, Finanzierung je Kalendernacht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcFor } from '../src/core/time.js';
import { cleanBars } from '../src/data/clean.js';
import { runBacktest } from '../src/core/engine.js';
import { windows } from '../tools/engine-check.js';
import { overnightStrategy, evaluate } from '../bin/overnight.js';

// DE40-Tage (Mi–Mo, Wochenende dazwischen), 08:00–18:00 Berlin, Kurs tagsüber flach, nachts +10 Punkte, Spread 1
function bars() {
  const raw = [];
  let p = 1000;
  for (const date of ['2025-03-05', '2025-03-06', '2025-03-07', '2025-03-10']) {
    const t0 = utcFor(date, '08:00');
    for (let i = 0; i < 120; i++) raw.push({ t: t0 + i * 300000, bo: p - 0.5, bh: p - 0.5, bl: p - 0.5, bc: p - 0.5, ao: p + 0.5, ah: p + 0.5, al: p + 0.5, ac: p + 0.5 });
    p += 10;
  }
  return cleanBars(raw, { session: { from: '09:00', to: '17:25' }, minBarsPerDay: 5 });
}

test('Overnight: Schluss → Eröffnung, Wochenende = 3 Nächte, ohne Wochenende, Intraday-Kontrolle', () => {
  const c = bars(), W = windows('DE40', c.bars);
  const E = { startBalance: 1e6, riskPercent: 0.1, compounding: false, maxSize: 1e9, minSize: 0, sizeDecimals: 6 };
  const on = runBacktest({ bars: c.bars, days: c.days, strategy: overnightStrategy({ W }), engine: E }).trades;
  assert.equal(on.at(-1).reason, 'END'); // letzte Nacht am Datenende offen
  assert.deepEqual(on.slice(0, 3).map((t) => [t.date, t.entryHm, t.exitDate, t.exitHm]), [
    ['2025-03-05', '17:30', '2025-03-06', '09:00'], ['2025-03-06', '17:30', '2025-03-07', '09:00'], ['2025-03-07', '17:30', '2025-03-10', '09:00']]);
  assert.ok(on.slice(0, 3).every((t) => Math.abs(t.pts - 9) < 1e-9)); // +10 Mitte − 1 Spread
  const ev = evaluate(on, c.bars, 7.3);
  assert.equal(ev.n, 3);
  assert.ok(Math.abs(ev.fin - (7.3 * (1 + 1 + 3)) / 365 / 3) < 1e-9); // Freitag -> Montag 3 Nächte
  assert.ok(ev.breakEven > 0);
  const wt = runBacktest({ bars: c.bars, days: c.days, strategy: overnightStrategy({ W, noWeekend: true }), engine: E }).trades;
  assert.deepEqual(wt.map((t) => t.date), ['2025-03-05', '2025-03-06']); // kein Einstieg Freitag
  const id = runBacktest({ bars: c.bars, days: c.days, strategy: overnightStrategy({ W, mode: 'ID' }), engine: E }).trades;
  assert.ok(id.length === 4 && id.every((t) => Math.abs(t.pts + 1) < 1e-9)); // tagsüber flach -> nur Spread
});
