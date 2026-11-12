// News-Kalender (ForexFactory 2007–2026, data/news/ff_calendar.csv aus tools/news_calendar.py) für die Live-Code-Engine.
// Nachbau des d_ftmo-Knotens „News-Filter“ (Stand 10.11.2026): Sperre ±15 Min um High-Impact-News USD und EUR;
// in der Sperre laufen die Strategien nicht, offene Pending Orders werden gelöscht, Positionen bleiben.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'news', 'ff_calendar.csv');
const cache = new Map();

/** Sortierte Zeitpunkte (ms UTC) der Termine mit impact ∈ impacts und currency ∈ currencies. Wie live inkl. ganztägiger Termine. */
export function newsTimes({ currencies = ['USD', 'EUR'], impacts = ['high'], file = FILE } = {}) {
  const key = file + '|' + currencies.join(',') + '|' + impacts.join(',');
  if (cache.has(key)) return cache.get(key);
  if (!fs.existsSync(file)) throw new Error(`News-Kalender fehlt: ${file} (python3 -I tools/news_calendar.py build)`);
  const lines = fs.readFileSync(file, 'utf8').split('\n'); const head = lines[0].split(',');
  const iTs = head.indexOf('ts'), iC = head.indexOf('currency'), iI = head.indexOf('impact');
  const out = [];
  for (let k = 1; k < lines.length; k++) { if (!lines[k]) continue; const r = lines[k].split(','); // ts/currency/impact stehen vor dem (evtl. kommahaltigen) Ereignisnamen
    if (currencies.includes(r[iC]) && impacts.includes(r[iI])) out.push(Number(r[iTs]) * 1000); }
  out.sort((a, b) => a - b); cache.set(key, out); return out;
}

/** true, wenn |t − Termin| ≤ windowMin für einen Termin (binäre Suche). */
export function inNewsWindow(t, times, windowMin = 15) {
  const w = windowMin * 60000; let lo = 0, hi = times.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t - w) lo = m + 1; else hi = m; }
  return lo < times.length && times[lo] <= t + w;
}
