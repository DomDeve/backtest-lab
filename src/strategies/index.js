// Strategie-Registry. Neue Module hier eintragen – oder per Pfad laden (--strategy ./mein-modul.js).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import orb60 from './de40-orb60.js';
import noiseb from './de40-noiseb.js';

export const STRATEGIES = {
  [orb60.id]: orb60,
  [noiseb.id]: noiseb,
};

export async function getStrategy(idOrPath) {
  if (STRATEGIES[idOrPath]) return STRATEGIES[idOrPath];
  if (/\.m?js$/.test(idOrPath)) {
    const mod = await import(pathToFileURL(path.resolve(idOrPath)).href);
    return mod.default;
  }
  throw new Error(`Unbekannte Strategie "${idOrPath}". Verfügbar: ${Object.keys(STRATEGIES).join(', ')}`);
}
