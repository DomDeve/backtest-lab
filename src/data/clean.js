// Datenbereinigung + Qualitätsbericht.
// Grundsatz: Kaputtes wird entfernt (nicht reparierbar), Verdächtiges wird markiert und im Bericht gezeigt,
// aber nur auf ausdrücklichen Wunsch verändert. So bleibt nachvollziehbar, was der Backtest wirklich gesehen hat.

import { local, hmList } from '../core/time.js';

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (x) => Math.round(x * 100) / 100;

export const CLEAN_DEFAULTS = {
  tz: 'Europe/Berlin',
  barMinutes: 5,
  session: { from: '09:00', to: '17:30' }, // Kernzeit, für die Vollständigkeit geprüft wird
  dropWeekends: true,
  maxMissingInSession: 3, // mehr fehlende Kerzen in der Kernzeit -> Tag "unvollständig"
  minBarsPerDay: 20, // weniger -> Tag wird verworfen (Feiertag/Rumpftag)
  spreadOutlierFactor: 4, // Spread > Faktor x Median der Stunde -> markiert
  spreadOutlierMinAbs: 3, // ... und mindestens so viele Punkte
  repairSpreadOutliers: false, // true: Ask auf Bid + Median-Spread setzen
  spikeFactor: 12, // Kerzen-Range > Faktor x Median der letzten 100 -> markiert
  staleRun: 6, // so viele identische Kerzen in Folge -> "eingefrorener Feed" markiert
};

