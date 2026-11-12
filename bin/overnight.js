#!/usr/bin/env node
// Kandidat Overnight-Drift (07.11.2026): Long zum Session-Schluss, Verkauf zur nächsten Session-Eröffnung.
// Hypothese (Literatur: Renditen von Aktienindizes entstehen überwiegend außerhalb der Handelszeit) – vorab festgelegt,
// KEIN Raster. Varianten:
//   ON      jede Nacht
//   ON-WT   ohne Wochenende (kein Einstieg am Freitag / vor Feiertag-Lücke > 1 Nacht)
//   ON-SMA  nur wenn Session-Schluss > SMA200 der Session-Schlusskurse (Trendfilter, ohne Lookahead: Schluss ist bekannt)
//   ID      Kontrolle: Long Eröffnung -> Schluss (Intraday)
//   ON-S    Kontrolle: Short über Nacht
// Ausführung über die portierte Engine (Gegenprobe: tools/engine-check.js). Spread steckt im Ergebnis (Kauf Ask, Verkauf Bid).
// Finanzierung (CFD-Overnight) als Jahressatz auf den Positionswert je Kalendernacht – Szenarien, da die echten Sätze
// (Capital GET /markets/{epic} -> overnightFee) noch nicht abgefragt sind.
//   node bin/overnight.js   -> out/kandidaten/overnight/bericht.md + ergebnis.json
import fs from 'node:fs';
import { runBacktest } from '../src/core/engine.js';
import { loadEpic, windows } from '../tools/engine-check.js';

const OUT = 'out/kandidaten/overnight';
const EPICS = ['US100', 'DE40'];
const RATES = [0, 3, 5, 7, 9]; // % p. a. Finanzierung Long (Annahmen: Benchmark-Zins + Broker-Aufschlag ≈ 5–8 %)
const SMA_N = 200;
const DAY = 86400000;

export function overnightStrategy({ W, side = 'BUY', mode = 'ON', noWeekend = false, smaN = 0 }) {
  return {
    id: 'overnight', name: `Overnight ${mode}`, historyDays: 1, defaults: { filters: [] },
    createState: () => ({ closes: [] }),
    onBar(ctx) {
      const { bar: B, position: pos, state: st } = ctx;
      const w = W[B.date];
      if (!w) return [];
      const tEnd = B.t + 5 * 60000;
      const atOpen = tEnd === w.open, atClose = tEnd === w.close;
      const stop = side === 'BUY' ? B.bc * 0.5 : B.ac * 1.5; // praktisch kein SL
      if (mode === 'ID') {
        if (!pos && atOpen) return [{ type: 'ENTER', dir: side, stop }];
        if (pos && atClose) return [{ type: 'EXIT', reason: 'CLOSE' }];
        return [];
      }
      if (pos && atOpen) return [{ type: 'EXIT', reason: 'OPEN' }];
      if (!atClose) return [];
      const mid = (B.bc + B.ac) / 2;
      st.closes.push(mid);
      if (pos) return [];
      if (noWeekend) {
        // nächster Handelstag muss der Folgetag sein (sonst > 1 Nacht: Wochenende/Feiertag)
        const next = new Date(Date.parse(B.date + 'T12:00:00Z') + DAY).toISOString().slice(0, 10);
        if (!W[next]) return []; // Wochenende/Feiertag: kein Session-Fenster am Folgetag
      }
      if (smaN) {
        if (st.closes.length < smaN) return [];
        const sma = st.closes.slice(-smaN).reduce((s, x) => s + x, 0) / smaN;
        if (!(mid > sma)) return [];
      }
      return [{ type: 'ENTER', dir: side, stop }];
    },
  };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const f = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d).replace('.', ',') : '–');

