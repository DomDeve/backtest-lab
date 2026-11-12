#!/usr/bin/env node
// Live-Code-Backtests (Original-Code-Nodes aus strategies-live/).
//
//   node bin/live.js list
//   node bin/live.js run --variants all | nas-fib61-lb2,de40-basis | group:FTMO  [--out out/live] [--filter-tests 3] [--data capital|dukascopy] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   node bin/live.js combo --base ftmo-basis --cfg '{"fresh":true,"breakoutP":0.25}' [--opts '{"cancelWithoutSignal":true}'] --id ftmo-combo1 --name "..."
//   node bin/live.js compare [--out out/live]      -> Gesamtvergleich vergleich.html / vergleich.md

import fs from 'node:fs';
import path from 'node:path';
import { loadBars } from '../src/data/load.js';
import { cleanSession } from '../src/core/sessions.js';
import { cleanBars, summarizeClean } from '../src/data/clean.js';
import { sealBars, openTresor } from '../src/core/tresor.js';
import { runLive } from '../src/live/runner.js';
import { buildCatalog, comboVariant } from '../src/live/variants.js';
import { analyzeRun } from '../src/analysis/recommend.js';
import { renderHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderComparison } from '../src/report/compare.js';

const args = (() => { const a = { _: [] }; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) { if (v[i].startsWith('--')) { a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true; } else a._.push(v[i]); } return a; })();
const OUT = args.out || 'out/live';
// --spread capital: Spread-Unterschied Capital − Dukascopy (gemessen je Stunde) als Kosten je Trade – Empfindlichkeit, Kurse bleiben echt
const SPREAD = args.spread === 'capital' ? JSON.parse(fs.readFileSync('config/spread_profil.json', 'utf8')).epics : null;
// --engine '{"trailing":{"beR":1,"partialR":2,"partialPct":50,"trailR":1,"trailStartR":2}}' – zusätzliche Engine-Optionen (z. B. Trailing-Test)
const ENGINE_X = args.engine ? JSON.parse(args.engine) : {};
const ENGINE = { ...ENGINE_X, ...(SPREAD ? { spreadProfile: SPREAD } : {}), ...(args['de40-live'] ? { de40AskShift: true } : {}), ...(args['no-tick'] ? { noTick: true } : {}) }; // --de40-live (Ask-Versatz, nur Einzelfall 85038 – nicht verwenden), --no-tick (ohne laufende M5-Kerze)
const SESS = Object.fromEntries(['DE40', 'US100', 'EURUSD'].map((e) => [e, cleanSession(e)])); // Kernzeit aus config/sessions.yaml
// Datenquelle: --data capital (Standard, data/raw) | dukascopy (data/dukascopy/<epic>, M5 aus M1, Bid + Ask, ab 2004/2012/2013)
// --from / --to (YYYY-MM-DD, UTC) schneiden den Zeitraum zu (z. B. Kontrolle Dukascopy vs. Capital im gleichen Zeitraum).
const DATA = args.data || 'capital';
if (!['capital', 'dukascopy'].includes(DATA)) throw new Error(`--data ${DATA}: erlaubt capital | dukascopy`);
const DIRS = DATA === 'dukascopy' ? { DE40: 'data/dukascopy/de40', US100: 'data/dukascopy/us100', EURUSD: 'data/dukascopy/eurusd' }
  : { DE40: 'data/raw/de40', US100: 'data/raw/us100', EURUSD: 'data/raw/eurusd' };
const cache = {};

function data(sym) {
  if (cache[sym]) return cache[sym];
  const dir = DIRS[sym];
  const files = fs.readdirSync(dir).filter((f) => /MINUTE_5_.*\.csv$/.test(f)).map((f) => path.join(dir, f));
  let { bars } = loadBars(files);
  if (args.from) bars = bars.filter((b) => b.t >= Date.parse(args.from + 'T00:00:00Z'));
  if (args.to) bars = bars.filter((b) => b.t < Date.parse(args.to + 'T00:00:00Z') + 86400000);
  // Tresor (config/tresor.json): Standard = versiegelte Jahre raus; Öffnen nur mit --tresor "<Begründung>" (wird protokolliert)
  if (typeof args.tresor === 'string') openTresor({ epic: sym, reason: args.tresor, variants: String(args.variants || '').split(',').filter(Boolean) });
  else {
    const s = sealBars(bars, sym);
    if (s.removed) console.log(`Tresor ${sym}: ${s.removed} Kerzen der Jahre ${s.years.join(', ')} ausgeblendet`);
    bars = s.bars;
  }
  const c = cleanBars(bars, { session: SESS[sym] , asDelivered: true });
  c.text = summarizeClean(c.report);
  return (cache[sym] = c);
}

