// Kandidat „Fair Price“ (nach JJ Simon) – NAS100 und DE40, nur die ersten 90 Minuten einer Session.
//
// Regeln laut Auftrag (06.11.2026), umgesetzt auf M5 als NÄHERUNG (M1-Daten liegen nicht vor):
//   Fairer Preis (FP) = Eröffnungskurs (Mitte) der ersten Kerze der Session; verfällt mit Sessionende.
//   Setup A (Fortsetzung): Richtung = Farbe der ersten Kerze. Einstieg, wenn eine Folgekerze innerhalb des
//     A-Fensters (M5: 2 Folgekerzen = bis Minute 15 statt Minute 5) jenseits von Hoch/Tief der Vorkerze schließt.
//     Bias: 'ema' = M5-EMA50-Steigung (3 Kerzen) in Richtung, 'off' = aus, 'counter' = gegen den Trend der letzten 9 h.
//     SL/TP aus dem Raster; ist die Eröffnungskerze größer als der SL, gelten doppelte SL/TP (halbe Größe, gleiches R).
//   Setup B (Reversion zum FP): Kurs über FP -> nur Shorts, darunter -> nur Longs.
//     B1 Verschiebungskerze: Körper > Vorkörper, Vorkerze Gegenfarbe, Schluss jenseits des Dochts der Vorkerze.
//     B2 Strukturbruch: Schluss jenseits des letzten Fraktal-Swings (3 Kerzen) gegen die Bewegung.
//     Filter: |Einstieg - FP| >= 80 % der TP-Strecke. Session-Stopp nach 3 B-Verlusten in Folge.
//   Ausführung: Signal bei Kerzenschluss, Einstieg zum Open der Folgekerze (Kauf Ask, Verkauf Bid) + Slippage.
//     SL/TP intrabar auf der passenden Seite; SL und TP in derselben Kerze -> SL. Gap über SL -> Fill zum Open.
//     Max. 1 offene Position je Variante. Zeit-Ausstieg spätestens 21:55 Berlin, freitags 20:30 (d_ftmo-Regel).
//   Nicht abgebildet: News-FP und „News-konform“ (kein Kalender), Verzögerung 0/5/15 s (nur Slippage-Aufschlag).

import { local, utcFor } from '../core/time.js';
import { epicSession } from '../core/sessions.js';

// Eröffnungen aus config/sessions.yaml. pm 14:00 NY ist eine Strategie-Zeit (Fair-Price-Spezifikation), keine Börseneröffnung.
// DE40 „us“ = NY-Eröffnung in NY-Zeit (bis 07.11.2026 fest 15:30 Berlin -> in den DST-Sonderwochen eine Stunde zu spät).
const NY = epicSession('US100'), XE = epicSession('DE40');
export const INSTRUMENTS = {
  US100: { sessions: { main: { tz: NY.tz, from: NY.open_local }, pm: { tz: NY.tz, from: '14:00' } } },
  DE40: { sessions: { main: { tz: XE.tz, from: XE.open_local }, us: { tz: NY.tz, from: NY.open_local } } },
};
const SESSION_MIN = 90;
const BAR_MIN = 5;

const mid = (b, k) => (b['b' + k] + b['a' + k]) / 2;

/** Sessions je Handelstag: Index der ersten Session-Kerze, Anzahl Kerzen, FP, ATR vor Sessionbeginn. */
export function buildSessions(bars, sessionDef) {
  const { tz, from } = sessionDef;
  const byDate = new Map();
  const step = BAR_MIN * 60000;
  // Index aller Kerzen nach Zeit, um die Startkerze direkt zu finden
  const idx = new Map(bars.map((b, i) => [b.t, i]));
  const dates = new Set();
  for (const b of bars) dates.add(local(b.t, tz).date);
  const out = [];
  for (const date of [...dates].sort()) {
    const t0 = utcFor(date, from, tz);
    if (t0 == null || !idx.has(t0)) continue;
    const i0 = idx.get(t0);
    const n = SESSION_MIN / BAR_MIN;
    let ok = true;
    for (let k = 0; k < n; k++) { const b = bars[i0 + k]; if (!b || b.t !== t0 + k * step) { ok = false; break; } }
    if (!ok || i0 < 120) continue;
    // ATR14 (M5, Mitte) aus den 14 Kerzen vor Sessionbeginn
    let atr = 0;
    for (let k = i0 - 14; k < i0; k++) {
      const b = bars[k], p = bars[k - 1];
      atr += Math.max(mid(b, 'h') - mid(b, 'l'), Math.abs(mid(b, 'h') - mid(p, 'c')), Math.abs(mid(b, 'l') - mid(p, 'c')));
    }
    atr /= 14;
    const wd = local(t0, 'Europe/Berlin').weekday;
    out.push({ date, i0, n, fp: mid(bars[i0], 'o'), atr, wd });
    byDate.set(date, out[out.length - 1]);
  }
  return out;
}

