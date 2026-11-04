#!/usr/bin/env node
// Datenprüfung für alle Kursdateien: Zeitraum vs. Dateiname, Duplikate, Raster, OHLC/Bid-Ask,
// Lücken in den Strategie-Zeitfenstern, fehlende Handelstage, Überlappungen zwischen Dateien,
// Konsistenz M5 -> M15/H4 (falls höhere Zeitebenen vorhanden).
//
//   node tools/audit-data.js data/raw [--out out/datenpruefung]

import fs from 'node:fs';
import path from 'node:path';
import { loadBars } from '../src/data/load.js';
import { local, hmList } from '../src/core/time.js';

const root = process.argv[2] || 'data/raw';
const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'out/datenpruefung';

// Zeitfenster, in denen die Strategien Kerzen brauchen (Lücken dort sind kritisch)
const WINDOWS = {
  DE40: { tz: 'Europe/Berlin', from: '09:00', to: '17:25', label: 'Xetra 09:00–17:30 Berlin' },
  US100: { tz: 'UTC', from: '07:00', to: '18:55', label: 'NAS-Bot 07:00–19:00 UTC' },
  EURUSD: { tz: 'UTC', from: '06:00', to: '18:55', label: 'EURUSD-Bot 06:00–19:00 UTC' },
};
const TF_MIN = { MINUTE_5: 5, MINUTE_15: 15, HOUR: 60, HOUR_4: 240 };

const files = [];
const walk = (p) => { for (const f of fs.readdirSync(p)) { const q = path.join(p, f); if (fs.statSync(q).isDirectory()) walk(q); else if (/^capital_.*\.csv$/i.test(f)) files.push(q); } };
walk(root);

const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const quant = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * q)]; };

const perFile = [];
const byInstrumentTf = {};
for (const f of files.sort()) {
  const name = path.basename(f);
  const m = name.match(/capital_([A-Z0-9]+)_(MINUTE_5|MINUTE_15|HOUR_4|HOUR)_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/);
  if (!m) continue;
  const [, sym, tf, claimFrom, claimTo] = m;
  const { bars } = loadBars(f);
  const step = TF_MIN[tf] * 60000;
  const ts = bars.map((b) => b.t);
  const seen = new Set();
  let dup = 0, offGrid = 0, askBelow = 0, ohlc = 0, nonFinite = 0, zeroVol = 0, flat = 0;
  const spreads = [];
  for (const b of bars) {
    if (![b.t, b.bo, b.bh, b.bl, b.bc, b.ao, b.ah, b.al, b.ac].every(Number.isFinite)) { nonFinite++; continue; }
    if (seen.has(b.t)) dup++; seen.add(b.t);
    if (tf !== 'HOUR_4' && b.t % step !== 0) offGrid++;
    if (b.ac < b.bc || b.ao < b.bo) askBelow++;
    if (b.bh < Math.max(b.bo, b.bc) - 1e-9 || b.bl > Math.min(b.bo, b.bc) + 1e-9 || b.ah < Math.max(b.ao, b.ac) - 1e-9 || b.al > Math.min(b.ao, b.ac) + 1e-9) ohlc++;
    if (!(b.vol > 0)) zeroVol++;
    if (b.bh === b.bl) flat++;
    spreads.push(b.ac - b.bc);
  }
  let unsorted = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) unsorted++;
  const first = Math.min(...ts), last = Math.max(...ts);
  const firstD = new Date(first).toISOString().slice(0, 10), lastD = new Date(last).toISOString().slice(0, 10);
  const claimGap = Math.round((first - Date.parse(claimFrom + 'T00:00:00Z')) / 86400000);
  perFile.push({
    file: name, symbol: sym, tf, rows: bars.length, from: new Date(first).toISOString().slice(0, 16), to: new Date(last).toISOString().slice(0, 16),
    claimFrom, claimTo, startsDaysLate: claimGap > 3 ? claimGap : 0, endsEarlyDays: Math.max(0, Math.round((Date.parse(claimTo + 'T00:00:00Z') - last) / 86400000)),
    duplicates: dup, offGrid, unsorted, askBelowBid: askBelow, ohlcBroken: ohlc, nonFinite, zeroVolume: zeroVol, flatBars: flat,
    spreadMedian: quant(spreads, 0.5), spreadP99: quant(spreads, 0.99), spreadMax: spreads.length ? Math.max(...spreads) : null,
  });
  ((byInstrumentTf[sym] ||= {})[tf] ||= []).push({ name, bars, first, last });
}

