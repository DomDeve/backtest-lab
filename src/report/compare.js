// Gesamtvergleich aller Varianten (liest out/<lauf>/*/result.json)
import fs from 'node:fs';
import path from 'node:path';
import { mean, sum, round } from '../analysis/stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fR = (x) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${round(x, 2)}R`);
const pct = (x, d = 0) => (x == null ? '–' : `${round(x * 100, d)} %`);
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function verdict(s, h1, h2) {
  if (!s || !s.n || s.n < 30) return { t: 'zu wenige Trades', c: 'muted' };
  if (s.avgR > 0 && s.pValue < 0.1 && h1 > 0 && h2 > 0) return { t: 'belastbar positiv', c: 'pos' };
  if (s.avgR > 0 && h1 > 0 && h2 > 0) return { t: 'positiv, nicht belegt', c: 'warn' };
  if (s.avgR < 0 && s.pValue < 0.1) return { t: 'belegt negativ', c: 'neg' };
  return { t: 'kein Vorteil erkennbar', c: 'neg' };
}

export function loadResults(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'result.json');
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.id = j.id || d;
    j.name = j.name || j.strategy?.name || d;
    j.group = j.group || 'DE40 ORB60 / NoiseB (Forward-Test-Logik)';
    const tr = j.trades || [];
    const dates = [...new Set(tr.map((t) => t.date))].sort();
    const mid = j.period ? midDate(j.period.from, j.period.to) : dates[Math.floor(dates.length / 2)];
    j.mid = mid;
    j.h1 = tr.filter((t) => t.date < mid).map((t) => t.R);
    j.h2 = tr.filter((t) => t.date >= mid).map((t) => t.R);
    j.vd = verdict(j.summary, mean(j.h1), mean(j.h2));
    out.push(j);
  }
  return out;
}
function midDate(a, b) { const x = (Date.parse(a) + Date.parse(b)) / 2; return new Date(x).toISOString().slice(0, 10); }

function deltaVsBase(v, base) {
  if (!base) return null;
  const mid = base.mid;
  const sp = (j) => ({ a: j.trades.filter((t) => t.date < mid).map((t) => t.R), b: j.trades.filter((t) => t.date >= mid).map((t) => t.R) });
  const x = sp(v), y = sp(base);
  const d1 = mean(x.a) - mean(y.a), d2 = mean(x.b) - mean(y.b);
  const s1 = sum(x.a) - sum(y.a), s2 = sum(x.b) - sum(y.b);
  return { dAvg: round((v.summary.avgR ?? 0) - (base.summary.avgR ?? 0), 3), d1: round(d1, 3), d2: round(d2, 3), dSum: round((v.summary.sumR ?? 0) - (base.summary.sumR ?? 0), 2), s1: round(s1, 2), s2: round(s2, 2), dN: (v.summary.n || 0) - (base.summary.n || 0), robust: d1 > 0 && d2 > 0 && s1 >= 0 && s2 >= 0 };
}