export function cleanBars(raw, options = {}) {
  const o = { ...CLEAN_DEFAULTS, ...options, session: { ...CLEAN_DEFAULTS.session, ...(options.session || {}) } };
  const step = o.barMinutes * 60000;
  const rep = {
    input: raw.length, dropped: { invalid: 0, askBelowBid: 0, ohlcBroken: 0, offGrid: 0, weekend: 0, duplicate: 0, shortDay: 0 },
    duplicateConflicts: 0, flagged: { spreadOutlier: 0, spike: 0, stale: 0 }, repaired: { spread: 0 },
    spreadAssumed: 0, examples: { spreadOutlier: [], spike: [], stale: [] }, days: {},
  };
  const EPS = 1e-6;
  const keys = ['bo', 'bh', 'bl', 'bc', 'ao', 'ah', 'al', 'ac'];

  // 1) Einzelkerzen prüfen
  const byT = new Map();
  for (const b of raw) {
    if (!Number.isFinite(b.t) || keys.some((k) => !Number.isFinite(b[k]))) { rep.dropped.invalid++; continue; }
    if (b.ao < b.bo - EPS || b.ac < b.bc - EPS || b.ah < b.bh - EPS || b.al < b.bl - EPS) { rep.dropped.askBelowBid++; continue; }
    const brokenSide = (h, l, op, cl) => h < Math.max(op, cl) - EPS || l > Math.min(op, cl) + EPS || h < l - EPS;
    if (brokenSide(b.bh, b.bl, b.bo, b.bc) || brokenSide(b.ah, b.al, b.ao, b.ac)) { rep.dropped.ohlcBroken++; continue; }
    if (b.t % step !== 0) { rep.dropped.offGrid++; continue; }
    const L = local(b.t, o.tz);
    if (o.dropWeekends && (L.weekday === 0 || L.weekday === 6)) { rep.dropped.weekend++; continue; }
    if (byT.has(b.t)) {
      rep.dropped.duplicate++;
      const p = byT.get(b.t);
      if (keys.some((k) => Math.abs(p[k] - b[k]) > EPS)) rep.duplicateConflicts++;
    }
    if (b.spreadAssumed) rep.spreadAssumed++;
    byT.set(b.t, { t: b.t, bo: b.bo, bh: b.bh, bl: b.bl, bc: b.bc, ao: b.ao, ah: b.ah, al: b.al, ac: b.ac, vol: b.vol, date: L.date, hm: L.hm, wd: L.weekday, flags: [] });
  }
  let bars = [...byT.values()].sort((a, b) => a.t - b.t);

  // 2) Tage: zu kurze Tage verwerfen
  const dayCount = {};
  for (const b of bars) dayCount[b.date] = (dayCount[b.date] || 0) + 1;
  bars = bars.filter((b) => {
    if (dayCount[b.date] < o.minBarsPerDay) { rep.dropped.shortDay++; return false; }
    return true;
  });

  // 3) Spread-Ausreißer je lokaler Stunde
  const spreadsByHour = {};
  for (const b of bars) (spreadsByHour[b.hm.slice(0, 2)] ||= []).push(b.ac - b.bc);
  const medSpread = Object.fromEntries(Object.entries(spreadsByHour).map(([h, a]) => [h, median(a)]));
  for (const b of bars) {
    const ms = medSpread[b.hm.slice(0, 2)];
    const sp = b.ac - b.bc;
    if (sp > o.spreadOutlierFactor * ms && sp > o.spreadOutlierMinAbs) {
      b.flags.push('spread');
      rep.flagged.spreadOutlier++;
      if (rep.examples.spreadOutlier.length < 10) rep.examples.spreadOutlier.push({ date: b.date, hm: b.hm, spread: r2(sp), median: r2(ms) });
      if (o.repairSpreadOutliers) {
        const d = sp - ms;
        b.ao -= d; b.ah -= d; b.al -= d; b.ac -= d;
        rep.repaired.spread++;
      }
    }
  }

  // 4) Spikes + eingefrorener Feed
  const ranges = [];
  let run = 1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const rg = b.bh - b.bl;
    if (ranges.length >= 50) {
      const med = median(ranges.slice(-100));
      if (med > 0 && rg > o.spikeFactor * med) {
        b.flags.push('spike');
        rep.flagged.spike++;
        if (rep.examples.spike.length < 10) rep.examples.spike.push({ date: b.date, hm: b.hm, range: r2(rg), median: r2(med) });
      }
    }
    ranges.push(rg);
    if (ranges.length > 200) ranges.shift();
    const prev = bars[i - 1];
    const same = prev && prev.date === b.date && b.bo === b.bc && b.bh === b.bl && prev.bc === b.bc && prev.bh === prev.bl;
    run = same ? run + 1 : 1;
    if (run === o.staleRun) {
      rep.flagged.stale++;
      if (rep.examples.stale.length < 10) rep.examples.stale.push({ date: b.date, hm: b.hm });
      for (let k = i - o.staleRun + 1; k <= i; k++) if (!bars[k].flags.includes('stale')) bars[k].flags.push('stale');
    } else if (run > o.staleRun) b.flags.push('stale');
  }

  // 5) Tagesindex + Vollständigkeit der Kernzeit
  const expected = hmList(o.session.from, o.session.to, o.barMinutes);
  const days = [];
  let cur = null;
  bars.forEach((b, i) => {
    if (!cur || cur.date !== b.date) {
      cur = { date: b.date, wd: b.wd, start: i, end: i, hms: new Set() };
      days.push(cur);
    }
    cur.end = i;
    cur.hms.add(b.hm);
  });
  for (const d of days) {
    const missing = expected.filter((h) => !d.hms.has(h));
    d.missing = missing;
    d.complete = missing.length <= o.maxMissingInSession;
    delete d.hms;
    rep.days[d.date] = { bars: d.end - d.start + 1, missing: missing.length, complete: d.complete };
  }

  rep.output = bars.length;
  rep.dayCount = days.length;
  rep.incompleteDays = days.filter((d) => !d.complete).map((d) => ({ date: d.date, missing: d.missing.length, first: d.missing.slice(0, 5) }));
  rep.period = bars.length ? { from: bars[0].date, to: bars[bars.length - 1].date } : null;
  rep.medianSpreadByHour = Object.fromEntries(Object.entries(medSpread).sort().map(([h, v]) => [h, r2(v)]));
  return { bars, days, report: rep, options: o };
}

/** Kurztext für Konsole/Report */
export function summarizeClean(rep) {
  const d = rep.dropped;
  const lines = [
    `Kerzen: ${rep.input} geladen -> ${rep.output} sauber (${rep.dayCount} Handelstage${rep.period ? `, ${rep.period.from} bis ${rep.period.to}` : ''})`,
    `Entfernt: ungültig ${d.invalid}, Ask<Bid ${d.askBelowBid}, OHLC kaputt ${d.ohlcBroken}, außerhalb Raster ${d.offGrid}, Wochenende ${d.weekend}, Duplikate ${d.duplicate} (davon widersprüchlich ${rep.duplicateConflicts}), Rumpftage ${d.shortDay}`,
    `Markiert: Spread-Ausreißer ${rep.flagged.spreadOutlier}, Spikes ${rep.flagged.spike}, eingefrorener Feed ${rep.flagged.stale}`,
    `Unvollständige Tage (Kernzeit): ${rep.incompleteDays.length}`,
  ];
  if (rep.spreadAssumed) lines.push(`Achtung: ${rep.spreadAssumed} Kerzen ohne echten Spread (Default-Spread angenommen)`);
  return lines.join('\n');
}
