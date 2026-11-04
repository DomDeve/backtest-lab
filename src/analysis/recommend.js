// Analyse-Pipeline + Empfehlungen.
// Jede Empfehlung wird nicht nur aus dem Muster abgeleitet, sondern als ECHTER Backtest mit Filter
// erneut gerechnet und in beiden Zeithälften geprüft. Nur was in beiden Hälften hilft, heißt "empfohlen".

import { runBacktest } from '../core/engine.js';
import { summarize } from './metrics.js';
import { analyzePatterns, dimensionTable } from './patterns.js';
import { analyzeExits } from './exits.js';
import { stability, monteCarloDD, suggestRisk, challengeSim } from './robustness.js';
import { mean, sum, round } from './stats.js';

const pct = (x) => (x == null ? '–' : `${round(x * 100, 1)} %`);
const fR = (x) => (x == null ? '–' : `${x > 0 ? '+' : ''}${round(x, 2)}R`);

function halves(trades, midDate) {
  const a = trades.filter((t) => t.date < midDate).map((t) => t.R);
  const b = trades.filter((t) => t.date >= midDate).map((t) => t.R);
  return { a, b };
}

function describeFilter(w) {
  if (w.kind === 'cat') return `keine Trades bei ${w.fieldLabel} = ${w.valueLabel}`;
  return `keine Trades bei ${w.fieldLabel} im Bereich ${w.valueLabel}`;
}