function tradesCsv(trades) {
  const cols = ['id', 'date', 'dir', 'signalHm', 'entryHm', 'entry', 'stop', 'tp', 'exitDate', 'exitHm', 'exit', 'reason', 'R', 'pts', 'riskPts', 'mfeR', 'maeR', 'minutesHeld', 'conflict', 'orderType', 'fill'];
  const feat = [...new Set(trades.flatMap((t) => Object.keys(t.features || {})))];
  return [[...cols, ...feat].join(';'), ...trades.map((t) => [...cols.map((c) => t[c]), ...feat.map((f) => t.features?.[f])].map((v) => (v == null ? '' : v)).join(';'))].join('\n');
}

function runOne(v) {
  const d = data(v.symbol);
  const t0 = Date.now();
  const result = runLive({ bars: d.bars, days: d.days, variant: v, engine: ENGINE });
  const tRun = Date.now() - t0;
  const rerun = (filters) => runLive({ bars: d.bars, days: d.days, variant: v, engine: ENGINE, params: { filters } });
  const analysis = analyzeRun({ result, bars: d.bars, days: d.days, strategy: { name: v.name }, cleanReport: d.report, opts: { rerun, exitVariants: v.exitVariants, maxFilterTests: Number(args['filter-tests'] ?? 3) } });
  const dir = path.join(OUT, v.id);
  fs.mkdirSync(dir, { recursive: true });
  const title = `${v.name} – Backtest (Original-Code)`;
  const generatedAt = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const slim = result.trades.map(({ entryIdx, exitIdx, ...t }) => t);
  fs.writeFileSync(path.join(dir, 'report.html'), renderHtml({ title, result, analysis, clean: { text: d.text }, generatedAt }));
  fs.writeFileSync(path.join(dir, 'summary.md'), renderMarkdown({ title, result, analysis }));
  fs.writeFileSync(path.join(dir, 'trades.csv'), tradesCsv(result.trades));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    id: v.id, name: v.name, group: v.group, family: v.family, symbol: v.symbol, base: v.base, desc: v.desc, opts: v.opts,
    data: DATA, spread: SPREAD ? 'capital' : 'echt', period: result.period, engine: result.engine, events: result.events, filterReasons: result.filterReasons,
    summary: { ...analysis.summary, curveR: undefined }, stability: analysis.stability, longShort: { long: { ...analysis.longShort.long, curveR: undefined }, short: { ...analysis.longShort.short, curveR: undefined } },
    recommendations: analysis.recommendations, filterTests: analysis.filterTests, exits: analysis.exits, risk: analysis.risk, challenge: analysis.challenge,
    patterns: { strengths: analysis.patterns.strengths, weaknesses: analysis.patterns.weaknesses }, trades: slim,
  }));
  console.log(`${v.id.padEnd(18)} ${String(result.trades.length).padStart(4)} Trades  Ø ${analysis.summary.avgR ?? '–'}R  Σ ${analysis.summary.sumR ?? '–'}R  (${(tRun / 1000).toFixed(1)} s Lauf, ${((Date.now() - t0) / 1000).toFixed(1)} s gesamt)${Object.keys(result.events.errors).length ? '  FEHLER ' + JSON.stringify(result.events.errors) : ''}`);
}

const cat = buildCatalog();
const cmd = args._[0];
if (cmd === 'list') {
  let g = '';
  for (const v of cat) { if (v.group !== g) { g = v.group; console.log('\n' + g); } console.log(`  ${v.id.padEnd(18)} ${v.name.padEnd(36)} ${v.desc}`); }
} else if (cmd === 'run') {
  const sel = String(args.variants || 'all');
  const list = sel === 'all' ? cat : sel.startsWith('group:') ? cat.filter((v) => v.group.includes(sel.slice(6))) : sel.split(',').map((id) => cat.find((v) => v.id === id) || (() => { throw new Error('Unbekannt: ' + id); })());
  for (const v of list) runOne(v);
} else if (cmd === 'combo') {
  const v = comboVariant(args.base, JSON.parse(args.cfg || '{}'), JSON.parse(args.opts || '{}'), args.id, args.name);
  v.group = args.group || 'Kombination';
  runOne(v);
} else if (cmd === 'compare') {
  renderComparison(OUT);
} else {
  console.log('Befehle: list | run | combo | compare');
}
