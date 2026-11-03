#!/usr/bin/env node
// Erzeugt synthetische DE40-M5-Kerzen im Capital.com-/prices-Format (zum Testen der Pipeline).
// ACHTUNG: Zufallsdaten. Ergebnisse darauf sagen nichts über die echte Strategie aus –
// sie zeigen nur, ob Engine, Bereinigung und Analyse funktionieren (und ob die Robustheitsprüfung
// Zufallsmuster korrekt als "nicht robust" erkennt).
//
//   node tools/gen-synthetic.js --out data/raw/synthetic-de40.json --days 500 [--seed 7] [--clean]

import fs from 'node:fs';
import path from 'node:path';
import { utcFor, local } from '../src/core/time.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : a), []));
const out = args.out || 'data/raw/synthetic-de40.json';
const nDays = Number(args.days || 500);
let seed = Number(args.seed || 7);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const prices = [];
let px = 18000;
const start = Date.UTC(2024, 0, 2);
let made = 0;
for (let d = 0; made < nDays; d++) {
  const dayMs = start + d * 86400000;
  const date = new Date(dayMs).toISOString().slice(0, 10);
  const wd = new Date(dayMs).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  made++;
  const trendDay = rnd() < 0.3;
  const drift = trendDay ? (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd()) : 0;
  px *= 1 + gauss() * 0.004; // Overnight-Gap
  for (let t = utcFor(date, '08:00'); ; t += 300000) {
    const L = local(t);
    if (L.hm > '21:55') break;
    const h = L.hour + L.minute / 60;
    const core = h >= 9 && h < 17.5;
    const vol = (core ? (h < 10 ? 2.2 : h > 15.5 ? 1.6 : 1.0) : 0.6) * 9; // Punkte je Kerze (U-Form)
    const mu = core && h >= 10 ? drift * 1.2 : 0;
    const o = px;
    const path = [o];
    for (let k = 0; k < 5; k++) path.push(path[k] + mu / 5 + gauss() * vol / Math.sqrt(5));
    const c = path[5];
    const hi = Math.max(...path) + Math.abs(gauss()) * vol * 0.2;
    const lo = Math.min(...path) - Math.abs(gauss()) * vol * 0.2;
    px = c;
    const sp = core ? 1.8 : 2.8;
    const r1 = (x) => Math.round(x * 10) / 10;
    const side = (x) => ({ bid: r1(x - sp / 2), ask: r1(x - sp / 2) + sp });
    prices.push({
      snapshotTime: new Date(t).toISOString().slice(0, 19), snapshotTimeUTC: new Date(t).toISOString().slice(0, 19),
      openPrice: side(o), closePrice: side(c), highPrice: side(hi), lowPrice: side(lo), lastTradedVolume: Math.round(200 + rnd() * 400),
    });
  }
}

// Schmutz einbauen, damit die Bereinigung etwas zu tun hat
if (!args.clean) {
  prices.splice(1500, 0, { ...prices[1500] }); // Duplikat
  prices[2000] = { ...prices[2000], highPrice: { bid: prices[2000].lowPrice.bid - 5, ask: prices[2000].lowPrice.ask - 5 } }; // kaputte Kerze
  prices[3000] = { ...prices[3000], highPrice: { bid: prices[3000].highPrice.bid + 600, ask: prices[3000].highPrice.ask + 600 } }; // Spike
  const sh = (p) => ({ bid: p.bid, ask: p.ask + 23 });
  const b4 = prices[4000];
  prices[4000] = { ...b4, openPrice: sh(b4.openPrice), highPrice: sh(b4.highPrice), lowPrice: sh(b4.lowPrice), closePrice: sh(b4.closePrice) }; // Spread-Ausreißer
  prices.splice(5000, 20); // Lücke
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ instrument: 'DE40 (synthetisch)', prices }));
console.log(`${prices.length} Kerzen (${nDays} Tage) -> ${out}`);
