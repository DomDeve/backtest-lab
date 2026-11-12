#!/usr/bin/env node
// Kandidat „Fair Price“: Raster für NAS100 + DE40 rechnen.
//   node bin/fairprice.js [--slip 0.5] [--out out/kandidaten/fairprice]
// Ergebnis: trades.json (alle Varianten), fp-check.json (Annahmen-Check), meta.json. Auswertung: tools/fairprice_report.py

import { cleanSession } from '../src/core/sessions.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadBars } from '../src/data/load.js';
import { cleanBars } from '../src/data/clean.js';
import { INSTRUMENTS, buildSessions, runVariant, fpReach } from '../src/candidates/fairprice.js';

const args = (() => { const a = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true; return a; })();
const OUT = args.out || 'out/kandidaten/fairprice';
const SLIP = Number(args.slip ?? 0.5);
fs.mkdirSync(OUT, { recursive: true });

function load(sym, dir, session) {
  const files = fs.readdirSync(dir).filter((f) => /MINUTE_5_.*\.csv$/.test(f)).map((f) => path.join(dir, f));
  const { bars } = loadBars(files);
  return cleanBars(bars, { session });
}
const data = {
  US100: load('US100', 'data/raw/us100', cleanSession('US100')),
  DE40: load('DE40', 'data/raw/de40', cleanSession('DE40')),
};

// Sessions
const S = {};
for (const [sym, def] of Object.entries(INSTRUMENTS)) for (const [k, sd] of Object.entries(def.sessions)) S[`${sym}|${k}`] = buildSessions(data[sym].bars, sd);

// ATR-Verhältnis DE40/NAS100 aus der mittleren Kerzenrange der ersten 90 Minuten (Hauptsessions), Median über den Zeitraum
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sessRange = (bars, sess) => median(sess.map((s) => { let r = 0; for (let k = 0; k < s.n; k++) { const b = bars[s.i0 + k]; r += (b.bh + b.ah) / 2 - (b.bl + b.al) / 2; } return r / s.n; }));
const rNas = sessRange(data.US100.bars, S['US100|main']), rDe = sessRange(data.DE40.bars, S['DE40|main']);
const ratio = rDe / rNas;
const minSlDe = 25 * ratio;
console.log(`Mittlere M5-Range erste 90 Min: NAS ${rNas.toFixed(1)} · DE40 ${rDe.toFixed(1)} -> Verhältnis ${ratio.toFixed(3)}, Mindest-SL DE40 ${minSlDe.toFixed(1)} Pkt`);

const NAS_GRID = [];
for (const sl of [25, 37.5, 50, 75]) for (const tp of [38, 50, 75, 100]) if (tp / sl >= 1) NAS_GRID.push([sl, tp]);
const SETUPS = [['A', 'ema'], ['A', 'off'], ['A', 'counter'], ['B1', null], ['B2', null], ['B12', null]];

const variants = [];
for (const key of Object.keys(S)) {
  const [sym, sess] = key.split('|');
  const grids = [];
  if (sym === 'US100') for (const [sl, tp] of NAS_GRID) grids.push({ scheme: 'Punkte', label: `SL ${sl} / TP ${tp}`, sl, tp });
  else {
    for (const [sl, tp] of NAS_GRID) grids.push({ scheme: 'skaliert', label: `SL ${sl}·k / TP ${tp}·k`, sl: sl * ratio, tp: tp * ratio });
    for (const k of [1, 1.5, 2]) for (const m of [1, 1.5, 2, 3]) {
      // M1-ATR aus M5-ATR genähert: ATR_M1 ≈ ATR_M5 / √5
      const slF = (s) => Math.max(minSlDe, k * s.atr / Math.sqrt(5));
      grids.push({ scheme: 'ATR', label: `SL ${k}×ATR / TP ${m}×SL`, sl: slF, tp: (s) => m * slF(s) });
    }
  }
  for (const [setup, bias] of SETUPS) for (const g of grids) {
    const id = `${sym}|${sess}|${setup}${bias ? '-' + bias : ''}|${g.scheme}|${g.label}`;
    const trades = runVariant(data[sym].bars, S[key], { setup, bias, sl: g.sl, tp: g.tp, slip: SLIP });
    variants.push({ id, sym, sess, setup, bias, scheme: g.scheme, grid: g.label, trades });
  }
  console.log(`${key}: ${S[key].length} Sessions, ${variants.filter((v) => v.sym === sym && v.sess === sess).length} Varianten`);
}

// Annahmen-Check FP
const fp = {};
for (const key of Object.keys(S)) {
  const [sym] = key.split('|');
  fp[key] = fpReach(data[sym].bars, S[key], (s) => (sym === 'US100' ? 25 : minSlDe));
}

const sessInfo = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, { n: v.length, from: v[0]?.date, to: v[v.length - 1]?.date }]));
fs.writeFileSync(path.join(OUT, 'trades.json'), JSON.stringify(variants));
fs.writeFileSync(path.join(OUT, 'fp-check.json'), JSON.stringify(fp));
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ slip: SLIP, ratio, rNas, rDe, minSlDe, sessions: sessInfo, generated: new Date().toISOString() }, null, 1));
console.log(`geschrieben: ${variants.length} Varianten, ${variants.reduce((a, v) => a + v.trades.length, 0)} Trades -> ${OUT}`);
