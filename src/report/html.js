// Eigenständiger HTML-Report (keine externen Abhängigkeiten, Diagramme als Inline-SVG).
import { round } from '../analysis/stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fR = (x) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${round(x, 2)}R`);
const pct = (x, d = 1) => (x == null ? '–' : `${round(x * 100, d)} %`);
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function lineChart(values, { w = 760, h = 220, label = '', zero = true, fill = false } = {}) {
  if (!values || values.length < 2) return '<p class="muted">Zu wenige Daten</p>';
  const min = Math.min(zero ? 0 : Infinity, ...values), max = Math.max(zero ? 0 : -Infinity, ...values);
  const pad = 30, X = (i) => pad + (i / (values.length - 1)) * (w - pad - 8), Y = (v) => 8 + (1 - (v - min) / (max - min || 1)) * (h - 30);
  const pts = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const ticks = [min, (min + max) / 2, max].map((v) => `<text x="${pad - 4}" y="${Y(v) + 4}" text-anchor="end" class="tick">${round(v, 1)}</text><line x1="${pad}" x2="${w - 8}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/>`).join('');
  const area = fill ? `<polygon points="${X(0)},${Y(0)} ${pts} ${X(values.length - 1)},${Y(0)}" class="area"/>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(label)}">${ticks}${zero ? `<line x1="${pad}" x2="${w - 8}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>` : ''}${area}<polyline points="${pts}" class="line${fill ? ' dd' : ''}"/><text x="${pad}" y="${h - 6}" class="tick">Trade 1</text><text x="${w - 8}" y="${h - 6}" text-anchor="end" class="tick">Trade ${values.length - 1}</text></svg>`;
}

