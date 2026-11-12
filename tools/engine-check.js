#!/usr/bin/env node
// Engine-Gegenprobe (07.11.2026): Ist die portierte Engine (src/core/engine.js) unverzerrt?
//
//  A  Zufallseinstiege: zufällige Richtung, SL = k × ATR(14, M5), TP = tpR × Risiko, Zeit-Exit zum Session-Schluss.
//     Bei einem Martingal-Kurs ist der Erwartungswert in Bid-Basis 0 (Optional Stopping), also muss gelten
//     Ø R ≈ −Ø(Spread beim Einstieg / Risiko). R_bid = R + Spread/Risiko muss ≈ 0 sein (± Drift, ± SL/TP-Konflikte).
//  B  Eingepflanzte Kante: ein „Orakel“ schaut in die Zukunft (nur hier erlaubt!) und wählt mit Trefferquote q die
//     Richtung, die zuerst den TP erreicht. Die Engine muss die Kante zeigen (q = 0,55 ≈ +0,1R vor Kosten).
//  C  Unabhängige Nachrechnung jedes Trades (eigene, einfache Simulation derselben Regeln) -> Übereinstimmung.
//  D  Drift: Long Session-Eröffnung -> Schluss (Intraday) und Schluss -> nächste Eröffnung (Overnight); Engine-Punkte
//     vs. direkte Rechnung aus den Kerzen (Mitte − halber Spread je Seite) und Buy-and-Hold über den ganzen Zeitraum.
//
//   node tools/engine-check.js [--seeds 10] [--epics DE40,US100,EURUSD]   -> out/engine-check/bericht.md + ergebnis.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from '../src/data/load.js';
import { cleanBars } from '../src/data/clean.js';
import { cleanSession, sessionUtc } from '../src/core/sessions.js';
import { runBacktest } from '../src/core/engine.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const SEEDS = Number(arg('--seeds', 10));
const EPICS = arg('--epics', 'DE40,US100,EURUSD').split(',');
const OUT = 'out/engine-check';
const K_ATR = 3, P_ENTER = 0.03, ENTRY_DELAY_MIN = 15, EXIT_BEFORE_MIN = 10, LAST_ENTRY_MIN = 60;

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function loadEpic(epic) {
  const dir = `data/raw/${epic.toLowerCase()}`;
  const files = fs.readdirSync(dir).filter((f) => /MINUTE_5_.*\.csv$/.test(f)).map((f) => path.join(dir, f));
  return cleanBars(loadBars(files).bars, { session: cleanSession(epic) });
}

// Session-Fenster je Kerze (UTC); Datum = Berlin-Datum der Kerze (für DE40/US100/EURUSD identisch mit Börsendatum)
export function windows(epic, bars) {
  const W = {};
  for (const b of bars) if (!(b.date in W)) W[b.date] = sessionUtc(epic, b.date);
  return W;
}

/**
 * Teststrategie für die Engine. mode 'random' | 'oracle' (q = Trefferquote) | 'intraday' | 'overnight'.
 * Für 'oracle' braucht sie die Kerzen (Blick in die Zukunft – ausschließlich als Prüfwerkzeug).
 */
