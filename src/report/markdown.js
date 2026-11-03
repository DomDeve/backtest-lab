// Kurzfassung als Markdown – zum Lesen im Terminal, für Telegram oder als Eingabe für Claude (n8n).
import { round } from '../analysis/stats.js';

const fR = (x) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${round(x, 2)}R`);
const pct = (x) => (x == null ? '–' : `${round(x * 100, 1)} %`);

export function renderMarkdown({ title, result, analysis: A, live, optimize: O }) {
  const S = A.summary;
  const L = [];
  L.push(`# ${title}`, '');
  L.push(`${result.strategy.name} · ${result.period?.from} bis ${result.period?.to} · ${result.period?.days} Handelstage · Risiko ${result.engine.riskPercent} %`, '');
  L.push('| Kennzahl | Wert |', '|---|---|');
  L.push(`| Trades | ${S.n} (${S.tradesPerMonth}/Monat) |`);
  L.push(`| Ø je Trade | ${fR(S.avgR)} (90 %: ${fR(S.avgRci90?.[0])} … ${fR(S.avgRci90?.[1])}, p = ${S.pValue}) |`);
  L.push(`| Summe | ${fR(S.sumR)} · ${S.returnPct} % |`);
  L.push(`| Trefferquote / PF | ${pct(S.winRate)} / ${S.profitFactor} |`);
  L.push(`| Max. Drawdown | ${S.maxDDPct} % (${S.maxDDR}R) |`);
  L.push(`| Schlechtester Tag | ${S.worstDayPct} % |`);
  L.push(`| Verlustserie | ${S.maxLoseStreak} |`, '');
  if (live) L.push(`**Live-Abgleich:** ${pct(live.matchRate)} Übereinstimmung (${live.liveTrades} Live-Trades), Einstieg Ø ${live.avgEntryDiffPts} Pkt schlechter, Σ R live ${fR(live.sumRLive)} vs. Backtest ${fR(live.sumRBacktest)}`, '');
  if (O) L.push(`**Walk-Forward:** ${O.walkForward.n} Trades, Ø ${fR(O.walkForward.avgR)} · Rangkorrelation IS↔OOS ${O.spearmanIsOos}`, '');
  L.push('## Empfehlungen', '');
  A.recommendations.forEach((r, i) => {
    L.push(`${i + 1}. **[${r.status}] ${r.title}**  `, `   ${r.text}`);
    if (r.action) L.push(`   \`${JSON.stringify(r.action)}\``);
  });
  L.push('');
  if (A.patterns?.weaknesses?.length) {
    L.push('## Schwächen', '', '| Merkmal | Wert | n | Ø R | Σ R | Zeitabschnitte |', '|---|---|---|---|---|---|');
    for (const w of A.patterns.weaknesses) L.push(`| ${w.fieldLabel} | ${w.valueLabel} | ${w.n} | ${fR(w.avgR)} | ${fR(w.sumR)} | ${w.foldsConsistent}/${w.foldsTested}${w.consistent ? ' ✓' : ''} |`);
    L.push('');
  }
  if (A.patterns?.strengths?.length) {
    L.push('## Stärken', '', '| Merkmal | Wert | n | Ø R | Σ R | Zeitabschnitte |', '|---|---|---|---|---|---|');
    for (const w of A.patterns.strengths) L.push(`| ${w.fieldLabel} | ${w.valueLabel} | ${w.n} | ${fR(w.avgR)} | ${fR(w.sumR)} | ${w.foldsConsistent}/${w.foldsTested}${w.consistent ? ' ✓' : ''} |`);
    L.push('');
  }
  L.push('## Ausstiegs-Varianten (gleiche Einstiege)', '', '| Variante | Ø R | Δ | Δ 1. Hälfte | Δ 2. Hälfte | robust |', '|---|---|---|---|---|---|');
  for (const v of A.exits.variants) L.push(`| ${v.label} | ${fR(v.avgR)} | ${fR(v.deltaAvgR)} | ${fR(v.deltaH1)} | ${fR(v.deltaH2)} | ${v.robust ? '✓' : '✗'} |`);
  return L.join('\n') + '\n';
}
