#!/usr/bin/env node
// Diagnose für Phase 0: zeigt je Cron-Lauf, was der Original-Code-Node zurückgibt (Signal oder Abbruchgrund).
//   node tools/trace-live.js <variante> <von YYYY-MM-DDTHH:MM> <bis YYYY-MM-DDTHH:MM> [--all] [--de40-live]  (--de40-live: Ask-Versatz wie live)
// Zeiten in UTC. Ohne --all nur Läufe, deren Ausgabe sich gegenüber dem vorigen Lauf ändert.
import fs from 'node:fs';
import path from 'node:path';
import { loadBars } from '../src/data/load.js';
import { cleanSession } from '../src/core/sessions.js';
import { cleanBars } from '../src/data/clean.js';
import { runLive } from '../src/live/runner.js';
import { buildCatalog } from '../src/live/variants.js';

const [vid, from, to] = process.argv.slice(2);
const all = process.argv.includes('--all');
const SESS = Object.fromEntries(['DE40', 'US100', 'EURUSD'].map((e) => [e, cleanSession(e)])); // Kernzeit aus config/sessions.yaml
const DIRS = { DE40: 'data/raw/de40', US100: 'data/raw/us100', EURUSD: 'data/raw/eurusd' };
const v = buildCatalog().find((x) => x.id === vid);
if (!v) { console.error('Variante unbekannt:', vid); process.exit(1); }
const files = fs.readdirSync(DIRS[v.symbol]).filter((f) => /MINUTE_5_.*\.csv$/.test(f)).map((f) => path.join(DIRS[v.symbol], f));
const c = cleanBars(loadBars(files).bars, { session: SESS[v.symbol] , asDelivered: true });
const t0 = Date.parse(from + ':00Z'), t1 = Date.parse(to + ':00Z');
let prev = '';
const keys = (o) => Object.fromEntries(Object.entries(o).filter(([k, x]) => x !== null && typeof x !== 'object' && !/Time|time|botName|botId|epic/.test(k)).slice(0, 14));
const res = runLive({
  bars: c.bars, days: c.days, variant: v, engine: process.argv.includes('--de40-live') ? { de40AskShift: true } : {},
  range: { from: from.slice(0, 10), to: to.slice(0, 10) },
  params: {
    trace: ({ T, out }) => {
      if (T < t0 || T > t1) return;
      const ex = Object.fromEntries(['adx', 'threshold', 'rangeSize', 'spread', 'distance', 'dist', 'score', 'confluence', 'quality'].filter((k) => out[k] !== undefined).map((k) => [k, out[k]]));
      const s = out.signal === 'NONE' ? `NONE ${out.reason || out.error || ''} ${JSON.stringify(ex)}` : `${out.signal} ${JSON.stringify(keys(out))}`;
      if (all || s !== prev) console.log(new Date(T).toISOString().slice(5, 16), s.slice(0, 400));
      prev = s;
    },
  },
});
console.log('Trades im Fenster:');
for (const t of res.trades) if (t.entryT >= t0 - 6 * 3600e3 && t.entryT <= t1 + 6 * 3600e3) console.log('  ', new Date(t.entryT).toISOString().slice(5, 16), t.dir, t.entry, t.reason, t.R?.toFixed?.(2));
