#!/usr/bin/env node
// CLI der Backtest-Engine.
//
//   node bin/bt.js list
//   node bin/bt.js clean    --data data/raw/de40 [--config config/de40-orb60.json]
//   node bin/bt.js run      --config config/de40-orb60.json [--data ...] [--live ...] [--from 2025-01-01] [--to ...] [--set riskPercent=0.5] [--param tpR=2]
//   node bin/bt.js optimize --config config/de40-orb60.json [--grid '{"tpR":[null,2]}']
//
// Ausgabe je Lauf in out/<name>/: report.html, summary.md, result.json, trades.csv, clean-report.json

import fs from 'node:fs';
import path from 'node:path';
import { loadBars } from '../src/data/load.js';
import { cleanBars, summarizeClean } from '../src/data/clean.js';
import { runBacktest } from '../src/core/engine.js';
import { getStrategy, STRATEGIES } from '../src/strategies/index.js';
import { analyzeRun } from '../src/analysis/recommend.js';
import { optimize } from '../src/analysis/optimize.js';
import { loadLive, compareLive } from '../src/analysis/compare.js';
import { renderHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';

function parseArgs(argv) {
  const a = { _: [] , set: [], param: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (k === 'set' || k === 'param') a[k].push(v); else a[k] = v;
    } else a._.push(x);
  }
  return a;
}
const parseVal = (v) => { try { return JSON.parse(v); } catch { return v; } };
const kv = (list) => Object.fromEntries(list.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), parseVal(s.slice(i + 1))]; }));

function loadConfig(args) {
  const cfg = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {};
  if (args.strategy) cfg.strategy = args.strategy;
  if (args.data) cfg.data = String(args.data).split(',');
  if (args.live) cfg.live = args.live === 'none' ? null : args.live;
  if (args.out) cfg.out = args.out;
  cfg.range = { ...(cfg.range || {}), ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) };
  cfg.engine = { ...(cfg.engine || {}), ...kv(args.set) };
  cfg.params = { ...(cfg.params || {}), ...kv(args.param) };
  return cfg;
}

function prepareData(cfg) {
  if (!cfg.data?.length) throw new Error('Keine Daten angegeben (--data oder "data" in der Config).');
  const t0 = Date.now();
  const { bars, sources } = loadBars(cfg.data, cfg.load || {});
  const c = cleanBars(bars, cfg.clean || {});
  const text = summarizeClean(c.report);
  console.log(text);
  console.log(`(${sources.length} Datei(en), ${Date.now() - t0} ms)`);
  return { ...c, text, sources };
}

function writeOut(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

function tradesCsv(trades) {
  const cols = ['id', 'date', 'dir', 'signalHm', 'entryHm', 'entry', 'stop', 'tp', 'exitHm', 'exit', 'reason', 'pts', 'riskPts', 'R', 'size', 'pnl', 'balanceAfter', 'mfeR', 'maeR', 'minutesHeld', 'conflict', 'spreadEntry'];
  const feat = [...new Set(trades.flatMap((t) => Object.keys(t.features || {})))];
  const rows = trades.map((t) => [...cols.map((c) => t[c]), ...feat.map((f) => t.features?.[f])].map((v) => (v == null ? '' : String(v).includes(';') ? `"${v}"` : v)).join(';'));
  return [[...cols, ...feat].join(';'), ...rows].join('\n');
}

async function cmdRun(args, withOptimize = false) {
  const cfg = loadConfig(args);
  const strategy = await getStrategy(cfg.strategy);
  const data = prepareData(cfg);
  const t0 = Date.now();
  const result = runBacktest({ bars: data.bars, days: data.days, strategy, params: cfg.params, engine: cfg.engine, range: cfg.range });
  console.log(`Backtest: ${result.trades.length} Trades in ${Date.now() - t0} ms`);

  let live = null;
  if (cfg.live && fs.existsSync(cfg.live)) {
    const rows = loadLive(cfg.live, { strategyName: cfg.liveStrategyName ?? strategy.name });
    live = compareLive(result.trades, rows);
    console.log(`Live-Abgleich: ${live.liveTrades} Live-Trades, Übereinstimmung ${live.matchRate != null ? Math.round(live.matchRate * 100) + ' %' : '–'}`);
  } else if (cfg.live) console.log(`Hinweis: Live-Datei ${cfg.live} nicht gefunden – Abgleich übersprungen.`);

  let opt = null;
  if (withOptimize) {
    const grid = args.grid ? JSON.parse(args.grid) : cfg.grid || strategy.grid;
    const t1 = Date.now();
    opt = optimize({ bars: data.bars, days: data.days, strategy, baseParams: cfg.params, engine: cfg.engine, grid, minTrades: cfg.minTrades ?? 30 });
    console.log(`Optimierung: ${opt.combos} Kombinationen in ${Date.now() - t1} ms, Walk-Forward Ø ${opt.walkForward.avgR}R`);
  }

  const t2 = Date.now();
  const analysis = analyzeRun({ result, bars: data.bars, days: data.days, strategy, live, cleanReport: data.report });
  console.log(`Analyse: ${analysis.recommendations.length} Empfehlungen in ${Date.now() - t2} ms`);

  const title = cfg.name || `${strategy.name} – Backtest`;
  const outDir = cfg.out || path.join('out', strategy.id);
  const generatedAt = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const slimTrades = result.trades.map(({ entryIdx, exitIdx, ...t }) => t);
  writeOut(outDir, {
    'report.html': renderHtml({ title, result, analysis, clean: { text: data.text, report: data.report }, live, optimize: opt, generatedAt }),
    'summary.md': renderMarkdown({ title, result, analysis, live, optimize: opt }),
    'result.json': JSON.stringify({ title, generatedAt, config: cfg, strategy: result.strategy, params: result.params, engine: result.engine, period: result.period, events: result.events, summary: { ...analysis.summary, curveR: undefined }, recommendations: analysis.recommendations, patterns: { strengths: analysis.patterns.strengths, weaknesses: analysis.patterns.weaknesses }, filterTests: analysis.filterTests, exits: analysis.exits, risk: analysis.risk, challenge: analysis.challenge, stability: analysis.stability, live, optimize: opt, trades: slimTrades }, null, 1),
    'trades.csv': tradesCsv(result.trades),
    'clean-report.json': JSON.stringify(data.report, null, 1),
  });
  console.log(`\nFertig -> ${outDir}/report.html\n`);
  console.log(renderMarkdown({ title, result, analysis, live, optimize: opt }).split('## Schwächen')[0]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'list') {
    for (const s of Object.values(STRATEGIES)) console.log(`${s.id.padEnd(16)} ${s.name.padEnd(18)} ${s.description}`);
  } else if (cmd === 'clean') {
    const cfg = loadConfig(args);
    const d = prepareData(cfg);
    const out = cfg.out || 'out';
    writeOut(out, { 'clean-report.json': JSON.stringify(d.report, null, 1) });
    if (d.report.incompleteDays.length) console.log('Unvollständige Tage:', d.report.incompleteDays.slice(0, 20).map((x) => `${x.date} (-${x.missing})`).join(', '));
    console.log(`Bericht -> ${out}/clean-report.json`);
  } else if (cmd === 'run') await cmdRun(args, !!args.optimize);
  else if (cmd === 'optimize') await cmdRun(args, true);
  else {
    console.log('Befehle: list | clean | run | optimize   (Details: siehe README.md)');
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error('Fehler:', e.message); process.exit(1); });