// ---------- je Instrument (M5 zusammengeführt) ----------
const instruments = {};
for (const [sym, tfs] of Object.entries(byInstrumentTf)) {
  const m5files = (tfs.MINUTE_5 || []).sort((a, b) => a.first - b.first);
  if (!m5files.length) continue;
  // Überlappungen + Abweichungen
  const overlaps = [];
  for (let i = 1; i < m5files.length; i++) {
    const a = m5files[i - 1], b = m5files[i];
    if (b.first <= a.last) {
      const mapA = new Map(a.bars.map((x) => [x.t, x]));
      let n = 0, diff = 0;
      for (const x of b.bars) { const y = mapA.get(x.t); if (y) { n++; if (Math.abs(y.bc - x.bc) > 1e-6 || Math.abs(y.ac - x.ac) > 1e-6) diff++; } }
      overlaps.push({ a: a.name, b: b.name, overlapFrom: new Date(b.first).toISOString().slice(0, 16), overlapTo: new Date(Math.min(a.last, b.last)).toISOString().slice(0, 16), commonBars: n, differingBars: diff });
    } else if (b.first - a.last > 3 * 86400000) {
      overlaps.push({ a: a.name, b: b.name, gapFrom: new Date(a.last).toISOString().slice(0, 16), gapTo: new Date(b.first).toISOString().slice(0, 16), gapDays: Math.round((b.first - a.last) / 86400000) });
    }
  }
  const all = new Map();
  for (const f of m5files) for (const b of f.bars) all.set(b.t, b);
  const bars = [...all.values()].sort((a, b) => a.t - b.t);
  const W = WINDOWS[sym];
  const expected = hmList(W.from, W.to);
  const days = {};
  for (const b of bars) {
    const L = W.tz === 'UTC' ? { date: new Date(b.t).toISOString().slice(0, 10), hm: new Date(b.t).toISOString().slice(11, 16), weekday: new Date(b.t).getUTCDay() } : local(b.t, W.tz);
    if (L.weekday === 0 || L.weekday === 6) continue;
    (days[L.date] ||= new Set()).add(L.hm);
  }
  // fehlende Werktage
  const start = new Date(bars[0].t), end = new Date(bars[bars.length - 1].t);
  const missingDays = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d <= end; d = new Date(d.getTime() + 86400000)) {
    const wd = d.getUTCDay(); if (wd === 0 || wd === 6) continue;
    const ds = d.toISOString().slice(0, 10);
    if (!days[ds]) missingDays.push(ds);
  }
  // Lücken im Strategie-Fenster
  let expectedTotal = 0, presentTotal = 0;
  const gapDays = [];
  const partialDays = [];
  for (const [ds, set] of Object.entries(days)) {
    const miss = expected.filter((h) => !set.has(h));
    expectedTotal += expected.length; presentTotal += expected.length - miss.length;
    if (miss.length === 0) continue;
    // zusammenhängende Lückenblöcke
    const blocks = [];
    let cur = null;
    for (const h of expected) {
      if (!set.has(h)) { if (cur && cur.last === expected[expected.indexOf(h) - 1]) { cur.last = h; cur.n++; } else { cur = { from: h, last: h, n: 1 }; blocks.push(cur); } }
    }
    const longest = Math.max(...blocks.map((b) => b.n));
    const row = { date: ds, missing: miss.length, of: expected.length, longestGapBars: longest, blocks: blocks.slice(0, 4).map((b) => `${b.from}–${b.last} (${b.n})`).join(', ') };
    if (miss.length >= expected.length * 0.5) partialDays.push(row); else gapDays.push(row);
  }
  gapDays.sort((a, b) => b.missing - a.missing);
  // Konsistenz M5 -> höhere Zeitebenen
  const consistency = [];
  for (const tf of ['MINUTE_15', 'HOUR_4']) {
    if (!tfs[tf]) continue;
    const step = TF_MIN[tf] * 60000;
    const agg = new Map();
    for (const b of bars) {
      const k = Math.floor(b.t / step) * step;
      const a = agg.get(k);
      if (!a) agg.set(k, { bo: b.bo, bh: b.bh, bl: b.bl, bc: b.bc, n: 1 });
      else { a.bh = Math.max(a.bh, b.bh); a.bl = Math.min(a.bl, b.bl); a.bc = b.bc; a.n++; }
    }
    let n = 0, bad = 0, missingInM5 = 0, maxDiff = 0;
    const examples = [];
    for (const f of tfs[tf]) for (const x of f.bars) {
      const a = agg.get(x.t);
      if (!a) { missingInM5++; continue; }
      if (a.n < TF_MIN[tf] / 5) continue; // unvollständig in M5 – nicht vergleichbar
      n++;
      const d = Math.max(Math.abs(a.bo - x.bo), Math.abs(a.bh - x.bh), Math.abs(a.bl - x.bl), Math.abs(a.bc - x.bc));
      maxDiff = Math.max(maxDiff, d);
      if (d > 0.051) { bad++; if (examples.length < 5) examples.push({ t: new Date(x.t).toISOString().slice(0, 16), diff: r1(d) }); }
    }
    consistency.push({ tf, compared: n, mismatches: bad, mismatchPct: pct(bad, n), maxDiff: r1(maxDiff), barsWithoutM5: missingInM5, examples });
  }
  instruments[sym] = {
    window: W.label, period: { from: new Date(bars[0].t).toISOString().slice(0, 10), to: new Date(bars[bars.length - 1].t).toISOString().slice(0, 10) },
    m5Bars: bars.length, tradingDays: Object.keys(days).length, windowCompleteness: pct(presentTotal, expectedTotal),
    daysWithGaps: gapDays.length, mostlyEmptyDays: partialDays, worstGapDays: gapDays.slice(0, 15), missingWeekdays: missingDays, fileJoins: overlaps, consistency,
  };
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'datenpruefung.json'), JSON.stringify({ files: perFile, instruments }, null, 1));

