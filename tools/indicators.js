#!/usr/bin/env node
// Indikatoren auf M5 für die Dukascopy-Historie (alle Jahre, je Epic), Kerze für Kerze ohne Lookahead.
//
//   node tools/indicators.js [DE40 US100 EURUSD] [--tf M5,M15,H4]
//     M5  -> data/indicators/<epic>/ind_<EPIC>_M5_<Jahr>.csv
//     M15 -> data/indicators/<epic>/m15/ind_<EPIC>_M15_<Jahr>.csv,  H4 -> data/indicators/<epic>/h4/…
//     Tresor-Jahre (config/tresor.json) jeweils im Unterordner tresor/
// M15/H4 werden aus M5 gebaut (UTC-Raster wie src/live/candles.js: Open erste, High/Low über alle, Close letzte M5-Kerze, Volumen Summe,
// Spread = Schluss-Spread). Zeitstempel = Periodenbeginn, Werte gelten erst nach Schluss der Periode (z. B. M15 10:00 ab 10:15).
// Auf M15: H1/H4/Tages-Spalten wie bei M5 (abgeschlossene Perioden). Auf H4: h1_*, h4_* und or30_* leer (dort sinnlos);
// Session-VWAP nur aus H4-Kerzen, die innerhalb der Session beginnen (grob).
//
// Grundlage: Mittelkurs (Bid + Ask) / 2 der Dukascopy-M5-Kerzen (data/dukascopy/<epic>/), wie die Live-Bots ((bid+ask)/2).
// Jeder Wert in Zeile t verwendet nur Kerzen bis einschließlich t (gilt nach Schluss von t). Höhere Zeitebenen (H1/H4/D1) nur aus
// ABGESCHLOSSENEN Perioden. Indikatoren laufen über Lücken (Nacht, Wochenende) einfach weiter – wie beim Broker-Feed.
// Zeitebenen: H1/H4 = UTC-Raster (wie src/live/candles.js); Handelstag DE40 = Datum Berlin, US100 = 18:00–18:00 New York,
// EURUSD = 17:00–17:00 New York (FX-Rollover). Sessions (VWAP, Eröffnungsspanne) aus config/sessions.yaml (Hauptsession).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionUtc } from '../src/core/sessions.js';
import { tresorYears } from '../src/core/tresor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGITS = { DE40: 2, US100: 2, EURUSD: 6 };
const DAY = { DE40: { tz: 'Europe/Berlin', shiftH: 0 }, US100: { tz: 'America/New_York', shiftH: 6 }, EURUSD: { tz: 'America/New_York', shiftH: 7 } };

// ---------------------------------------------------------------- Bausteine (Streaming, je update(x) ein Wert)
export class SMA { constructor(n) { this.n = n; this.buf = new Float64Array(n); this.i = 0; this.k = 0; this.sum = 0; }
  update(x) { if (this.k === this.n) this.sum -= this.buf[this.i]; else this.k++; this.buf[this.i] = x; this.sum += x; this.i = (this.i + 1) % this.n; return this.k === this.n ? this.sum / this.n : NaN; } }
/** EMA mit SMA-Start (erste n Werte), danach alpha = 2/(n+1). */
export class EMA { constructor(n) { this.n = n; this.a = 2 / (n + 1); this.k = 0; this.v = 0; }
  update(x) { if (this.k < this.n) { this.v += x; if (++this.k === this.n) { this.v /= this.n; return this.v; } return NaN; } this.v += this.a * (x - this.v); return this.v; } }
/** Wilder-Glättung (RMA) mit SMA-Start. */
export class RMA { constructor(n) { this.n = n; this.k = 0; this.v = 0; }
  update(x) { if (this.k < this.n) { this.v += x; if (++this.k === this.n) { this.v /= this.n; return this.v; } return NaN; } this.v = (this.v * (this.n - 1) + x) / this.n; return this.v; } }