export function testStrategy({ mode, seed = 1, tpR = 1, q = 0.5, side = 0, bars, W, epic }) {
  const rnd = mulberry32(seed * 7919 + 17);
  const atrOf = (st) => st.rng.reduce((s, x) => s + x, 0) / st.rng.length;
  // erster Ausgang eines Long/Short ab Kerze j0 (Einstieg zum Open von j0): +1 TP zuerst, −1 SL zuerst/Konflikt, 0 keiner bis Zeit-Exit
  const outcome = (j0, dir, d) => {
    const L = dir === 'BUY', e = L ? bars[j0].ao : bars[j0].bo, stop = L ? e - d : e + d, tp = L ? e + tpR * d : e - tpR * d;
    const w = W[bars[j0].date];
    for (let j = j0; j < bars.length && bars[j].t < w.close - EXIT_BEFORE_MIN * 60000 + 5 * 60000; j++) {
      const B = bars[j];
      const sl = L ? B.bl <= stop : B.ah >= stop, hit = L ? B.bh >= tp : B.al <= tp;
      if (sl) return -1; if (hit) return 1;
    }
    return 0;
  };
  return {
    id: `check-${mode}`, name: `Gegenprobe ${mode}`, symbol: epic, historyDays: 1, defaults: { filters: [] },
    log: {},
    createState: () => ({ rng: [] }),
    onBar(ctx) {
      const { bar: B, state: st, position: pos } = ctx;
      st.rng.push((B.bh + B.ah) / 2 - (B.bl + B.al) / 2); if (st.rng.length > 14) st.rng.shift();
      const w = W[B.date];
      const tEnd = B.t + 5 * 60000; // Schlusszeit dieser Kerze = Ausführungszeit der Entscheidung
      if (mode === 'intraday' || mode === 'overnight') {
        // Intraday: Kauf zur Eröffnung, Verkauf zum Schluss. Overnight: Kauf zum Schluss, Verkauf zur nächsten Eröffnung.
        if (!w) return [];
        const atOpen = tEnd === w.open, atClose = tEnd === w.close;
        const far = B.bc * 0.5; // SL praktisch unerreichbar
        if (mode === 'intraday') {
          if (!pos && atOpen) return [{ type: 'ENTER', dir: 'BUY', stop: B.bc - far, features: { day: B.date } }];
          if (pos && atClose) return [{ type: 'EXIT', reason: 'CLOSE' }];
        } else {
          if (pos && atOpen) return [{ type: 'EXIT', reason: 'OPEN' }];
          if (!pos && atClose) return [{ type: 'ENTER', dir: 'BUY', stop: B.bc - far, features: { day: B.date } }];
        }
        return [];
      }
      // random / oracle
      if (pos) {
        if (!w || st.entryDate !== B.date || tEnd >= w.close - EXIT_BEFORE_MIN * 60000) return [{ type: 'EXIT', reason: 'ZEIT' }];
        return [];
      }
      if (!w || st.rng.length < 14) return [];
      if (tEnd < w.open + ENTRY_DELAY_MIN * 60000 || tEnd > w.close - LAST_ENTRY_MIN * 60000) return [];
      if (rnd() >= P_ENTER) return [];
      const d = K_ATR * atrOf(st);
      if (!(d > 0)) return [];
      let dir = side > 0 ? 'BUY' : side < 0 ? 'SELL' : rnd() < 0.5 ? 'BUY' : 'SELL';
      if (mode === 'oracle') {
        const j0 = ctx.i + 1;
        if (!bars[j0] || bars[j0].date !== B.date) return [];
        const oL = outcome(j0, 'BUY', d), oS = outcome(j0, 'SELL', d);
        const right = oL === 1 ? 'BUY' : oS === 1 ? 'SELL' : null;
        if (right) dir = rnd() < q ? right : right === 'BUY' ? 'SELL' : 'BUY';
      }
      // SL relativ zum Einstiegskurs der nächsten Kerze: refPrice = Schlusskurs der passenden Seite (Abstand ≈ d)
      const ref = dir === 'BUY' ? B.ac : B.bc;
      st.entryDate = B.date;
      const stop = dir === 'BUY' ? ref - d : ref + d;
      this.log[ctx.i + 1] = stop; // ungerundeter SL je Einstiegskerze (für die Nachrechnung)
      return [{ type: 'ENTER', dir, stop, refPrice: ref, tpR, features: { k: K_ATR } }];
    },
  };
}