// Konsole
console.log('\n=== Dateien ===');
for (const f of perFile) {
  const warn = [];
  if (f.startsLateDays || f.startsDaysLate) warn.push(`beginnt ${f.startsDaysLate} Tage NACH Dateiname`);
  if (f.endsEarlyDays > 3) warn.push(`endet ${f.endsEarlyDays} Tage vor Dateiname`);
  for (const k of ['duplicates', 'offGrid', 'unsorted', 'askBelowBid', 'ohlcBroken', 'nonFinite']) if (f[k]) warn.push(`${k} ${f[k]}`);
  console.log(`${f.file.padEnd(62)} ${String(f.rows).padStart(7)} Zeilen  ${f.from} → ${f.to}  Spread med ${r1(f.spreadMedian)} p99 ${r1(f.spreadP99)} max ${r1(f.spreadMax)}  ${warn.length ? '⚠ ' + warn.join(', ') : 'ok'}`);
}
for (const [s, x] of Object.entries(instruments)) {
  console.log(`\n=== ${s} (M5 zusammengeführt) ${x.period.from} → ${x.period.to}, ${x.tradingDays} Handelstage, Fenster ${x.window}: ${x.windowCompleteness} % vollständig`);
  console.log(`Fehlende Werktage (${x.missingWeekdays.length}): ${x.missingWeekdays.join(', ')}`);
  console.log(`Tage mit Lücken im Fenster: ${x.daysWithGaps}, fast leere Tage: ${x.mostlyEmptyDays.length} ${x.mostlyEmptyDays.map((d) => d.date + '(' + d.missing + '/' + d.of + ')').join(', ')}`);
  for (const g of x.worstGapDays.slice(0, 8)) console.log(`   ${g.date}: ${g.missing}/${g.of} fehlen, längste Lücke ${g.longestGapBars} Kerzen – ${g.blocks}`);
  for (const j of x.fileJoins) console.log(`   Dateiübergang: ${JSON.stringify(j)}`);
  for (const c of x.consistency) console.log(`   M5→${c.tf}: ${c.compared} verglichen, ${c.mismatches} abweichend (${c.mismatchPct} %), max Diff ${c.maxDiff}, ${c.barsWithoutM5} ohne M5 ${c.examples.length ? JSON.stringify(c.examples) : ''}`);
}