export function analyzeRun({ result, bars, days, strategy, live = null, cleanReport = null, opts = {} }) {
  const trades = result.trades;
  const E = result.engine;
  const S = summarize(trades, { startBalance: E.startBalance });
  const tradingDays = days.filter((d) => (!result.period || (d.date >= result.period.from && d.date <= result.period.to))).length;
  const out = {
    summary: S,
    longShort: { long: summarize(trades.filter((t) => t.dir === 'BUY'), { startBalance: E.startBalance }), short: summarize(trades.filter((t) => t.dir === 'SELL'), { startBalance: E.startBalance }) },
    stability: stability(trades),
    dims: { wd: dimensionTable(trades, 'wd'), hour: dimensionTable(trades, 'hour'), dir: dimensionTable(trades, 'dir') },
    patterns: analyzePatterns(trades),
    exits: analyzeExits(trades, bars, opts.exitVariants),
    risk: null, challenge: [], recommendations: [], filterTests: [],
  };
  const R = trades.map((t) => t.R);
  if (R.length >= 10) {
    out.risk = { current: monteCarloDD(R, E.riskPercent), suggestion: suggestRisk(R) };
    out.challenge = [E.riskPercent, 0.5, 0.75, 1, 1.5].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
      .map((r) => challengeSim(trades, r, { tradingDays })).filter(Boolean);
  }

  const recs = [];
  const add = (r) => recs.push(r);

  // ---------- 1. Vertrauen in die Daten / den Backtest ----------
  if (live) {
    const mr = live.matchRate;
    if (mr != null && mr < 0.9) add({ prio: 1, category: 'Vertrauen', status: 'Warnung', title: `Backtest weicht von live ab (Übereinstimmung ${pct(mr)})`, text: 'Bevor Parameter optimiert werden, müssen die Abweichungen geklärt werden (siehe Abschnitt Live-Abgleich). Sonst optimierst du eine Strategie, die nicht der live laufenden entspricht.', evidence: { matchRate: mr } });
    else if (mr != null) add({ prio: 3, category: 'Vertrauen', status: 'Info', title: `Backtest bildet live ab (Übereinstimmung ${pct(mr)}, ${live.liveTrades} Live-Trades)`, text: `Einstiegs-Abweichung im Schnitt ${live.avgEntryDiffPts ?? '–'} Pkt (positiv = live schlechter), R-Differenz ${live.avgRDiff ?? '–'}. Kleine Stichprobe – mit jedem Live-Tag aussagekräftiger.`, evidence: { matchRate: mr } });
    if (live.avgEntryDiffPts != null && Math.abs(live.avgEntryDiffPts) > 1 && E.entrySlippagePts === 0) add({ prio: 2, category: 'Vertrauen', status: 'prüfen', title: `Slippage im Backtest ansetzen (live Ø ${live.avgEntryDiffPts} Pkt)`, text: `Setze engine.entrySlippagePts auf ca. ${Math.max(0, round(live.avgEntryDiffPts, 1))}, damit der Backtest nicht zu optimistisch ist.`, action: { engine: { entrySlippagePts: Math.max(0, round(live.avgEntryDiffPts, 1)) } } });
  }
  if (S.n < 30) add({ prio: 1, category: 'Statistik', status: 'Warnung', title: `Nur ${S.n} Trades – zu wenig für belastbare Aussagen`, text: 'Mehr Historie laden (Ziel: ≥ 100 Trades). Muster-Empfehlungen unten sind bei so wenigen Trades kaum mehr als Hinweise.' });
  if (S.n >= 30 && (S.pValue == null || S.pValue > 0.1)) add({ prio: 1, category: 'Statistik', status: 'Warnung', title: `Vorteil statistisch nicht belegt (Ø ${fR(S.avgR)} je Trade, p = ${S.pValue})`, text: `Das 90-%-Intervall für den Ø-Ertrag je Trade reicht von ${fR(S.avgRci90[0])} bis ${fR(S.avgRci90[1])} und schließt 0 ein. Erst Edge nachweisen, dann feintunen – Feintuning auf Rauschen erzeugt nur Overfitting.`, evidence: { pValue: S.pValue, ci: S.avgRci90 } });
  else if (S.n >= 30) add({ prio: 3, category: 'Statistik', status: 'Info', title: `Positiver Vorteil statistisch belegt (Ø ${fR(S.avgR)}, p = ${S.pValue})`, text: `90-%-Intervall ${fR(S.avgRci90[0])} bis ${fR(S.avgRci90[1])}. Profit-Faktor ${S.profitFactor}, Trefferquote ${pct(S.winRate)}.` });
  if (S.n && S.conflicts / S.n > 0.05) add({ prio: 2, category: 'Daten', status: 'prüfen', title: `${S.conflicts} Trades mit SL und TP in derselben Kerze`, text: 'M5-Daten können nicht klären, was zuerst kam (pessimistisch als SL gewertet). Für diese Tage M1-Daten laden oder TP weiter weg legen.' });
  if (cleanReport?.spreadAssumed) add({ prio: 2, category: 'Daten', status: 'prüfen', title: 'Spread teilweise nur angenommen', text: `${cleanReport.spreadAssumed} Kerzen ohne echte Bid/Ask-Daten. Capital.com-Rohdaten (Bid+Ask) verwenden, damit Kosten realistisch sind.` });
  if (cleanReport && cleanReport.incompleteDays.length > cleanReport.dayCount * 0.05) add({ prio: 2, category: 'Daten', status: 'prüfen', title: `${cleanReport.incompleteDays.length} Tage mit Lücken in der Kernzeit`, text: 'Lücken können Signale verschieben oder verhindern. Fehlende Monate nachladen oder engine.skipIncompleteDays = true testen.' });

  // ---------- 2. Schwächen -> Filter, echt nachgerechnet ----------
  const dates = days.filter((d) => !result.period || (d.date >= result.period.from && d.date <= result.period.to)).map((d) => d.date);
  const mid = dates[Math.floor(dates.length / 2)];
  const base = halves(trades, mid);
  const cands = (out.patterns.weaknesses || []).slice(0, opts.maxFilterTests ?? 6);
  const seenSets = new Map(); // gleiche Trade-Menge = gleichbedeutende Schwäche (z. B. SL-Abstand und Lots)
  for (const w of cands) {
    const setKey = trades.filter((t) => { const f = { dir: t.dir, wd: t.wd, hour: Number((t.signalHm || t.entryHm).slice(0, 2)), spreadEntry: t.spreadEntry, ...t.features }; const v = f[w.field]; return v !== undefined && v !== null && (w.kind === 'cat' ? String(v) === String(w.filter.values[0]) : v >= (w.filter.min ?? -Infinity) && v <= (w.filter.max ?? Infinity)); }).map((t) => t.id).join(',');
    if (seenSets.has(setKey)) { const prev = seenSets.get(setKey); prev.title += ` (gleichbedeutend: ${w.fieldLabel} ${w.valueLabel})`; continue; }
    const filters = [...(result.params.filters || []), w.filter];
    const res2 = opts.rerun ? opts.rerun(filters) : runBacktest({ bars, days, strategy, params: { ...result.params, filters }, engine: E, range: result.period ? { from: result.period.from, to: result.period.to } : {} });
    const h = halves(res2.trades, mid);
    const dA = mean(h.a) - mean(base.a), dB = mean(h.b) - mean(base.b);
    const sA = sum(h.a) - sum(base.a), sB = sum(h.b) - sum(base.b);
    const robust = dA > 0 && dB > 0 && sA >= 0 && sB >= 0;
    const test = {
      segment: `${w.fieldLabel}: ${w.valueLabel}`, filter: w.filter, segN: w.n, segAvgR: w.avgR, segSumR: w.sumR, q: w.q, foldsConsistent: `${w.foldsConsistent}/${w.foldsTested}`,
      newN: res2.trades.length, newAvgR: round(mean(res2.trades.map((t) => t.R)), 3), newSumR: round(sum(res2.trades.map((t) => t.R)), 2),
      deltaAvgR_H1: round(dA, 3), deltaAvgR_H2: round(dB, 3), deltaSumR_H1: round(sA, 2), deltaSumR_H2: round(sB, 2), robust,
    };
    out.filterTests.push(test);
    const status = robust && w.consistent ? 'empfohlen' : robust ? 'prüfen' : 'verworfen';
    if (status === 'verworfen') { seenSets.set(setKey, { title: '' }); continue; }
    const rec = {
      prio: status === 'empfohlen' ? 1 : 2, category: 'Filter', status,
      title: `Schwäche: ${w.fieldLabel} = ${w.valueLabel} (Ø ${fR(w.avgR)} bei ${w.n} Trades)`,
      text: `Vorschlag: ${describeFilter(w)}. Nachgerechnet mit Filter: ${test.newN} Trades, Ø ${fR(test.newAvgR)}, Summe ${fR(test.newSumR)} (vorher Ø ${fR(S.avgR)}, Summe ${fR(S.sumR)}). Verbesserung in 1. Hälfte ${fR(test.deltaAvgR_H1)}/Trade, 2. Hälfte ${fR(test.deltaAvgR_H2)}/Trade. Konsistent in ${test.foldsConsistent} Zeitabschnitten${w.q != null ? `, Mehrfachtest-korrigiert q = ${w.q}` : ''}.${status === 'prüfen' ? ' Nicht in allen Zeitabschnitten gleich – erst mit Forward-Test bestätigen.' : ''}`,
      evidence: test, action: { params: { filters: [w.filter] } },
    };
    seenSets.set(setKey, rec);
    add(rec);
  }

  // ---------- 3. Stärken (nicht anfassen, verstehen) ----------
  for (const s of (out.patterns.strengths || []).filter((x) => x.consistent).slice(0, 3)) {
    add({ prio: 3, category: 'Stärke', status: 'Info', title: `Stärke: ${s.fieldLabel} = ${s.valueLabel} (Ø ${fR(s.avgR)} bei ${s.n} Trades)`, text: `Hier verdient die Strategie ihr Geld (Rest Ø ${fR(s.restAvgR)}), konsistent in ${s.foldsConsistent}/${s.foldsTested} Zeitabschnitten. Änderungen an der Logik daran messen, dass dieses Segment nicht schlechter wird.`, evidence: s });
  }

  // ---------- 4. Ausstiege ----------
  const ex = out.exits;
  for (const v of ex.variants.filter((x) => x.robust && x.deltaAvgR >= 0.03).slice(0, 3)) {
    add({ prio: v.deltaAvgR >= 0.08 ? 1 : 2, category: 'Ausstieg', status: 'empfohlen', title: `${v.label}: ${fR(v.deltaAvgR)} je Trade`, text: `Mit denselben Einstiegen: Ø ${fR(v.avgR)} statt ${fR(ex.baseAvgR)} (Trefferquote ${pct(v.winRate)}). Besser in beiden Zeithälften (${fR(v.deltaH1)} / ${fR(v.deltaH2)}). Als Parameter-Variante im Backtest gegenprüfen, dann im Forward-Test als Schatten-Zwilling mitlaufen lassen.`, evidence: v, action: { exitVariant: v.spec } });
  }
  const worse = ex.variants.filter((x) => x.deltaH1 < 0 && x.deltaH2 < 0);
  if (worse.length && ex.variants.length) add({ prio: 3, category: 'Ausstieg', status: 'Info', title: 'Diese Ausstiegs-Ideen schaden in beiden Zeithälften', text: worse.map((x) => `${x.label} (${fR(x.deltaAvgR)})`).join(', ') + '. Nicht einbauen.' });
  if (ex.mfe) {
    const m = ex.mfe;
    if (m.losersReached1R != null && m.losersReached1R >= 0.25) add({ prio: 2, category: 'Ausstieg', status: 'prüfen', title: `${pct(m.losersReached1R)} der Verlierer waren zwischenzeitlich ≥ 1R im Plus`, text: 'Gewinne werden zurückgegeben. Einstand-Stop oder Teilgewinnmitnahme prüfen – die Tabelle der Ausstiegs-Varianten zeigt, ob es netto hilft.' });
    if (m.avgWinnerCapture != null && m.avgWinnerCapture < 0.5) add({ prio: 3, category: 'Ausstieg', status: 'Info', title: `Gewinner behalten nur ${pct(m.avgWinnerCapture)} ihres besten Zwischenstands`, text: 'Hinweis auf späten Ausstieg. Zeit- oder Trailing-Exit testen.' });
  }

  // ---------- 5. Risiko / FTMO ----------
  if (out.risk?.current) {
    const c = out.risk.current, sg = out.risk.suggestion;
    add({ prio: c.probOverLimit > 0.05 ? 1 : 3, category: 'Risiko', status: c.probOverLimit > 0.05 ? 'Warnung' : 'Info', title: `Max. Drawdown bei ${E.riskPercent} % Risiko: typisch ${c.p50} %, schlimmstenfalls (95 %) ${c.p95} %`, text: `Monte-Carlo über ${R.length} Trades. Wahrscheinlichkeit, ${c.ddLimitPct} % Drawdown (FTMO-Max-Verlust) zu reißen: ${pct(c.probOverLimit)}.${sg?.suggested ? ` Höchstes Risiko mit ≤ 5 % Wahrscheinlichkeit dafür: ${sg.suggested} % je Trade.` : ''}`, evidence: { current: c, table: sg?.table } });
  }
  if (out.challenge.length) {
    const best = [...out.challenge].sort((a, b) => b.passProb - a.passProb)[0];
    add({ prio: 2, category: 'Risiko', status: 'Info', title: `FTMO-Challenge-Simulation: beste Bestehenschance ${pct(best.passProb)} bei ${best.riskPct} % Risiko`, text: out.challenge.map((x) => `${x.riskPct} %: bestanden ${pct(x.passProb)}, gescheitert ${pct(x.failProb)}, Zeit abgelaufen ${pct(x.timeoutProb)}`).join(' · ') + '. Basis: Backtest-Verteilung, daher eher optimistisch.' });
  }

  // ---------- 6. Stabilität ----------
  const st = out.stability;
  if (st.positiveQuartersPct != null && st.quarters.length >= 4 && st.positiveQuartersPct < 60) add({ prio: 2, category: 'Stabilität', status: 'Warnung', title: `Nur ${st.positiveQuartersPct} % der Quartale positiv`, text: 'Ergebnis hängt an wenigen guten Phasen. Prüfen, welches Marktumfeld diese Phasen hatten (Muster-Tabelle: ATR, Trend).' });
  if (st.firstHalfAvgR > 0 && st.secondHalfAvgR < st.firstHalfAvgR * 0.5) add({ prio: 1, category: 'Stabilität', status: 'Warnung', title: `Vorteil lässt nach: 1. Hälfte ${fR(st.firstHalfAvgR)}, 2. Hälfte ${fR(st.secondHalfAvgR)} je Trade`, text: 'Möglicher Regimewechsel oder überangepasste Parameter. Neuere Daten stärker gewichten und Walk-Forward (bt optimize) laufen lassen.' });

  const order = { Warnung: 0, empfohlen: 1, prüfen: 2, Info: 3 };
  out.recommendations = recs.sort((a, b) => a.prio - b.prio || order[a.status] - order[b.status]);
  return out;
}