function emaSeries(bars, period = 50) {
  const k = 2 / (period + 1);
  const out = new Array(bars.length);
  let e = mid(bars[0], 'c');
  for (let i = 0; i < bars.length; i++) { e = i === 0 ? e : mid(bars[i], 'c') * k + e * (1 - k); out[i] = e; }
  return out;
}

/** Einen Trade ab Kerze ie (Open) verwalten. Liefert Ausstieg, R, MAE in R. */
function manage(bars, ie, dir, slPts, tpPts, slip) {
  const e = bars[ie];
  const entry = dir === 'BUY' ? e.ao + slip : e.bo - slip;
  const sl = dir === 'BUY' ? entry - slPts : entry + slPts;
  const tp = dir === 'BUY' ? entry + tpPts : entry - tpPts;
  const lb = local(e.t, 'Europe/Berlin');
  const endHm = lb.weekday === 5 ? '20:30' : '21:55';
  let mae = 0;
  for (let j = ie; j < bars.length; j++) {
    const b = bars[j];
    const L = local(b.t, 'Europe/Berlin');
    if (L.date !== lb.date || L.hm >= endHm) {
      // Zeit-Ausstieg zum Open dieser Kerze (bzw. Schluss der letzten Kerze des Tages)
      const px = L.date !== lb.date ? (dir === 'BUY' ? bars[j - 1].bc : bars[j - 1].ac) : (dir === 'BUY' ? b.bo : b.ao);
      const pts = dir === 'BUY' ? px - entry : entry - px;
      return { exitIdx: j, reason: 'ZEIT', R: pts / slPts, mae };
    }
    // Long: Ausstieg am Bid, Short am Ask
    const lo = dir === 'BUY' ? b.bl : b.al, hi = dir === 'BUY' ? b.bh : b.ah, op = dir === 'BUY' ? b.bo : b.ao;
    const adverse = (dir === 'BUY' ? entry - lo : hi - entry) / slPts;
    if (j > ie) {
      const gap = dir === 'BUY' ? op <= sl : op >= sl;
      if (gap) { const pts = dir === 'BUY' ? op - slip - entry : entry - op - slip; return { exitIdx: j, reason: 'SL_GAP', R: pts / slPts, mae: Math.max(mae, -pts / slPts) }; }
    }
    const hitSl = dir === 'BUY' ? lo <= sl : hi >= sl;
    const hitTp = dir === 'BUY' ? hi >= tp : lo <= tp;
    // MAE = größter offener Verlust in R; in der SL-Kerze höchstens der realisierte Verlust (Position ist dann zu)
    if (hitSl) { const px = dir === 'BUY' ? sl - slip : sl + slip; const pts = dir === 'BUY' ? px - entry : entry - px; return { exitIdx: j, reason: hitTp ? 'SL_KONFLIKT' : 'SL', R: pts / slPts, mae: Math.max(mae, -pts / slPts) }; }
    mae = Math.max(mae, adverse);
    if (hitTp) return { exitIdx: j, reason: 'TP', R: tpPts / slPts, mae };
  }
  return null;
}

/**
 * Eine Variante über alle Sessions rechnen.
 * v = { setup: 'A'|'B1'|'B2'|'B12', bias: 'ema'|'off'|'counter', sl, tp, slip, aBars (A-Fenster in Folgekerzen) }
 * sl/tp in Punkten oder als Funktion (session) -> Punkte.
 */