/** Unabhängige Nachrechnung eines Trades nach denselben Regeln (ohne Engine-Code). Liefert Ausstiegsindex, -preis, Grund. */
export function resimulate(bars, t, exitDecided) {
  const L = t.dir === 'BUY';
  const e = L ? bars[t.entryIdx].ao : bars[t.entryIdx].bo;
  const risk = L ? e - t.stop : t.stop - e;
  const tp = t.tpR != null ? e + (L ? 1 : -1) * t.tpR * risk : t.tp;
  for (let j = t.entryIdx; j < bars.length; j++) {
    const B = bars[j];
    if (j > t.entryIdx && B.date !== bars[j - 1].date && exitDecided(j - 1)) { const P = bars[j - 1]; return { j: j - 1, px: L ? P.bc : P.ac, why: 'EOD', risk, e }; }
    if (j > t.entryIdx && exitDecided(j - 1)) return { j, px: L ? B.bo : B.ao, why: 'ZEIT', risk, e };
    if (j > t.entryIdx && (L ? B.bo <= t.stop : B.ao >= t.stop)) return { j, px: L ? B.bo : B.ao, why: 'SL_GAP', risk, e };
    const sl = L ? B.bl <= t.stop : B.ah >= t.stop, hit = tp != null && (L ? B.bh >= tp : B.al <= tp);
    if (sl) return { j, px: t.stop, why: 'SL', risk, e };
    if (hit) return { j, px: tp, why: 'TP', risk, e };
  }
  const P = bars.at(-1); return { j: bars.length - 1, px: L ? P.bc : P.ac, why: 'END', risk, e };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d).replace('.', ',') : '–');

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const res = { created: new Date().toISOString().slice(0, 10), seeds: SEEDS, k_atr: K_ATR, epics: {} };
  const md = ['# Engine-Gegenprobe', '', `Erstellt ${res.created}. Portierte Engine (\`src/core/engine.js\`), Kerzen M5 Bid/Ask, Session aus \`config/sessions.yaml\`.`,
    `Zufallseinstiege: ${SEEDS} Seeds, Einstiegswahrscheinlichkeit ${P_ENTER} je Kerze, SL ${K_ATR} × ATR14(M5), Zeit-Exit ${EXIT_BEFORE_MIN} min vor Session-Schluss.`,
    '`R_bid` = R + Spread beim Einstieg / Risiko (R ohne Spread-Kosten). Erwartung bei Zufall: R_bid ≈ 0, R ≈ −Kosten. SE = Standardfehler über Seeds.', ''];
  for (const epic of EPICS) {
    const t0 = Date.now();
    const c = loadEpic(epic), bars = c.bars, days = c.days, W = windows(epic, bars);
    const E = { startBalance: 1e6, riskPercent: 0.1, compounding: false, maxSize: 1e9, minSize: 0, sizeDecimals: 6 };
    const pd = bars[0].bc < 50 ? 5 : 1;
    const R = { from: bars[0].date, to: bars.at(-1).date, random: {}, oracle: {}, drift: {}, resim: { n: 0, ok: 0, bad: [] } };
    md.push(`## ${epic} (${R.from} → ${R.to})`, '');
    // ------------------------------------------------ A Zufall
    md.push('### A Zufallseinstiege', '', '| tpR | Konflikt-Modus | Seite | Trades | Ø R | Ø Kosten (Spread/Risiko) | Ø R_bid | SE | t | Konflikte |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const tpR of [1, 2]) for (const conflictMode of ['pessimistic', 'optimistic']) for (const side of [0, 1, -1]) {
      if (conflictMode === 'optimistic' && side !== 0) continue;
      const perSeed = [], all = [], cost = [];
      let conf = 0;
      for (let s = 1; s <= SEEDS; s++) {
        const strat = testStrategy({ mode: 'random', seed: s, tpR, side, bars, W, epic });
        const out = runBacktest({ bars, days, strategy: strat, engine: { ...E, conflictMode } });
        const rb = out.trades.map((t) => t.R + t.spreadEntry / t.riskPts);
        perSeed.push(mean(rb)); all.push(...out.trades.map((t) => t.R)); cost.push(...out.trades.map((t) => t.spreadEntry / t.riskPts));
        conf += out.trades.filter((t) => t.conflict).length;
        // C Nachrechnung (nur Basisfall, Seed 1–3)
        if (tpR === 1 && conflictMode === 'pessimistic' && side === 0 && s <= 3) {
          for (const t of out.trades) {
            // Exit-Entscheidung: Strategie-Regel nachgebaut (eigene Uhr), nicht aus der Engine übernommen
            const decided = (j) => { const B = bars[j], w = W[B.date]; return j >= t.entryIdx && (!w || B.date !== t.date || B.t + 5 * 60000 >= w.close - EXIT_BEFORE_MIN * 60000); };
            const x = resimulate(bars, { ...t, stop: strat.log[t.entryIdx], tpR }, decided);
            const rr = (t.dir === 'BUY' ? x.px - x.e : x.e - x.px) / x.risk;
            R.resim.n++;
            const same = x.j === t.exitIdx && Math.abs(rr - t.R) < 0.002;
            if (same) R.resim.ok++; else if (R.resim.bad.length < 5) R.resim.bad.push({ date: t.date, entry: t.entryHm, engine: [t.reason, t.exitIdx, t.R], nach: [x.why, x.j, Math.round(rr * 1000) / 1000] });
          }
        }
      }
      const key = `tp${tpR}|${conflictMode}|${side === 0 ? 'beide' : side > 0 ? 'long' : 'short'}`;
      const se = sd(perSeed) / Math.sqrt(perSeed.length);
      R.random[key] = { n: all.length, R: mean(all), cost: mean(cost), R_bid: mean(perSeed), se, t: mean(perSeed) / se, conflicts: conf };
      const r = R.random[key];
      md.push(`| ${tpR} | ${conflictMode === 'pessimistic' ? 'pessimistisch' : 'optimistisch'} | ${key.split('|')[2]} | ${r.n} | ${f(r.R)} | ${f(-r.cost)} | ${f(r.R_bid)} | ${f(se)} | ${f(r.t, 1)} | ${(100 * conf / r.n).toFixed(1).replace('.', ',')} % |`);
    }
    md.push('');
    // ------------------------------------------------ B Orakel
    md.push('### B Eingepflanzte Kante (Orakel, tpR 1, pessimistisch)', '', '| Trefferquote q | Trades | Ø R | Ø R_bid | erwartet R_bid ≈ 2q−1 (nur entschiedene) | Anteil entschieden |', '|---|---|---|---|---|---|');
    for (const q of [0.5, 0.55, 0.6, 1]) {
      const all = [], rb = [];
      for (let s = 1; s <= SEEDS; s++) {
        const out = runBacktest({ bars, days, strategy: testStrategy({ mode: 'oracle', seed: s, q, bars, W, epic }), engine: E });
        all.push(...out.trades.map((t) => t.R)); rb.push(...out.trades.map((t) => t.R + t.spreadEntry / t.riskPts));
      }
      const decided = rb.filter((x) => Math.abs(Math.abs(x) - 1) < 0.25).length / rb.length;
      R.oracle[q] = { n: all.length, R: mean(all), R_bid: mean(rb), decided };
      md.push(`| ${String(q).replace('.', ',')} | ${all.length} | ${f(mean(all))} | ${f(mean(rb))} | ${f((2 * q - 1) * decided)} | ${(100 * decided).toFixed(0)} % |`);
    }
    md.push('');
    // ------------------------------------------------ D Drift
    md.push('### D Drift (Long, 1 Kontrakt, Punkte)', '', '| Test | Trades | Σ Punkte Engine | Σ Punkte direkt | Abweichung | Ø Punkte je Trade | Trefferquote |', '|---|---|---|---|---|---|---|');
    for (const mode of ['intraday', 'overnight']) {
      const out = runBacktest({ bars, days, strategy: testStrategy({ mode, bars, W, epic }), engine: E });
      // Punkte je Kontrakt (t.pts) – unabhängig von der Positionsgröße
      const eng = out.trades.reduce((s, t) => s + t.pts, 0);
      const dir = out.trades.reduce((s, t) => s + ((t.reason.endsWith('_EOD') || t.reason === 'END' ? bars[t.exitIdx].bc : bars[t.exitIdx].bo) - bars[t.entryIdx].ao), 0);
      const n = out.trades.length;
      R.drift[mode] = { n, pts_engine: eng, pts_direct: dir, mean: eng / n, win: out.trades.filter((t) => t.pts > 0).length / n, reasons: [...new Set(out.trades.map((t) => t.reason))] };
      md.push(`| ${mode === 'intraday' ? 'Eröffnung → Schluss' : 'Schluss → nächste Eröffnung'} | ${n} | ${f(eng, pd)} | ${f(dir, pd)} | ${f(eng - dir, pd + 1)} | ${f(eng / n, pd + 1)} | ${(100 * R.drift[mode].win).toFixed(0)} % |`);
    }
    const first = bars.find((b) => W[b.date] && b.t >= W[b.date].open), last = bars.at(-1);
    R.drift.buyhold = { from: first.date, to: last.date, pts: last.bc - first.ao, pct: (last.bc / first.ao - 1) * 100 };
    md.push('', `Buy-and-Hold ${first.date} → ${last.date}: ${f(R.drift.buyhold.pts, pd)} Punkte (${f(R.drift.buyhold.pct, 1)} %). Intraday + Overnight ≈ Buy-and-Hold minus Spread je Trade und Wochenend-/Feiertagslücken.`, '');
    md.push(`### C Unabhängige Nachrechnung`, '', `${R.resim.ok} von ${R.resim.n} Trades identisch (Ausstiegskerze und R auf 0,002).` + (R.resim.bad.length ? ' Abweichungen: ' + JSON.stringify(R.resim.bad) : ''), '');
    res.epics[epic] = R;
    console.log(`${epic}: ${((Date.now() - t0) / 1000).toFixed(0)} s, Nachrechnung ${R.resim.ok}/${R.resim.n}`);
  }
  fs.writeFileSync(path.join(OUT, 'ergebnis.json'), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUT, 'bericht.md'), md.join('\n'));
  console.log(md.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
