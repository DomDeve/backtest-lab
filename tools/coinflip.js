#!/usr/bin/env node
// Coinflip-Test je Strategie: Weiß das Signal etwas über die RICHTUNG – oder kommt das Ergebnis nur aus Markt-Drift + SL/TP-Struktur?
//
//   node tools/coinflip.js [--run out/live-voll] [--variants id1,id2] [--runs 1000] [--seed 7] [--out out/coinflip]
//   node tools/coinflip.js --select [--run out/live]   -> Auswahl mittesten: je Markt (US100 Capital, FTMO, DE40, EURUSD) alle Varianten
//        des Laufordners als Suchraum; in jedem Münzwurf-Lauf wird – wie bei unserer Suche – die BESTE Variante genommen.
//        p_auswahl je Variante = Anteil Läufe, in denen die beste Zufallsvariante ≥ Sim-Ergebnis dieser Variante (max-T nach Westfall-Young).
//        Münze je Einstiegszeitpunkt und Markt GETEILT -> Varianten mit gleichen Signalen bleiben korreliert wie in echt.
//   node tools/coinflip.js --select --name legacy --ids a,b,c [--run out/live-voll[,ordner2…]] [--symbol US100] -> eigener Suchraum (auch marktübergreifend/über mehrere Laufordner),
//        wird in auswahl.json unter markets[<name>] ergänzt (bestehende Einträge bleiben).
//
// Je Trade bleiben Einstiegskerze, Einstiegspreis, SL-Abstand und TP-Abstand (in Punkten) gleich; nur die Richtung wird per Münzwurf
// gesetzt. Gegenrichtung zahlt den Spread der Einstiegskerze (Long kauft am Ask, Short verkauft am Bid). Ausstieg in einem einfachen,
// für beide Richtungen IDENTISCHEN Simulator: ab der Kerze NACH der Einstiegskerze, SL/TP gegen Bid (Long) bzw. Ask (Short),
// SL und TP in einer Kerze -> SL, Gap über SL -> Open, spätestens nach 10 Handelstagen zum Schluss. R ohne Broker-Kosten (Spread drin).
// Vergleich: Ø R der Original-Richtungen im selben Simulator gegen die Verteilung der Münzwurf-Läufe -> p = Anteil Münzwurf ≥ Original.
// Zusätzlich: „immer Long“ / „immer Short“ (zeigt den Drift-Anteil) und die Kalibrierung Simulator vs. Engine (Ø R Original-Engine).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from '../src/data/load.js';
import { sealBars } from '../src/core/tresor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MS = 14 * 86400000; // 10 Handelstage ≈ 14 Kalendertage

export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Ausgang eines Trades in Richtung dir ab Kerze i0+1. bars: [{t, bo,bh,bl,bc, ao,ah,al,ac}] */
export function simulate(bars, i0, dir, entry, riskPts, tpPts, maxMs = MAX_MS) {
  const L = dir === 'BUY'; const stop = L ? entry - riskPts : entry + riskPts; const tp = L ? entry + tpPts : entry - tpPts;
  const tEnd = bars[i0].t + maxMs;
  for (let i = i0 + 1; i < bars.length; i++) {
    const B = bars[i];
    if (B.t > tEnd) { const P = bars[i - 1]; const px = L ? P.bc : P.ac; return ((L ? px - entry : entry - px)) / riskPts; }
    const o = L ? B.bo : B.ao, hi = L ? B.bh : B.ah, lo = L ? B.bl : B.al;
    if (L ? o <= stop : o >= stop) return ((L ? o - entry : entry - o)) / riskPts; // Gap über SL
    const hitSL = L ? lo <= stop : hi >= stop; const hitTP = L ? hi >= tp : lo <= tp;
    if (hitSL) return -1;
    if (hitTP) return tpPts / riskPts;
  }
  const P = bars[bars.length - 1]; const px = L ? P.bc : P.ac; return ((L ? px - entry : entry - px)) / riskPts;
}

/** Für jeden Trade die Ausgänge Long und Short (im selben Simulator) vorberechnen. */
export function outcomes(bars, trades) {
  const idx = new Map(bars.map((b, i) => [b.t, i])); const out = [];
  for (const t of trades) {
    const i0 = idx.get(t.entryT); if (i0 === undefined || !(t.riskPts > 0) || !(t.tp > 0)) continue;
    const tpPts = Math.abs(t.tp - t.entry); const sp = t.spreadEntry || 0;
    const eL = t.dir === 'BUY' ? t.entry : t.entry + sp; const eS = t.dir === 'SELL' ? t.entry : t.entry - sp;
    out.push({ t: t.entryT, orig: t.dir, R: t.Rgross ?? t.R, rL: simulate(bars, i0, 'BUY', eL, t.riskPts, tpPts), rS: simulate(bars, i0, 'SELL', eS, t.riskPts, tpPts) });
  }
  return out;
}

/**
 * Auswahl mittesten. sets: [{ id, O: outcomes(...) mit entryT }], alle aus EINEM Markt. Münze je entryT geteilt.
 * Rückgabe je Variante { id, n, sim, pSel } und bestes { id, sim, pSel }.
 */
