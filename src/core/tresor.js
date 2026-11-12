// Tresor: versiegelte Jahre je Epic (config/tresor.json). Standard = Kerzen dieser Jahre werden beim Laden entfernt,
// damit sie nie in Suche/Optimierung/Mustersuche einfließen. Öffnen nur mit Begründung -> config/tresor_protokoll.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = path.join(ROOT, 'config', 'tresor.json');
export const PROTOKOLL = path.join(ROOT, 'config', 'tresor_protokoll.jsonl');

export function tresorYears(epic, cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'))) {
  return new Set(cfg.jahre[epic] || []);
}

export const isSealed = (t, years) => years.has(new Date(t).getUTCFullYear());

/** Kerzen ohne Tresor-Jahre. bars: [{ t: ms UTC, ... }]. Rückgabe { bars, removed, years } */
export function sealBars(bars, epic, years = tresorYears(epic)) {
  const keep = bars.filter((b) => !isSealed(b.t, years));
  return { bars: keep, removed: bars.length - keep.length, years: [...years].sort() };
}

/** Öffnung protokollieren (append-only). Ohne Begründung -> Fehler. */
export function openTresor({ epic, reason, variants = [], cmd = process.argv.slice(2).join(' '), file = PROTOKOLL }) {
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new Error('Tresor öffnen nur mit Begründung (mind. 10 Zeichen): --tresor "<Begründung>"');
  const rec = { zeit: new Date().toISOString(), epic, begruendung: reason.trim(), varianten: variants, befehl: cmd };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}
