// Marktumfeld je Tag – nur aus Daten, die zu Tagesbeginn bekannt sind (kein Blick in die Zukunft).
// Diese Merkmale hängen an jedem Trade und sind die Basis für die Muster-Analyse (Stärken/Schwächen nach Regime).

const r = (x, d = 3) => (Number.isFinite(x) ? Number(x.toPrecision(6)) && Math.round(x * 10 ** d) / 10 ** d : null);
const rp = (x) => (Number.isFinite(x) ? Number(x.toPrecision(5)) : null); // preisabhängig (Index-Punkte oder FX)

export function buildDayContext(bars, days) {
  const daily = days.map((d) => {
    let hi = -Infinity, lo = Infinity;
    for (let i = d.start; i <= d.end; i++) { hi = Math.max(hi, bars[i].bh); lo = Math.min(lo, bars[i].bl); }
    return { date: d.date, wd: d.wd, open: bars[d.start].bo, close: bars[d.end].bc, hi, lo, range: hi - lo };
  });
  const out = {};
  for (let k = 0; k < daily.length; k++) {
    const d = daily[k];
    const prev = daily.slice(Math.max(0, k - 14), k);
    const p = daily[k - 1];
    const atr = prev.length >= 5 ? prev.reduce((s, x) => s + x.range, 0) / prev.length : null;
    const c5 = daily[k - 6];
    out[d.date] = {
      ctx_month: d.date.slice(0, 7),
      ctx_atr14: rp(atr),
      ctx_prevRange: p ? rp(p.range) : null,
      ctx_prevRangeRel: p && atr ? r(p.range / atr) : null,
      ctx_gapPts: p ? rp(d.open - p.close) : null,
      ctx_gapRel: p && atr ? r((d.open - p.close) / atr) : null,
      ctx_prevDay: p ? (p.close >= p.open ? 'up' : 'down') : null,
      ctx_trend5Rel: p && c5 && atr ? r((p.close - c5.close) / atr) : null,
    };
  }
  return out;
}