export function renderComparison(dir) {
  const res = loadResults(dir);
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  const groups = [...new Set(res.map((r) => r.group))];
  let audit = null;
  for (const p of ['out/datenpruefung/datenpruefung.json', path.join(dir, '../datenpruefung/datenpruefung.json')]) if (fs.existsSync(p)) { audit = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
  const md = ['# Gesamtvergleich aller Bot-Varianten', ''];
  const sections = [];
  for (const g of groups) {
    const rows = res.filter((r) => r.group === g).sort((a, b) => (a.base ? 1 : 0) - (b.base ? 1 : 0) || a.id.localeCompare(b.id));
    const hasBase = rows.some((r) => r.base);
    const isFtmo = rows.some((r) => r.family === 'NAS_FTMO');
    md.push(`## ${g}`, '', '| Variante | Trades | /Monat | Füllq. | Treffer | Ø R | Σ R | PF | p | Max-DD | 1./2. Hälfte | Urteil |' + (hasBase ? ' Δ zur Basis (H1/H2) |' : ''), '|---|---|---|---|---|---|---|---|---|---|---|---|' + (hasBase ? '---|' : ''));
    const trs = rows.map((r) => {
      const s = r.summary || {};
      const base = r.base ? byId[r.base] : null;
      const dl = deltaVsBase(r, base);
      r.delta = dl;
      md.push(`| ${r.name} | ${s.n ?? 0} | ${s.tradesPerMonth ?? '–'} | ${r.events?.orderFillRate != null ? pct(r.events.orderFillRate) : '–'} | ${pct(s.winRate)} | ${fR(s.avgR)} | ${fR(s.sumR)} | ${s.profitFactor ?? '–'} | ${s.pValue ?? '–'} | ${s.maxDDR ?? '–'}R | ${fR(mean(r.h1))} / ${fR(mean(r.h2))} | ${r.vd.t} |` + (hasBase ? ` ${dl ? `${fR(dl.dAvg)} (${fR(dl.d1)}/${fR(dl.d2)}) ${dl.robust ? '✓' : ''}` : 'Basis'} |` : ''));
      return `<tr><td><a href="${esc(r.id)}/report.html">${esc(r.name)}</a><div class="sub">${esc(r.desc || '')}</div></td><td>${s.n ?? 0}</td><td>${s.tradesPerMonth ?? '–'}</td><td>${r.events?.orderFillRate != null ? pct(r.events.orderFillRate) : '–'}</td><td>${pct(s.winRate)}</td><td class="${cls(s.avgR)}">${fR(s.avgR)}<div class="sub">${fR(s.avgRci90?.[0])} … ${fR(s.avgRci90?.[1])}</div></td><td class="${cls(s.sumR)}">${fR(s.sumR)}</td><td>${s.profitFactor ?? '–'}</td><td>${s.pValue ?? '–'}</td><td>${s.maxDDR ?? '–'}R<div class="sub">${s.maxDDPct ?? '–'} %</div></td><td><span class="${cls(mean(r.h1))}">${fR(mean(r.h1))}</span> / <span class="${cls(mean(r.h2))}">${fR(mean(r.h2))}</span></td><td><span class="vd ${r.vd.c}">${r.vd.t}</span></td>${hasBase ? `<td>${dl ? `<span class="${cls(dl.dAvg)}">${fR(dl.dAvg)}</span><div class="sub">${fR(dl.d1)} / ${fR(dl.d2)} · Σ ${fR(dl.dSum)} · ${dl.dN >= 0 ? '+' : ''}${dl.dN} Trades</div>${dl.robust ? '<span class="vd pos">besser in beiden Hälften</span>' : ''}` : '<span class="vd">Basis</span>'}</td>` : ''}${isFtmo ? `<td>${r.events?.cancelled ?? '–'} / ${r.events?.cancelledWouldFill ?? '–'}</td><td>${r.events?.avgLots ?? '–'} / ${r.events?.maxLots ?? '–'}</td><td class="neg">${s.worstDayPct != null ? Math.round(s.worstDayPct * 1000) + ' $' : '–'}</td>` : ''}</tr>`;
    });
    md.push('');
    const head = `<tr><th>Variante</th><th>Trades</th><th>/Monat</th><th>Füllquote</th><th>Treffer</th><th>Ø R (90 %)</th><th>Σ R</th><th>PF</th><th>p</th><th>Max-DD</th><th>Ø 1./2. Hälfte</th><th>Urteil</th>${hasBase ? '<th>Δ zur Basis</th>' : ''}${isFtmo ? '<th>gelöscht / wäre gefüllt</th><th>Lots Ø/max</th><th>schlechtester Tag</th>' : ''}</tr>`;
    // Filtergründe der Basis/aller (FTMO-Auftrag will das je Variante)
    let extra = '';
    if (isFtmo) {
      extra = `<details><summary>Woran Setups scheitern – je Variante</summary>${rows.map((r) => `<h4>${esc(r.name)}</h4><p class="sub">${(r.filterReasons || []).slice(0, 10).map((x) => `${esc(x.reason)}: ${x.n}`).join(' · ')}</p>`).join('')}</details>
      <details><summary>Ergebnis je Monat – je Variante (Σ R)</summary><div class="tw"><table><tr><th>Variante</th>${[...new Set(rows.flatMap((r) => (r.stability?.months || []).map((m) => m.period)))].sort().map((m) => `<th>${m.slice(2)}</th>`).join('')}</tr>${rows.map((r) => { const ms = Object.fromEntries((r.stability?.months || []).map((m) => [m.period, m.sumR])); return `<tr><td>${esc(r.name)}</td>${[...new Set(rows.flatMap((x) => (x.stability?.months || []).map((m) => m.period)))].sort().map((m) => `<td class="${cls(ms[m])}">${ms[m] ?? ''}</td>`).join('')}</tr>`; }).join('')}</table></div></details>`;
    }
    sections.push(`<h2>${esc(g)}</h2><div class="tw"><table>${head}${trs.join('')}</table></div>${extra}`);
  }
  // Robuste Verbesserungen (Kandidaten für Kombination)
  const better = res.filter((r) => r.delta?.robust).sort((a, b) => b.delta.dAvg - a.delta.dAvg);
  const best = res.filter((r) => r.summary?.n >= 30).sort((a, b) => (b.summary.avgR - b.summary.stdR / Math.sqrt(b.summary.n)) - (a.summary.avgR - a.summary.stdR / Math.sqrt(a.summary.n))).slice(0, 8);
  md.push('## Varianten, die ihre Basis in beiden Zeithälften schlagen', '', ...better.map((r) => `- ${r.name}: ${fR(r.delta.dAvg)} je Trade (${fR(r.delta.d1)} / ${fR(r.delta.d2)}), Σ ${fR(r.delta.dSum)}`), '');
  const auditHtml = audit ? `<h2>Datenprüfung</h2><div class="tw"><table><tr><th>Instrument</th><th>Zeitraum</th><th>Handelstage</th><th>Vollständigkeit Strategie-Fenster</th><th>fehlende Werktage</th><th>Tage mit Lücken</th><th>größte Lücken</th></tr>${Object.entries(audit.instruments).map(([s, x]) => `<tr><td>${s}</td><td>${x.period.from} – ${x.period.to}</td><td>${x.tradingDays}</td><td>${x.windowCompleteness} %<div class="sub">${esc(x.window)}</div></td><td>${x.missingWeekdays.length}<div class="sub">${x.missingWeekdays.join(', ')}</div></td><td>${x.daysWithGaps}</td><td><div class="sub">${x.worstGapDays.slice(0, 4).map((g) => `${g.date}: ${g.missing} Kerzen (${esc(g.blocks)})`).join('<br>')}</div></td></tr>`).join('')}</table></div>` : '';
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gesamtvergleich Bot-Varianten</title><style>
:root{--bg:#fbfaf8;--fg:#1d1d1f;--mut:#6b6b70;--line:#e3e1dc;--card:#fff;--pos:#1f8a5b;--neg:#c2462f;--acc:#2f5fc4;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--mut:#9a9aa2;--line:#2c2c31;--card:#1c1c20;--pos:#4cc38a;--neg:#ef7a62;--acc:#7ea2ff;--warn:#e0a94a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}main{max-width:1300px;margin:0 auto;padding:28px 18px 80px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:34px 0 10px;padding-top:8px;border-top:1px solid var(--line)}h4{margin:10px 0 2px;font-size:13px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums;background:var(--card)}th,td{padding:5px 7px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}th{color:var(--mut);font-weight:600;white-space:nowrap}
.sub{font-size:11px;color:var(--mut)}.pos{color:var(--pos)}.neg{color:var(--neg)}.warn{color:var(--warn)}.muted{color:var(--mut)}a{color:var(--acc);text-decoration:none}
.vd{display:inline-block;font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid currentColor;white-space:nowrap}details{margin:8px 0}summary{cursor:pointer;color:var(--acc)}p{max-width:900px}
</style></head><body><main><h1>Gesamtvergleich aller Bot-Varianten</h1>
<p class="muted">Jede Zeile = Original-Code-Node aus n8n (bzw. benannter Patch für Testvarianten), Kerze für Kerze auf Capital.com-M5-Daten simuliert. Ergebnisse in R (1R = geplantes Risiko je Trade). „Urteil“: belastbar positiv = Ø &gt; 0, p &lt; 0,1 und beide Zeithälften positiv. Δ zur Basis: gleiche Zeiträume, Hälften-Vergleich.</p>
${auditHtml}${sections.join('\n')}
<h2>Varianten, die ihre Basis in beiden Zeithälften schlagen</h2>${better.length ? `<ul>${better.map((r) => `<li><a href="${esc(r.id)}/report.html">${esc(r.name)}</a> (${esc(r.group)}): ${fR(r.delta.dAvg)} je Trade, 1. Hälfte ${fR(r.delta.d1)}, 2. Hälfte ${fR(r.delta.d2)}, Σ ${fR(r.delta.dSum)}</li>`).join('')}</ul>` : '<p>Keine.</p>'}
<h2>Die stabilsten Varianten insgesamt</h2><p class="muted">Sortiert nach Ø R minus Standardfehler (bestraft kleine Stichproben), mindestens 30 Trades.</p><ol>${best.map((r) => `<li><a href="${esc(r.id)}/report.html">${esc(r.name)}</a> – Ø ${fR(r.summary.avgR)}, ${r.summary.n} Trades, p = ${r.summary.pValue}, ${r.vd.t}</li>`).join('')}</ol>
</main></body></html>`;
  fs.writeFileSync(path.join(dir, 'vergleich.html'), html);
  fs.writeFileSync(path.join(dir, 'vergleich.md'), md.join('\n'));
  console.log(md.join('\n'));
}