function barChart(rows, { valueKey = 'sumR', labelKey = 'value', w = 760, h = 200, title = '' } = {}) {
  if (!rows?.length) return '<p class="muted">Keine Daten</p>';
  const vals = rows.map((r) => r[valueKey] ?? 0);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const pad = 34, bw = (w - pad - 8) / rows.length, Y = (v) => 10 + (1 - (v - min) / (max - min || 1)) * (h - 44);
  const bars = rows.map((r, i) => {
    const v = r[valueKey] ?? 0, y0 = Y(0), y1 = Y(v);
    return `<g><rect x="${pad + i * bw + bw * 0.15}" y="${Math.min(y0, y1)}" width="${bw * 0.7}" height="${Math.max(1, Math.abs(y1 - y0))}" class="${v >= 0 ? 'bpos' : 'bneg'}"><title>${esc(r[labelKey])}: ${round(v, 2)} (${r.n ?? ''} Trades)</title></rect><text x="${pad + i * bw + bw / 2}" y="${h - 18}" text-anchor="middle" class="tick">${esc(r[labelKey])}</text><text x="${pad + i * bw + bw / 2}" y="${h - 5}" text-anchor="middle" class="tick muted">n=${r.n ?? ''}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(title)}"><line x1="${pad}" x2="${w - 8}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/><text x="${pad - 4}" y="${Y(max) + 4}" text-anchor="end" class="tick">${round(max, 1)}</text><text x="${pad - 4}" y="${Y(min) + 4}" text-anchor="end" class="tick">${round(min, 1)}</text>${bars}</svg>`;
}

function histogram(R, { w = 760, h = 180 } = {}) {
  if (!R.length) return '';
  const lo = Math.floor(Math.min(...R) * 2) / 2, hi = Math.ceil(Math.max(...R) * 2) / 2;
  const bins = [];
  for (let x = lo; x < hi; x += 0.5) bins.push({ value: `${x}`, x, n: R.filter((r) => r >= x && r < x + 0.5).length });
  if (!bins.length) return '';
  const max = Math.max(...bins.map((b) => b.n)), pad = 30, bw = (w - pad - 8) / bins.length;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="R-Verteilung">${bins.map((b, i) => `<rect x="${pad + i * bw + 1}" y="${10 + (1 - b.n / max) * (h - 40)}" width="${bw - 2}" height="${(b.n / max) * (h - 40)}" class="${b.x >= 0 ? 'bpos' : 'bneg'}"><title>${b.x} bis ${b.x + 0.5}R: ${b.n}</title></rect>${i % Math.ceil(bins.length / 12) === 0 ? `<text x="${pad + i * bw}" y="${h - 14}" class="tick">${b.x}R</text>` : ''}`).join('')}</svg>`;
}

function table(rows, cols) {
  if (!rows?.length) return '<p class="muted">Keine Einträge</p>';
  return `<div class="tw"><table><thead><tr>${cols.map((c) => `<th>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => { const v = c.f ? c.f(r) : r[c.k]; return `<td class="${c.c ? c.c(r) : ''}">${v ?? '–'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const kpi = (label, value, sub = '', c = '') => `<div class="kpi"><div class="kl">${esc(label)}</div><div class="kv ${c}">${value}</div>${sub ? `<div class="ks">${sub}</div>` : ''}</div>`;

export function renderHtml({ title, result, analysis: A, clean, live, optimize: O, generatedAt }) {
  const S = A.summary;
  const dd = (() => { let peak = -Infinity; return (S.curveR || []).map((v) => { peak = Math.max(peak, v); return v - peak; }); })();
  const recBadge = { Warnung: 'warn', empfohlen: 'ok', 'prüfen': 'check', Info: 'info' };
  const recs = A.recommendations.map((r) => `<div class="rec ${recBadge[r.status] || ''}"><div class="rh"><span class="badge">${esc(r.status)}</span><span class="cat">${esc(r.category)}</span><strong>${esc(r.title)}</strong></div><p>${esc(r.text)}</p>${r.action ? `<code>${esc(JSON.stringify(r.action))}</code>` : ''}</div>`).join('');

  const p = A.patterns;
  const segCols = [
    { h: 'Merkmal', k: 'fieldLabel' }, { h: 'Wert', k: 'valueLabel' }, { h: 'Trades', k: 'n' },
    { h: 'Ø R', f: (r) => fR(r.avgR), c: (r) => cls(r.avgR) }, { h: 'Σ R', f: (r) => fR(r.sumR), c: (r) => cls(r.sumR) },
    { h: 'Rest Ø R', f: (r) => fR(r.restAvgR) }, { h: 'Treffer', f: (r) => pct(r.winRate, 0) }, { h: 'p', k: 'p' }, { h: 'q (BH)', k: 'q' },
    { h: 'Zeitabschnitte', f: (r) => `${r.foldsConsistent}/${r.foldsTested} ${r.consistent ? '✓' : ''}` },
  ];

  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1f;--mut:#6b6b70;--line:#e3e1dc;--card:#fff;--pos:#1f8a5b;--neg:#c2462f;--acc:#2f5fc4;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--mut:#9a9aa2;--line:#2c2c31;--card:#1c1c20;--pos:#4cc38a;--neg:#ef7a62;--acc:#7ea2ff;--warn:#e0a94a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 20px 80px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:40px 0 12px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:15px;margin:22px 0 8px}
.muted{color:var(--mut)}.pos{color:var(--pos)}.neg{color:var(--neg)}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:18px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.kl{font-size:12px;color:var(--mut)}.kv{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}.ks{font-size:12px;color:var(--mut)}
.rec{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--mut);border-radius:8px;padding:10px 14px;margin:8px 0}.rec p{margin:6px 0 4px}.rec.warn{border-left-color:var(--neg)}.rec.ok{border-left-color:var(--pos)}.rec.check{border-left-color:var(--warn)}.rec.info{border-left-color:var(--acc)}
.rh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.badge{font-size:11px;text-transform:uppercase;letter-spacing:.04em;font-weight:700;color:var(--mut)}.cat{font-size:12px;color:var(--mut)}
code{font-size:12px;color:var(--mut);word-break:break-all}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{color:var(--mut);font-weight:600}
.chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}.chart .line{fill:none;stroke:var(--acc);stroke-width:1.6}.chart .line.dd{stroke:var(--neg)}.chart .area{fill:var(--neg);opacity:.15}.chart .grid{stroke:var(--line)}.chart .zero{stroke:var(--mut);stroke-dasharray:3 3}.chart .tick{font-size:11px;fill:var(--mut)}.chart .bpos{fill:var(--pos)}.chart .bneg{fill:var(--neg)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
details{margin:8px 0}summary{cursor:pointer;color:var(--acc)}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="muted">${esc(result.strategy.name)} · ${result.period ? `${result.period.from} bis ${result.period.to} (${result.period.days} Handelstage)` : ''} · Risiko ${result.engine.riskPercent} % je Trade · erstellt ${esc(generatedAt)}</div>

<div class="kpis">
${kpi('Trades', S.n ?? 0, `${S.tradesPerMonth ?? '–'} pro Monat`)}
${kpi('Ø je Trade', fR(S.avgR), `90 %: ${fR(S.avgRci90?.[0])} … ${fR(S.avgRci90?.[1])}`, cls(S.avgR))}
${kpi('Summe', fR(S.sumR), `${S.returnPct ?? '–'} % Rendite`, cls(S.sumR))}
${kpi('Trefferquote', pct(S.winRate), `Payoff ${S.payoff ?? '–'}`)}
${kpi('Profit-Faktor', S.profitFactor ?? '–', `p = ${S.pValue ?? '–'}`)}
${kpi('Max. Drawdown', `${S.maxDDPct ?? '–'} %`, `${S.maxDDR ?? '–'}R · schlechtester Tag ${S.worstDayPct ?? '–'} %`, 'neg')}
${kpi('Verlustserie', S.maxLoseStreak ?? '–', `Gewinnserie ${S.maxWinStreak ?? '–'}`)}
${kpi('Haltedauer Ø', `${S.avgMinutesHeld ?? '–'} min`, `Ausstiege: ${Object.entries(S.exits || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`)}
</div>

<h2>Empfehlungen</h2>
<p class="muted">Sortiert nach Wichtigkeit. „empfohlen“ = als echter Backtest nachgerechnet und in beiden Zeithälften besser. „prüfen“ = nur teilweise bestätigt. Nichts davon automatisch live übernehmen – erst Forward-Test.</p>
${recs || '<p class="muted">Keine Empfehlungen.</p>'}

<h2>Verlauf</h2>
<h3>Kumuliertes Ergebnis in R</h3>${lineChart(S.curveR, { label: 'Equity in R' })}
<h3>Drawdown in R</h3>${lineChart(dd, { label: 'Drawdown', fill: true })}
<div class="cols"><div><h3>Ergebnis je Quartal (Σ R)</h3>${barChart(A.stability.quarters.map((q) => ({ ...q, value: q.period })), { valueKey: 'sumR' })}</div>
<div><h3>Verteilung der Trades (R)</h3>${histogram(result.trades.map((t) => t.R))}</div></div>
<p class="muted">Positive Quartale: ${A.stability.positiveQuartersPct ?? '–'} % · positive Monate: ${A.stability.positiveMonthsPct ?? '–'} % · 1. Hälfte Ø ${fR(A.stability.firstHalfAvgR)}, 2. Hälfte Ø ${fR(A.stability.secondHalfAvgR)}</p>

<h2>Wo die Strategie stark und schwach ist</h2>
<div class="cols"><div><h3>Je Wochentag (Σ R)</h3>${barChart(A.dims.wd)}</div><div><h3>Je Signal-Stunde (Σ R)</h3>${barChart(A.dims.hour)}</div></div>
<h3>Long vs. Short</h3>${table([{ s: 'Long', ...A.longShort.long }, { s: 'Short', ...A.longShort.short }], [{ h: 'Seite', k: 's' }, { h: 'Trades', k: 'n' }, { h: 'Ø R', f: (r) => fR(r.avgR), c: (r) => cls(r.avgR) }, { h: 'Σ R', f: (r) => fR(r.sumR), c: (r) => cls(r.sumR) }, { h: 'Treffer', f: (r) => pct(r.winRate, 0) }, { h: 'PF', k: 'profitFactor' }, { h: 'p', k: 'pValue' }])}
${p.tooFew ? '<p class="muted">Zu wenige Trades für die Muster-Analyse (mind. 20).</p>' : `
<h3>Schwächen (Segmente deutlich schlechter als der Rest)</h3>${table(p.weaknesses, segCols)}
<h3>Stärken</h3>${table(p.strengths, segCols)}
<p class="muted">${p.tested} Segmente getestet (min. ${p.minN} Trades je Segment). Bei so vielen Tests sind einzelne Zufallstreffer normal – maßgeblich ist „Zeitabschnitte ✓“ (gleiche Richtung in allen drei Zeitdritteln) und die Nachrechnung unten.</p>
<h3>Filter-Kandidaten, echt nachgerechnet</h3>${table(A.filterTests, [{ h: 'Segment', k: 'segment' }, { h: 'Seg. Trades', k: 'segN' }, { h: 'Seg. Ø R', f: (r) => fR(r.segAvgR) }, { h: 'Neu Trades', k: 'newN' }, { h: 'Neu Ø R', f: (r) => fR(r.newAvgR), c: (r) => cls(r.newAvgR) }, { h: 'Neu Σ R', f: (r) => fR(r.newSumR) }, { h: 'Δ Ø 1. Hälfte', f: (r) => fR(r.deltaAvgR_H1), c: (r) => cls(r.deltaAvgR_H1) }, { h: 'Δ Ø 2. Hälfte', f: (r) => fR(r.deltaAvgR_H2), c: (r) => cls(r.deltaAvgR_H2) }, { h: 'robust', f: (r) => (r.robust ? '✓' : '✗') }])}
<details><summary>Alle getesteten Segmente (${p.segments.length})</summary>${table([...p.segments].sort((a, b) => a.field.localeCompare(b.field)), segCols)}</details>`}

<h2>Ausstiege</h2>
<p class="muted">Gleiche Einstiege, anderer Ausstieg. Varianten können den Trade nur früher beenden – daher ohne Annahmen über den späteren Kursverlauf. „robust“ = besser in beiden Zeithälften.</p>
${table(A.exits.variants, [{ h: 'Variante', k: 'label' }, { h: 'Ø R', f: (r) => fR(r.avgR), c: (r) => cls(r.avgR) }, { h: 'Σ R', f: (r) => fR(r.sumR) }, { h: 'Treffer', f: (r) => pct(r.winRate, 0) }, { h: 'Δ Ø R', f: (r) => fR(r.deltaAvgR), c: (r) => cls(r.deltaAvgR) }, { h: 'Δ 1. Hälfte', f: (r) => fR(r.deltaH1), c: (r) => cls(r.deltaH1) }, { h: 'Δ 2. Hälfte', f: (r) => fR(r.deltaH2), c: (r) => cls(r.deltaH2) }, { h: 'robust', f: (r) => (r.robust ? '✓' : '✗') }])}
${A.exits.mfe ? `<p>Ø bester Zwischenstand (MFE) ${fR(A.exits.mfe.avgMfeR)}, Ø schlechtester (MAE) ${fR(-A.exits.mfe.avgMaeR)}. Verlierer, die vorher ≥ 1R vorne lagen: ${pct(A.exits.mfe.losersReached1R)} (≥ 0,5R: ${pct(A.exits.mfe.losersReached05R)}). Gewinner, die zwischendurch > 0,5R hinten lagen: ${pct(A.exits.mfe.winnersMaxAdverseOver05R)}.</p>` : ''}

<h2>Risiko & FTMO</h2>
${A.risk?.suggestion ? table(A.risk.suggestion.table, [{ h: 'Risiko je Trade', f: (r) => `${r.riskPct} %` }, { h: 'Max-DD typisch', f: (r) => `${r.p50} %` }, { h: 'Max-DD 95 %', f: (r) => `${r.p95} %` }, { h: 'Max-DD 99 %', f: (r) => `${r.p99} %` }, { h: 'P(DD ≥ 10 %)', f: (r) => pct(r.probOverLimit), c: (r) => (r.probOverLimit > 0.05 ? 'neg' : '') }]) : '<p class="muted">Zu wenige Trades.</p>'}
${A.challenge.length ? `<h3>Challenge-Simulation (Ziel +10 %, Max-Verlust 10 %, Tagesverlust 5 %, 60 Handelstage)</h3>${table(A.challenge, [{ h: 'Risiko', f: (r) => `${r.riskPct} %` }, { h: 'bestanden', f: (r) => pct(r.passProb), c: () => 'pos' }, { h: 'gescheitert', f: (r) => pct(r.failProb), c: () => 'neg' }, { h: 'Zeit abgelaufen', f: (r) => pct(r.timeoutProb) }, { h: 'Tage bis Ziel (Median)', k: 'medianDaysToPass' }])}<p class="muted">Trades werden zufällig aus der Backtest-Historie gezogen. Echte Ergebnisse sind meist schlechter als der Backtest – die Werte sind eine Obergrenze.</p>` : ''}

${live ? `<h2>Live-Abgleich</h2>
<div class="kpis">${kpi('Übereinstimmung', pct(live.matchRate), `${live.liveTrades} live · ${live.btTrades} Backtest`, live.matchRate >= 0.9 ? 'pos' : 'neg')}${kpi('Einstieg Ø Diff', `${live.avgEntryDiffPts ?? '–'} Pkt`, 'positiv = live schlechter')}${kpi('Ausstieg Ø Diff', `${live.avgExitDiffPts ?? '–'} Pkt`, 'positiv = live schlechter')}${kpi('Σ R live / BT', `${fR(live.sumRLive)} / ${fR(live.sumRBacktest)}`)}</div>
${table(live.rows, [{ h: 'Datum', k: 'date' }, { h: 'Ergebnis', k: 'kind', c: (r) => (r.kind === 'MATCH' ? 'pos' : r.kind === 'BEIDE_KEIN_TRADE' ? '' : 'neg') }, { h: 'Richtung L/BT', f: (r) => `${r.live?.dir ?? '–'} / ${r.bt?.dir ?? '–'}` }, { h: 'Einstieg L/BT', f: (r) => `${r.live?.entryHm ?? '–'} / ${r.bt?.entryHm ?? '–'}` }, { h: 'Exit L/BT', f: (r) => `${r.live?.reason ?? '–'} ${r.live?.exitHm ?? ''} / ${r.bt?.reason ?? '–'} ${r.bt?.exitHm ?? ''}` }, { h: 'R L/BT', f: (r) => `${fR(r.live?.R)} / ${fR(r.bt?.R)}` }, { h: 'Δ Einstieg', k: 'entryDiffPts' }])}` : ''}

${O ? `<h2>Parameter-Robustheit</h2>
<p>Bestes In-Sample (bis ${esc(O.cut)}): <code>${esc(JSON.stringify(O.best?.params))}</code> → IS Ø ${fR(O.best?.isAvgR)} (${O.best?.nIS} Trades), Out-of-Sample Ø ${fR(O.best?.oosAvgR)} (${O.best?.nOOS} Trades).</p>
<p>Rangkorrelation IS↔OOS über ${O.combos} Kombinationen: <strong>${O.spearmanIsOos ?? '–'}</strong> (nahe 0 oder negativ = Parameterwahl ist Zufall). Plateau: Nachbarn Ø ${fR(O.plateau?.neighborsAvgR)} vs. Optimum ${fR(O.plateau?.bestAvgR)}.</p>
<p>Walk-Forward (${O.walkForward.folds.length} Abschnitte, jeweils auf Vergangenheit gewählt): <strong>${O.walkForward.n} Trades, Ø ${fR(O.walkForward.avgR)}, Σ ${fR(O.walkForward.sumR)}</strong> – realistischste Schätzung.</p>
${table(O.walkForward.folds, [{ h: 'Abschnitt', k: 'fold' }, { h: 'Training bis', k: 'trainTo' }, { h: 'Test bis', k: 'testTo' }, { h: 'gewählt', f: (r) => `<code>${esc(JSON.stringify(r.params))}</code>` }, { h: 'Test-Trades', k: 'nTest' }, { h: 'Test Ø R', f: (r) => fR(r.testAvgR), c: (r) => cls(r.testAvgR) }])}
<details><summary>Alle Kombinationen</summary>${table(O.table, [{ h: 'Parameter', f: (r) => `<code>${esc(JSON.stringify(r.params))}</code>` }, { h: 'IS n', k: 'nIS' }, { h: 'IS Ø R', f: (r) => fR(r.isAvgR) }, { h: 'OOS n', k: 'nOOS' }, { h: 'OOS Ø R', f: (r) => fR(r.oosAvgR), c: (r) => cls(r.oosAvgR) }])}</details>` : ''}

<h2>Daten & Annahmen</h2>
${clean ? `<pre style="white-space:pre-wrap;font-size:12px" class="muted">${esc(clean.text)}</pre>` : ''}
<p class="muted">Ausführung: Signal auf abgeschlossener M5-Kerze, Ausführung zum Open der nächsten Kerze (Kauf Ask, Verkauf Bid). Slippage Einstieg ${result.engine.entrySlippagePts} Pkt, Ausstieg ${result.engine.exitSlippagePts} Pkt, Stop ${result.engine.stopSlippagePts} Pkt, Kommission ${result.engine.commissionPerTrade} €. SL+TP in einer Kerze: ${result.engine.conflictMode === 'pessimistic' ? 'SL zuerst' : 'TP zuerst'}. Keine Finanzierungskosten (Intraday).</p>
<p class="muted">Parameter: <code>${esc(JSON.stringify(result.params))}</code></p>
<details><summary>Alle Trades (${result.trades.length})</summary>${table(result.trades, [{ h: 'Datum', k: 'date' }, { h: 'Richtung', k: 'dir' }, { h: 'Signal', k: 'signalHm' }, { h: 'Einstieg', f: (r) => `${r.entryHm} @ ${r.entry}` }, { h: 'SL', k: 'stop' }, { h: 'Ausstieg', f: (r) => `${r.exitHm} @ ${r.exit}` }, { h: 'Grund', k: 'reason' }, { h: 'R', f: (r) => fR(r.R), c: (r) => cls(r.R) }, { h: 'MFE', f: (r) => fR(r.mfeR) }, { h: 'MAE', f: (r) => fR(-r.maeR) }, { h: 'EUR', k: 'pnl' }])}</details>
</main></body></html>`;
}