export function coinflipSelect(sets, { runs = 1000, seed = 7 } = {}) {
  const S = sets.filter((s) => s.O.length >= 30); if (!S.length) return null;
  const keys = [...new Set(S.flatMap((s) => s.O.map((o) => o.t)))]; const kIdx = new Map(keys.map((k, i) => [k, i]));
  const sim = S.map((s) => s.O.reduce((a, o) => a + (o.orig === 'BUY' ? o.rL : o.rS), 0) / s.O.length);
  const rnd = mulberry32(seed); const coin = new Uint8Array(keys.length); const maxDist = [];
  for (let k = 0; k < runs; k++) {
    for (let j = 0; j < keys.length; j++) coin[j] = rnd() < 0.5 ? 1 : 0;
    let best = -Infinity;
    for (const s of S) { let sum = 0; for (const o of s.O) sum += coin[kIdx.get(o.t)] ? o.rL : o.rS; best = Math.max(best, sum / s.O.length); }
    maxDist.push(best);
  }
  const res = S.map((s, i) => ({ id: s.id, name: s.name, n: s.O.length, sim: sim[i], pSel: (maxDist.filter((x) => x >= sim[i]).length + 1) / (runs + 1) }));
  const top = res.reduce((a, b) => (b.sim > a.sim ? b : a));
  return { variants: res.sort((a, b) => b.sim - a.sim), best: top, nVariants: S.length };
}

export function coinflip(O, { runs = 1000, seed = 7 } = {}) {
  const n = O.length; if (!n) return null;
  const mean = (f) => O.reduce((s, o) => s + f(o), 0) / n;
  const orig = mean((o) => (o.orig === 'BUY' ? o.rL : o.rS));
  const rnd = mulberry32(seed); const dist = [];
  for (let k = 0; k < runs; k++) { let s = 0; for (const o of O) s += rnd() < 0.5 ? o.rL : o.rS; dist.push(s / n); }
  dist.sort((a, b) => a - b);
  const p = (dist.filter((x) => x >= orig).length + 1) / (runs + 1);
  return { n, engineR: mean((o) => o.R), simOrig: orig, allLong: mean((o) => o.rL), allShort: mean((o) => o.rS), coinMean: dist.reduce((a, b) => a + b, 0) / runs,
    p5: dist[Math.floor(runs * 0.05)], p95: dist[Math.floor(runs * 0.95)], p, longShare: O.filter((o) => o.orig === 'BUY').length / n };
}

/** Kerzen je Datenquelle wie in bin/live.js: Dukascopy-Läufe sehen die Tresor-Jahre nicht (config/tresor.json), Capital unverändert. */
export function barsForSource(bars, symbol, src = 'capital', years) {
  let last = -1; const b = bars.slice().sort((x, y) => x.t - y.t).filter((x) => (x.t > last ? ((last = x.t), true) : false));
  return src === 'dukascopy' ? sealBars(b, symbol, years).bars : b;
}

function loadBarsFor(symbol, cache, src = 'capital') {
  const key = (src || 'capital') + ':' + symbol;
  if (!cache[key]) { const dir = path.join(ROOT, src === 'dukascopy' ? 'data/dukascopy' : 'data/raw', symbol.toLowerCase());
    const { bars } = loadBars(fs.readdirSync(dir).filter((f) => /MINUTE_5_.*\.csv$/.test(f)).map((f) => path.join(dir, f)));
    cache[key] = barsForSource(bars, symbol, src); }
  return cache[key];
}