/** Kennzahlen je Variante; ret in % des Einstiegskurses (1 × Hebel), Finanzierung je Kalendernacht. */
export function evaluate(trades, bars, rate = 0) {
  const rows = trades.filter((t) => t.reason !== 'END').map((t) => { // END = Datenende, kein vollständiger Trade
    const e = bars[t.entryIdx], x = bars[t.exitIdx];
    const nights = Math.max(0, Math.round((Date.parse(t.exitDate + 'T12:00:00Z') - Date.parse(t.date + 'T12:00:00Z')) / DAY));
    const midIn = (e.ao + e.bo) / 2, midOut = t.reason === 'OPEN' || t.reason === 'CLOSE' ? (x.ao + x.bo) / 2 : (x.ac + x.bc) / 2;
    const sg = t.dir === 'BUY' ? 1 : -1;
    const gross = (sg * (midOut - midIn) / midIn) * 100;
    const net = (t.pts / t.entry) * 100;
    const fin = t.dir === 'BUY' ? (rate * nights) / 365 : 0; // Short: Finanzierung ≈ 0 angenommen (eher Gutschrift abzüglich Aufschlag)
    return { date: t.date, year: t.date.slice(0, 4), nights, gross, net, fin, after: net - fin };
  });
  const a = rows.map((r) => r.after);
  let eq = 0, peak = 0, dd = 0;
  for (const x of a) { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const yrs = (Date.parse(rows.at(-1).date) - Date.parse(rows[0].date)) / (365.25 * DAY);
  const half = Math.floor(rows.length / 2);
  const byYear = {};
  for (const r of rows) (byYear[r.year] ||= []).push(r.after);
  return {
    n: rows.length, gross: mean(rows.map((r) => r.gross)), spread: mean(rows.map((r) => r.gross - r.net)), net: mean(rows.map((r) => r.net)),
    fin: mean(rows.map((r) => r.fin)), after: mean(a), t: (mean(a) / sd(a)) * Math.sqrt(a.length), win: a.filter((x) => x > 0).length / a.length,
    sum: eq, perYear: eq / yrs, maxDD: dd, worst: Math.min(...a), sharpe: (mean(a) / sd(a)) * Math.sqrt(a.length / yrs),
    h1: mean(a.slice(0, half)), h2: mean(a.slice(half)), nightsPerYear: rows.reduce((s, r) => s + r.nights, 0) / yrs,
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, { n: v.length, sum: v.reduce((s, x) => s + x, 0), mean: mean(v) }])),
    breakEven: (rows.reduce((s, r) => s + r.net, 0) / rows.reduce((s, r) => s + r.nights, 0)) * 365, // Jahressatz, bei dem netto = 0
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const VARIANTS = [
    { id: 'ON', label: 'Long über Nacht, jede Nacht', o: {} },
    { id: 'ON-WT', label: 'Long über Nacht, ohne Wochenende/Feiertagslücke', o: { noWeekend: true } },
    { id: 'ON-SMA', label: `Long über Nacht, nur Schluss > SMA${SMA_N}`, o: { smaN: SMA_N } },
    { id: 'ID', label: 'Kontrolle: Long Eröffnung → Schluss', o: { mode: 'ID' } },
    { id: 'ON-S', label: 'Kontrolle: Short über Nacht', o: { side: 'SELL' } },
  ];
  const E = { startBalance: 1e6, riskPercent: 0.1, compounding: false, maxSize: 1e9, minSize: 0, sizeDecimals: 6 };
  const res = { created: new Date().toISOString().slice(0, 10), rates: RATES, epics: {} };
  const md = ['# Kandidat Overnight-Drift', '', `Erstellt ${res.created}. Portierte Engine, M5 Bid/Ask (Spread im Ergebnis), Session-Zeiten aus \`config/sessions.yaml\`.`,
    'Renditen in % des Kurses je Trade bei Hebel 1 (Positionswert = Konto). Finanzierung = Jahressatz × Kalendernächte / 365 (Annahme, Short ohne Finanzierung).',
    '**Break-even** = Finanzierungssatz p. a., bei dem der Long-Overnight netto 0 wird.', ''];
  for (const epic of EPICS) {
    const c = loadEpic(epic), W = windows(epic, c.bars);
    const R = (res.epics[epic] = { from: c.bars[0].date, to: c.bars.at(-1).date, variants: {} });
    md.push(`## ${epic} (${R.from} → ${R.to})`, '');
    md.push('| Variante | Trades | Ø brutto % | Ø Spread % | Ø netto % | t | Treffer | Σ netto %/Jahr | Sharpe p. a. | Break-even Finanz. p. a. | max. DD % | schlechteste Nacht % |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const v of VARIANTS) {
      const out = runBacktest({ bars: c.bars, days: c.days, strategy: overnightStrategy({ W, ...v.o }), engine: E });
      const ev0 = evaluate(out.trades, c.bars, 0);
      const scen = Object.fromEntries(RATES.map((r) => [r, evaluate(out.trades, c.bars, r)]));
      R.variants[v.id] = { label: v.label, base: ev0, scenarios: scen };
      md.push(`| ${v.id} – ${v.label} | ${ev0.n} | ${f(ev0.gross, 3)} | ${f(-ev0.spread, 3)} | ${f(ev0.net, 3)} | ${f(ev0.t, 1)} | ${(100 * ev0.win).toFixed(0)} % | ${f(ev0.perYear, 1)} | ${f(ev0.sharpe, 2)} | ${v.o.side === 'SELL' || v.o.mode === 'ID' ? '–' : f(ev0.breakEven, 1) + ' %'} | ${f(ev0.maxDD, 1)} | ${f(ev0.worst, 1)} |`);
    }
    // Buy-and-Hold (Session-Schluss zu Session-Schluss, Mitte, ohne Spread; Finanzierung jede Kalendernacht wie ON)
    const closes = [];
    for (const b of c.bars) { const w = W[b.date]; if (w && b.t + 5 * 60000 === w.close) closes.push({ date: b.date, mid: (b.bc + b.ac) / 2 }); }
    const bh = {};
    for (const rate of [0, 7]) {
      const rr = closes.slice(1).map((x, k) => { const nights = Math.round((Date.parse(x.date) - Date.parse(closes[k].date)) / DAY); return (x.mid / closes[k].mid - 1) * 100 - (rate * nights) / 365; });
      let eq = 0, pk = 0, dd = 0; for (const x of rr) { eq += x; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
      const yrs = (Date.parse(closes.at(-1).date) - Date.parse(closes[0].date)) / (365.25 * DAY);
      bh[rate] = { n: rr.length, perYear: eq / yrs, sharpe: (mean(rr) / sd(rr)) * Math.sqrt(rr.length / yrs), maxDD: dd, worst: Math.min(...rr), t: (mean(rr) / sd(rr)) * Math.sqrt(rr.length) };
    }
    R.buyhold = bh;
    const on7 = R.variants.ON.scenarios[7], wt7 = R.variants['ON-WT'].scenarios[7];
    md.push('', `**Vergleich bei 7 % Finanzierung** (Σ %/Jahr · Sharpe · max. DD): Buy-and-Hold ${f(bh[7].perYear, 1)} · ${f(bh[7].sharpe, 2)} · ${f(bh[7].maxDD, 1)} %` +
      ` | ON ${f(on7.perYear, 1)} · ${f(on7.sharpe, 2)} · ${f(on7.maxDD, 1)} % | ON-WT ${f(wt7.perYear, 1)} · ${f(wt7.sharpe, 2)} · ${f(wt7.maxDD, 1)} %.` +
      ` Ohne Finanzierung: Buy-and-Hold ${f(bh[0].perYear, 1)} · ${f(bh[0].sharpe, 2)} · ${f(bh[0].maxDD, 1)} %, schlechtester Tag ${f(bh[0].worst, 1)} %.`);
    md.push('', `### Nach Finanzierung (Σ %/Jahr, Ø % je Trade, t; Hälften Ø %)`, '', '| Variante | ' + RATES.map((r) => `${r} % p. a.`).join(' | ') + ' |', '|---|' + RATES.map(() => '---').join('|') + '|');
    for (const v of VARIANTS.filter((x) => x.o.side !== 'SELL' && x.o.mode !== 'ID')) {
      const s = R.variants[v.id].scenarios;
      md.push(`| ${v.id} | ` + RATES.map((r) => `${f(s[r].perYear, 1)} / ${f(s[r].after, 3)} / t ${f(s[r].t, 1)} (H ${f(s[r].h1, 3)} · ${f(s[r].h2, 3)})`).join(' | ') + ' |');
    }
    md.push('', '### Je Jahr (Σ netto % nach 0 % / 7 % Finanzierung)', '', '| Jahr | ' + VARIANTS.map((v) => v.id).join(' | ') + ' |', '|---|' + VARIANTS.map(() => '---').join('|') + '|');
    const years = Object.keys(R.variants.ON.base.byYear);
    for (const y of years) md.push(`| ${y} | ` + VARIANTS.map((v) => { const a = R.variants[v.id].scenarios[0].byYear[y], b = R.variants[v.id].scenarios[7].byYear[y]; return a ? `${f(a.sum, 1)} / ${f(b.sum, 1)} (${a.n})` : '–'; }).join(' | ') + ' |');
    md.push('');
    console.log(epic, Object.entries(R.variants).map(([k, x]) => `${k} ${x.base.n} Tr. Ø ${x.base.net.toFixed(3)} % t ${x.base.t.toFixed(1)} BE ${x.base.breakEven.toFixed(1)} %`).join(' | '));
  }
  fs.writeFileSync(`${OUT}/ergebnis.json`, JSON.stringify(res, null, 1));
  fs.writeFileSync(`${OUT}/bericht.md`, md.join('\n'));
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