/** Fenster-Max/Min/Summe/Std über die letzten n Werte. */
export class Win { constructor(n) { this.n = n; this.buf = []; }
  push(x) { this.buf.push(x); if (this.buf.length > this.n) this.buf.shift(); return this.buf.length === this.n; }
  max() { let m = -Infinity; for (const x of this.buf) if (x > m) m = x; return m; }
  min() { let m = Infinity; for (const x of this.buf) if (x < m) m = x; return m; }
  sum() { let s = 0; for (const x of this.buf) s += x; return s; }
  mean() { return this.sum() / this.buf.length; }
  std() { const m = this.mean(); let s = 0; for (const x of this.buf) s += (x - m) ** 2; return Math.sqrt(s / this.buf.length); } } // Population (wie TradingView)
export class RSI { constructor(n) { this.g = new RMA(n); this.l = new RMA(n); this.prev = NaN; }
  update(c) { if (Number.isNaN(this.prev)) { this.prev = c; return NaN; } const d = c - this.prev; this.prev = c;
    const g = this.g.update(Math.max(d, 0)), l = this.l.update(Math.max(-d, 0)); if (Number.isNaN(g)) return NaN; return l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
/** ADX/+DI/−DI nach Wilder. */
export class ADX { constructor(n) { this.n = n; this.tr = new RMA(n); this.p = new RMA(n); this.m = new RMA(n); this.adx = new RMA(n); this.prev = null; }
  update(h, l, c) { if (!this.prev) { this.prev = { h, l, c }; return [NaN, NaN, NaN]; } const P = this.prev; this.prev = { h, l, c };
    const up = h - P.h, dn = P.l - l; const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h - l, Math.abs(h - P.c), Math.abs(l - P.c)); const a = this.tr.update(tr), p = this.p.update(pdm), m = this.m.update(mdm);
    if (Number.isNaN(a) || a === 0) return [NaN, NaN, NaN]; const pdi = 100 * p / a, mdi = 100 * m / a; const dx = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
    return [this.adx.update(dx), pdi, mdi]; } }

/** Zeitebene aus M5: liefert die zuletzt ABGESCHLOSSENE Periode, sobald eine neue beginnt. key(t) -> Periodenschlüssel. */
class HTF { constructor(key) { this.key = key; this.cur = null; }
  update(t, o, h, l, c, v) { const k = this.key(t); let done = null;
    if (this.cur && this.cur.k !== k) { done = this.cur; this.cur = null; }
    if (!this.cur) this.cur = { k, o, h, l, c, v }; else { const b = this.cur; b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; b.v += v; }
    return done; } }

const fmtCache = new Map();
function localDate(t, tz) { // Datum (YYYY-MM-DD) in tz, Cache je Stunde
  const hk = tz + Math.floor(t / 3600000); let d = fmtCache.get(hk);
  if (!d) { d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); fmtCache.set(hk, d); if (fmtCache.size > 500000) fmtCache.clear(); }
  return d; }

export const COLS = ['timestamp', 'o', 'h', 'l', 'c', 'spread', 'volume',
  'ema9', 'ema20', 'ema50', 'ema100', 'ema200', 'sma20', 'sma50', 'sma100', 'sma200',
  'rsi14', 'rsi2', 'bb_mid', 'bb_up', 'bb_lo', 'bb_pctb', 'bb_width', 'atr14', 'macd', 'macd_signal', 'macd_hist',
  'adx14', 'pdi14', 'mdi14', 'stoch_k', 'stoch_d', 'cci20', 'don20_hi', 'don20_lo', 'chop14', 'er10',
  'vwap_sess', 'vwap_sess_sd', 'vwap_day', 'rvol_tod',
  'h1_ema50', 'h1_atr14', 'h4_ema50', 'h4_rsi14',
  'd_prev_h', 'd_prev_l', 'd_prev_c', 'd_atr14', 'pivot', 'pivot_r1', 'pivot_s1', 'or30_hi', 'or30_lo', 'in_session'];