// RUN darf mehrere Laufordner enthalten (Komma-getrennt) -> ein gemeinsamer Suchraum. Id, die in mehreren Ordnern vorkommt -> „<ordner>/<id>“.
function mainSelect(RUN, OUT, runs, seed, name = null, only = null, symbol = null) {
  const dirs = RUN.split(',').filter(Boolean);
  const all = dirs.flatMap((r) => fs.readdirSync(path.join(ROOT, r)).filter((d) => fs.existsSync(path.join(ROOT, r, d, 'result.json')) && (!only || only.includes(d))).sort().map((id) => ({ r, id })));
  const cnt = {}; for (const x of all) cnt[x.id] = (cnt[x.id] || 0) + 1;
  const groups = {}; const cache = {};
  for (const { r, id: vid } of all) {
    const id = cnt[vid] > 1 ? `${r}/${vid}` : vid;
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, r, vid, 'result.json'), 'utf8'));
    if (symbol && d.symbol !== symbol) continue;
    if (!d.symbol || !d.trades?.length || d.trades[0].entryT === undefined) { process.stderr.write(`(${id} übersprungen) `); continue; }
    const m = name || (d.family === 'NAS_FTMO' || d.opts?.ftmo ? 'FTMO (US100)' : d.symbol);
    const O = outcomes(loadBarsFor(d.symbol, cache, d.data), d.trades).map((o) => ({ ...o, t: d.symbol + ':' + o.t })); // Münze je Markt + Zeitpunkt
    (groups[m] ||= []).push({ id, name: d.name + (cnt[vid] > 1 ? ` [${r}]` : ''), O });
    process.stderr.write(`${id} `);
  }
  const out = {}; const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(3).replace('.', ',');
  const md = ['# Coinflip mit mitgetesteter Auswahl (beste von N)', '', `Suchraum = alle Läufe in \`${RUN}\` je Markt (Varianten mit ≥ 30 Trades), ${runs} Münzwurf-Läufe, Seed ${seed}.`,
    'In jedem Lauf wird die beste Zufallsvariante genommen (wie bei unserer Suche). **p Auswahl** = Anteil Läufe, in denen die beste Zufallsvariante',
    'mindestens so gut ist wie diese Variante. Ohne Auswahl-Korrektur siehe `bericht.md`. R im Simulator, ohne Broker-Kosten.', ''];
  for (const [m, sets] of Object.entries(groups)) {
    const r = coinflipSelect(sets, { runs, seed }); if (!r) continue; out[m] = r;
    md.push(`## ${m} – ${r.nVariants} Varianten`, '', '| Variante | Trades | Sim Ø R | **p Auswahl** |', '|---|---|---|---|');
    for (const v of r.variants.slice(0, 12)) md.push(`| ${v.name} | ${v.n} | ${f(v.sim)} | **${v.pSel.toFixed(3).replace('.', ',')}** |`);
    if (r.variants.length > 12) md.push(`| … ${r.variants.length - 12} weitere | | | |`);
    md.push('');
  }
  fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });
  const jf = path.join(ROOT, OUT, 'auswahl.json'); const prev = name && fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : { markets: {} };
  for (const k of Object.keys(out)) out[k].run = RUN;
  fs.writeFileSync(jf, JSON.stringify({ runs, seed, created: new Date().toISOString(), markets: { ...prev.markets, ...out } }, null, 1));
  fs.writeFileSync(path.join(ROOT, OUT, name ? `auswahl-${name}.md` : 'auswahl.md'), md.join('\n') + '\n');
  console.log(`\n-> ${OUT}/auswahl.md`);
}

function main() {
  const a = process.argv.slice(2); const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  if (a.includes('--select')) return mainSelect(arg('run', 'out/live'), arg('out', 'out/coinflip'), +arg('runs', 1000), +arg('seed', 7), arg('name', null), arg('ids', null)?.split(','), arg('symbol', null));
  const RUN = arg('run', 'out/live-voll'), OUT = arg('out', 'out/coinflip'), runs = +arg('runs', 1000), seed = +arg('seed', 7);
  const want = arg('variants', null)?.split(',');
  const ids = fs.readdirSync(path.join(ROOT, RUN)).filter((d) => fs.existsSync(path.join(ROOT, RUN, d, 'result.json')) && (!want || want.includes(d))).sort();
  const barsBy = {}; const res = [];
  for (const id of ids) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, RUN, id, 'result.json'), 'utf8'));
    const r = coinflip(outcomes(loadBarsFor(d.symbol, barsBy, d.data), d.trades), { runs, seed });
    if (r) res.push({ id, name: d.name, symbol: d.symbol, base: d.base || null, ...r });
    process.stderr.write(`${id} `);
  }
  fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT, 'ergebnis.json'), JSON.stringify({ run: RUN, runs, seed, created: new Date().toISOString(), results: res }, null, 1));
  const f = (x, k = 3) => (x === undefined || x === null || Number.isNaN(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(k).replace('.', ','));
  const md = ['# Coinflip-Test je Strategie', '', `Quelle: \`${RUN}\` (Kerzen je Lauf: data/raw = Capital bzw. data/dukascopy ohne Tresor-Jahre), ${runs} Münzwurf-Läufe, Seed ${seed}. R ohne Broker-Kosten, Spread drin.`,
    'Spalten: **Engine** = Ø R der echten Engine; **Sim** = Ø R der Original-Richtungen im vereinfachten Simulator (Kalibrierung);',
    '**Münzwurf Ø / 5–95 %** = Verteilung bei zufälliger Richtung; **p** = Anteil Münzwurf-Läufe ≥ Sim (klein = Richtung trägt Information);',
    '**immer Long/Short** = alle Trades in eine Richtung (Drift-Anteil).', '',
    '| Strategie | Markt | Trades | Long-Anteil | Engine | Sim | Münzwurf Ø | 5–95 % | **p** | immer Long | immer Short |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of res) md.push(`| ${r.name} | ${r.symbol} | ${r.n} | ${Math.round(r.longShare * 100)} % | ${f(r.engineR)} | ${f(r.simOrig)} | ${f(r.coinMean)} | ${f(r.p5)} … ${f(r.p95)} | **${r.p.toFixed(3).replace('.', ',')}** | ${f(r.allLong)} | ${f(r.allShort)} |`);
  fs.writeFileSync(path.join(ROOT, OUT, 'bericht.md'), md.join('\n') + '\n');
  console.log(`\n${res.length} Strategien -> ${OUT}/bericht.md`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) main();