export function runVariant(bars, sessions, v, ema = null) {
  const trades = [];
  const slip = v.slip ?? 0.5;
  const E = v.setup === 'A' && v.bias === 'ema' ? (ema || emaSeries(bars)) : null;
  let busyUntil = -1; // max. 1 offene Position je Variante
  for (const s of sessions) {
    const slPts0 = typeof v.sl === 'function' ? v.sl(s) : v.sl;
    const tpPts0 = typeof v.tp === 'function' ? v.tp(s) : v.tp;
    if (!(slPts0 > 0 && tpPts0 > 0)) continue;
    const last = s.i0 + s.n - 1;
    if (v.setup === 'A') {
      const f = bars[s.i0];
      const o = mid(f, 'o'), c = mid(f, 'c');
      if (c === o) continue;
      const dir = c > o ? 'BUY' : 'SELL';
      if (v.bias === 'ema') { const sl3 = E[s.i0] - E[s.i0 - 3]; if (dir === 'BUY' ? sl3 <= 0 : sl3 >= 0) continue; }
      if (v.bias === 'counter') { const tr = c - mid(bars[s.i0 - 108], 'c'); if (dir === 'BUY' ? tr >= 0 : tr <= 0) continue; }
      const big = mid(f, 'h') - mid(f, 'l') > slPts0;
      const slPts = big ? 2 * slPts0 : slPts0, tpPts = big ? 2 * tpPts0 : tpPts0;
      for (let j = s.i0 + 1; j <= Math.min(last, s.i0 + (v.aBars ?? 2)); j++) {
        if (j <= busyUntil) continue;
        const b = bars[j], p = bars[j - 1];
        const trig = dir === 'BUY' ? mid(b, 'c') > mid(p, 'h') : mid(b, 'c') < mid(p, 'l');
        if (!trig || j + 1 >= bars.length) continue;
        const m = manage(bars, j + 1, dir, slPts, tpPts, slip);
        if (!m) break;
        trades.push(rec(bars, s, v, 'A', dir, j, m, slPts, big));
        busyUntil = m.exitIdx;
        break;
      }
      continue;
    }
    // Setup B
    let lossRun = 0;
    for (let j = s.i0 + 1; j <= last; j++) {
      if (j <= busyUntil || lossRun >= 3) continue;
      const b = bars[j], p = bars[j - 1];
      const c = mid(b, 'c');
      if (c === s.fp) continue;
      const dir = c > s.fp ? 'SELL' : 'BUY';
      let sig = null;
      if (v.setup === 'B1' || v.setup === 'B12') {
        const body = Math.abs(c - mid(b, 'o')), pBody = Math.abs(mid(p, 'c') - mid(p, 'o'));
        const bear = c < mid(b, 'o'), pBull = mid(p, 'c') > mid(p, 'o'), pBear = mid(p, 'c') < mid(p, 'o'), bull = c > mid(b, 'o');
        if (body > pBody && (dir === 'SELL' ? bear && pBull && c < mid(p, 'l') : bull && pBear && c > mid(p, 'h'))) sig = 'B1';
      }
      if (!sig && (v.setup === 'B2' || v.setup === 'B12')) {
        // letzter bestätigter Fraktal-Swing (Kerze k mit k+1 < j), Suche ab Sessionbeginn - 3
        for (let k = j - 2; k >= s.i0 - 3; k--) {
          const lo = mid(bars[k], 'l'), hi = mid(bars[k], 'h');
          if (dir === 'SELL' && lo < mid(bars[k - 1], 'l') && lo < mid(bars[k + 1], 'l')) {
            if (c < lo && mid(p, 'c') >= lo) sig = 'B2';
            break;
          }
          if (dir === 'BUY' && hi > mid(bars[k - 1], 'h') && hi > mid(bars[k + 1], 'h')) {
            if (c > hi && mid(p, 'c') <= hi) sig = 'B2';
            break;
          }
        }
      }
      if (!sig) continue;
      if (Math.abs(c - s.fp) < 0.8 * tpPts0) continue;
      if (j + 1 >= bars.length) break;
      const m = manage(bars, j + 1, dir, slPts0, tpPts0, slip);
      if (!m) break;
      trades.push(rec(bars, s, v, sig, dir, j, m, slPts0, false));
      busyUntil = m.exitIdx;
      lossRun = m.R < 0 ? lossRun + 1 : 0;
    }
  }
  return trades;
}

function rec(bars, s, v, signal, dir, j, m, slPts, big) {
  const e = bars[j + 1], x = bars[m.exitIdx];
  return { date: s.date, wd: s.wd, signal, dir, signalT: bars[j].t, entryT: e.t, exitT: x.t, exitDate: local(x.t, 'Europe/Berlin').date,
    reason: m.reason, R: Math.round(m.R * 1000) / 1000, mae: Math.round(m.mae * 1000) / 1000, slPts: Math.round(slPts * 10) / 10, big };
}

/** Annahmen-Check: Wie oft erreicht der Kurs den FP nach der ersten Kerze innerhalb der 90 Minuten? */
export function fpReach(bars, sessions, awayPts) {
  const res = [];
  for (const s of sessions) {
    let reached = false, away = false, reachedAfterAway = false, maxAway = 0;
    for (let k = s.i0 + 1; k < s.i0 + s.n; k++) {
      const b = bars[k];
      const lo = mid(b, 'l'), hi = mid(b, 'h');
      if (lo <= s.fp && hi >= s.fp) { reached = true; if (away) reachedAfterAway = true; }
      const d = Math.max(hi - s.fp, s.fp - lo);
      maxAway = Math.max(maxAway, d);
      if (d >= awayPts(s)) away = true;
    }
    res.push({ date: s.date, wd: s.wd, reached, away, reachedAfterAway, maxAway: Math.round(maxAway * 10) / 10, atr: Math.round(s.atr * 10) / 10 });
  }
  return res;
}