/** Rechner für einen Epic. step(bar) -> Zeile (Array, gleiche Reihenfolge wie COLS). bar = {t, o,h,l,c (Mitte), spread, v} */
export function makeCalc(epic, opts = {}) {
  const sess = opts.session || ((date) => sessionUtc(epic, date));
  const barMs = (opts.barMin || 5) * 60000; const blank = new Set(opts.blank || []);
  const dayCfg = DAY[epic] || DAY.DE40;
  const dayKey = (t) => localDate(t + dayCfg.shiftH * 3600000, dayCfg.tz);
  const sessTz = DAY[epic]?.tz === 'Europe/Berlin' ? 'Europe/Berlin' : (epic === 'EURUSD' ? 'Europe/London' : 'America/New_York');
  const E = { e9: new EMA(9), e20: new EMA(20), e50: new EMA(50), e100: new EMA(100), e200: new EMA(200), m12: new EMA(12), m26: new EMA(26), sig: new EMA(9) };
  const S = { s20: new SMA(20), s50: new SMA(50), s100: new SMA(100), s200: new SMA(200), v20: new SMA(20) };
  const rsi14 = new RSI(14), rsi2 = new RSI(2), atr = new RMA(14), adx = new ADX(14);
  const bb = new Win(20), hh14 = new Win(14), ll14 = new Win(14), tr14 = new Win(14), kRaw = new SMA(3), kD = new SMA(3), tp20 = new Win(20), d20h = new Win(20), d20l = new Win(20), c11 = new Win(11);
  let prevC = NaN;
  const h1 = new HTF((t) => Math.floor(t / 3600000)), h4 = new HTF((t) => Math.floor(t / 14400000)), d1 = new HTF(dayKey);
  const H1 = { ema: new EMA(50), atr: new RMA(14), pc: NaN, vEma: NaN, vAtr: NaN }, H4 = { ema: new EMA(50), rsi: new RSI(14), vEma: NaN, vRsi: NaN };
  const D = { atr: new RMA(14), pc: NaN, prev: null, vAtr: NaN };
  let sKey = null, sWin = null, sPV = 0, sPV2 = 0, sV = 0, orH = NaN, orL = NaN, dKeyV = null, dPV = 0, dV = 0;
  const tod = new Map(); // Zeitfenster (Session-Ortszeit HH:MM) -> letzte 20 Volumina
  const sessCache = new Map();
  const sessFor = (t) => { // Hauptsession, deren Datum (Session-Zeitzone) zu t passt
    const date = localDate(t, sessTz); if (!sessCache.has(date)) { let w = null; try { w = sess(date); } catch { w = null; } sessCache.set(date, w); if (sessCache.size > 5000) sessCache.clear(); }
    return [date, sessCache.get(date)]; };
  const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: sessTz, hour: '2-digit', minute: '2-digit', hour12: false });

  return function step(b) {
    const { t, o, h, l, c, v } = b;
    const tr = Number.isNaN(prevC) ? h - l : Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    // gleitende Durchschnitte
    const ema = [E.e9.update(c), E.e20.update(c), E.e50.update(c), E.e100.update(c), E.e200.update(c)];
    const sma = [S.s20.update(c), S.s50.update(c), S.s100.update(c), S.s200.update(c)];
    const r14 = rsi14.update(c), r2 = rsi2.update(c);
    let bm = NaN, bu = NaN, bl = NaN, pb = NaN, bw = NaN;
    if (bb.push(c)) { bm = bb.mean(); const sd = bb.std(); bu = bm + 2 * sd; bl = bm - 2 * sd; pb = bu > bl ? (c - bl) / (bu - bl) : NaN; bw = bm ? (bu - bl) / bm : NaN; }
    const a14 = atr.update(tr);
    const m12 = E.m12.update(c), m26 = E.m26.update(c); const macd = m12 - m26; const sig = Number.isNaN(macd) ? NaN : E.sig.update(macd);
    const [ax, pdi, mdi] = adx.update(h, l, c);
    hh14.push(h); ll14.push(l); const full14 = tr14.push(tr);
    let sk = NaN, sd = NaN; if (hh14.buf.length === 14) { const H = hh14.max(), L = ll14.min(); sk = kRaw.update(H > L ? 100 * (c - L) / (H - L) : 50); sd = Number.isNaN(sk) ? NaN : kD.update(sk); }
    const tp = (h + l + c) / 3; let cci = NaN; if (tp20.push(tp)) { const m = tp20.mean(); let md = 0; for (const x of tp20.buf) md += Math.abs(x - m); md /= 20; cci = md ? (tp - m) / (0.015 * md) : 0; }
    let dh = NaN, dl = NaN; d20h.push(h); d20l.push(l); if (d20h.buf.length === 20) { dh = d20h.max(); dl = d20l.min(); }
    let chop = NaN; if (full14) { const rng = hh14.max() - ll14.min(); chop = rng > 0 ? 100 * Math.log10(tr14.sum() / rng) / Math.log10(14) : NaN; }
    let er = NaN; if (c11.push(c)) { let p = 0; for (let i = 1; i < 11; i++) p += Math.abs(c11.buf[i] - c11.buf[i - 1]); er = p ? Math.abs(c11.buf[10] - c11.buf[0]) / p : 0; }
    // Session-VWAP, Eröffnungsspanne 30 min, Tages-VWAP
    const [sDate, w] = sessFor(t); const inS = !!w && t >= w.open && t < w.close;
    let vw = NaN, vsd = NaN;
    if (inS) {
      if (sKey !== sDate) { sKey = sDate; sWin = w; sPV = sPV2 = sV = 0; orH = -Infinity; orL = Infinity; }
      sPV += tp * v; sPV2 += tp * tp * v; sV += v; if (sV > 0) { vw = sPV / sV; vsd = Math.sqrt(Math.max(0, sPV2 / sV - vw * vw)); }
      if (t < w.open + 30 * 60000) { orH = Math.max(orH, h); orL = Math.min(orL, l); }
    }
    const orReady = inS && sKey === sDate && t + barMs >= sWin.open + 30 * 60000; // erst nach Schluss der letzten Kerze der 30 min
    const dk = dayKey(t); if (dk !== dKeyV) { dKeyV = dk; dPV = dV = 0; } dPV += tp * v; dV += v; const vwd = dV > 0 ? dPV / dV : NaN;
    // relatives Volumen zur gleichen Uhrzeit (Session-Ortszeit) der letzten 20 Tage (ohne heute)
    const slot = hmFmt.format(new Date(t)); let q = tod.get(slot); if (!q) tod.set(slot, (q = []));
    const rv = q.length >= 5 ? v / (q.reduce((s, x) => s + x, 0) / q.length) : NaN; q.push(v); if (q.length > 20) q.shift();
    // H1/H4: abgeschlossene Perioden
    const hd = h1.update(t, o, h, l, c, v); if (hd) { const trH = Number.isNaN(H1.pc) ? hd.h - hd.l : Math.max(hd.h - hd.l, Math.abs(hd.h - H1.pc), Math.abs(hd.l - H1.pc)); H1.pc = hd.c; H1.vEma = H1.ema.update(hd.c); H1.vAtr = H1.atr.update(trH); }
    const h4d = h4.update(t, o, h, l, c, v); if (h4d) { H4.vEma = H4.ema.update(h4d.c); H4.vRsi = H4.rsi.update(h4d.c); }
    const dd = d1.update(t, o, h, l, c, v); if (dd) { const trD = Number.isNaN(D.pc) ? dd.h - dd.l : Math.max(dd.h - dd.l, Math.abs(dd.h - D.pc), Math.abs(dd.l - D.pc)); D.pc = dd.c; D.prev = dd; D.vAtr = D.atr.update(trD); }
    const P = D.prev; const pv = P ? (P.h + P.l + P.c) / 3 : NaN;
    prevC = c;
    S.v20.update(v);
    const row = [t, o, h, l, c, b.spread, v, ...ema, ...sma, r14, r2, bm, bu, bl, pb, bw, a14, macd, sig, macd - sig, ax, pdi, mdi, sk, sd, cci, dh, dl, chop, er,
      vw, vsd, vwd, rv, H1.vEma, H1.vAtr, H4.vEma, H4.vRsi, P ? P.h : NaN, P ? P.l : NaN, P ? P.c : NaN, D.vAtr, pv, P ? 2 * pv - P.l : NaN, P ? 2 * pv - P.h : NaN,
      orReady ? orH : NaN, orReady ? orL : NaN, inS ? 1 : 0];
    for (const k of blank) row[k] = NaN;
    return row;
  };
}

// ---------------------------------------------------------------- Ein-/Ausgabe
const PRICE_COLS = new Set(['o', 'h', 'l', 'c', 'spread', 'ema9', 'ema20', 'ema50', 'ema100', 'ema200', 'sma20', 'sma50', 'sma100', 'sma200', 'bb_mid', 'bb_up', 'bb_lo', 'atr14',
  'macd', 'macd_signal', 'macd_hist', 'don20_hi', 'don20_lo', 'vwap_sess', 'vwap_sess_sd', 'vwap_day', 'h1_ema50', 'h1_atr14', 'h4_ema50', 'd_prev_h', 'd_prev_l', 'd_prev_c', 'd_atr14',
  'pivot', 'pivot_r1', 'pivot_s1', 'or30_hi', 'or30_lo']);
export function formatRow(row, digits) {
  return row.map((x, i) => { if (i === 0) return new Date(x).toISOString().replace('.000Z', 'Z'); if (x === undefined || x === null || !Number.isFinite(x)) return '';
    const name = COLS[i]; if (name === 'in_session') return x; if (name === 'volume') return +x.toFixed(4);
    return PRICE_COLS.has(name) ? +x.toFixed(digits + 1) : +x.toFixed(4); }).join(',');
}

function* readBars(epic) {
  const dir = path.join(ROOT, 'data', 'dukascopy', epic.toLowerCase());
  for (const f of fs.readdirSync(dir).filter((x) => /MINUTE_5_\d{4}\.csv$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue; const r = lines[i].split(',');
      const bo = +r[1], bh = +r[2], bl = +r[3], bc = +r[4], ao = +r[5], ah = +r[6], al = +r[7], ac = +r[8];
      yield { t: Date.parse(r[0]), o: (bo + ao) / 2, h: (bh + ah) / 2, l: (bl + al) / 2, c: (bc + ac) / 2, spread: ac - bc, v: +r[9] };
    }
  }
}

const TF = { M5: 5, M15: 15, H4: 240 };
const BLANK = { H4: ['h1_ema50', 'h1_atr14', 'h4_ema50', 'h4_rsi14', 'or30_hi', 'or30_lo'] };

/** M5-Kerzen -> Kerzen der Zeitebene (UTC-Raster); gibt nur abgeschlossene Perioden aus (letzte am Ende). */
export function* aggregate(bars, min) {
  if (min === 5) { yield* bars; return; }
  const step = min * 60000; let cur = null;
  for (const b of bars) { const k = Math.floor(b.t / step) * step;
    if (cur && cur.t !== k) { yield cur; cur = null; }
    if (!cur) cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, spread: b.spread, v: b.v };
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; cur.spread = b.spread; cur.v += b.v; } }
  if (cur) yield cur;
}

function run(epic, tf = 'M5') {
  const t0 = Date.now(); const min = TF[tf]; const sealed = tresorYears(epic);
  const step = makeCalc(epic, { barMin: min, blank: (BLANK[tf] || []).map((c) => COLS.indexOf(c)) });
  const base = path.join(ROOT, 'data', 'indicators', epic.toLowerCase(), tf === 'M5' ? '' : tf.toLowerCase()); fs.mkdirSync(path.join(base, 'tresor'), { recursive: true });
  let year = null, out = [], n = 0; const counts = {};
  const flush = () => { if (year === null) return; const dir = sealed.has(year) ? path.join(base, 'tresor') : base;
    fs.writeFileSync(path.join(dir, `ind_${epic}_${tf}_${year}.csv`), COLS.join(',') + '\n' + out.join('\n') + '\n'); counts[year] = out.length; out = []; };
  for (const b of aggregate(readBars(epic), min)) {
    const y = new Date(b.t).getUTCFullYear(); if (y !== year) { flush(); year = y; }
    out.push(formatRow(step(b), DIGITS[epic])); n++;
  }
  flush();
  console.log(`${epic} ${tf}: ${n} Kerzen, ${Object.keys(counts).length} Jahre (${Object.keys(counts).filter((y) => sealed.has(+y)).join(', ')} im Tresor-Ordner), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const a = process.argv.slice(2); const i = a.indexOf('--tf'); const tfs = i >= 0 ? a[i + 1].split(',') : ['M5'];
  const eps = a.filter((x) => DIGITS[x]); for (const e of (eps.length ? eps : Object.keys(DIGITS))) for (const tf of tfs) run(e, tf);
}
