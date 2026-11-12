// Varianten-Katalog.
//   * LIVE-Varianten: Originaltext der Code-Nodes aus strategies-live/ (keine Änderung).
//   * Test-Varianten: Originaltext + klar benannte Patches (Konstanten, Lookback, zusätzliche Bedingungen).
//     Jeder Patch prüft, dass die Fundstelle genau so oft vorkommt wie erwartet – sonst Abbruch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../strategies-live');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------- Patch-Werkzeuge
function replaceExact(code, find, repl, expect = 1) {
  const n = code.split(find).length - 1;
  if (n !== expect) throw new Error(`Patch-Fundstelle ${expect}x erwartet, ${n}x gefunden: ${find.slice(0, 60)}`);
  return code.split(find).join(repl);
}
function setConst(code, name, value) {
  const re = new RegExp(`(const\\s+${name}\\s*=\\s*)([^;]+);`);
  if (!re.test(code)) throw new Error(`Konstante ${name} nicht gefunden`);
  return code.replace(re, `$1${JSON.stringify(value)};`);
}
function setLookback(code, n, current) {
  code = replaceExact(code, `findSwingHighs(highs, ${current})`, `findSwingHighs(highs, ${n})`);
  return replaceExact(code, `findSwingLows(lows, ${current})`, `findSwingLows(lows, ${n})`);
}

// Zusätzliche Setup-Bedingungen aus dem Backtest-Auftrag F618ATR (03.11.2026)
const NAS_HELPERS = (cfg) => `
  const __V = ${JSON.stringify(cfg)};
  function __rej(code) { console.log('V-Filter ' + code + ' verworfen'); return false; }
  function __atrM15() { const n = 14; let s = 0; for (let k = closes.length - n; k < closes.length; k++) s += Math.max(highs[k] - lows[k], Math.abs(highs[k] - closes[k-1]), Math.abs(lows[k] - closes[k-1])); return s / n; }
  function __rangeOk(range) { if (__V.rangeK == null) return range > RANGE_MIN; return range >= __V.rangeK * __atrM15() || __rej('Range < K x ATR'); }
  function __brkOk(dir, a, b, range) { if (__V.breakoutP == null) return true; const d = dir === 'BUY' ? a.price - b.price : b.price - a.price; return d >= __V.breakoutP * range || __rej('Ausbruch < P x Range'); }
  function __freshOk(dir, s) { if (!__V.fresh) return true;
    if (dir === 'BUY') { for (let k = s.index + 1; k < highs.length; k++) if (highs[k] > s.price) return __rej('Setup nicht frisch'); }
    else { for (let k = s.index + 1; k < lows.length; k++) if (lows[k] < s.price) return __rej('Setup nicht frisch'); }
    return true; }
  function __cleanOk(dir, ext, s) { if (__V.cleanR == null) return true;
    if (dir === 'SELL') { let m = Infinity; for (let k = ext.index + 1; k <= s.index; k++) { const mv = ext.price - m; if (m < Infinity && mv > 0 && highs[k] - m > __V.cleanR * mv) return __rej('Impulswelle unsauber'); m = Math.min(m, lows[k]); } }
    else { let m = -Infinity; for (let k = ext.index + 1; k <= s.index; k++) { const mv = m - ext.price; if (m > -Infinity && mv > 0 && m - lows[k] > __V.cleanR * mv) return __rej('Impulswelle unsauber'); m = Math.max(m, highs[k]); } }
    return true; }
`;
function nasSetupPatch(code, cfg) {
  code = code.replace(/try\s*\{/, (m) => m + NAS_HELPERS(cfg));
  const parts = code.split('if (range > RANGE_MIN) {');
  if (parts.length !== 3) throw new Error('Range-Bedingung nicht 2x gefunden');
  return parts[0] + "if (__rangeOk(range) && __brkOk('BUY', sh1, sh2, range) && __freshOk('BUY', sh1) && __cleanOk('BUY', relevantLow, sh1)) {"
    + parts[1] + "if (__rangeOk(range) && __brkOk('SELL', sl1, sl2, range) && __freshOk('SELL', sl1) && __cleanOk('SELL', relevantHigh, sl1)) {" + parts[2];
}

// EURUSD-Test (04.11.2026): Sweep -> BOS -> FVG -> Einstieg im Pullback Fib 0,618–0,75 (alles M5, nur geschlossene Kerzen).
//   1. Sweep: Kerze sticht durch das letzte bestätigte M5-Swing-Tief (BUY) bzw. -Hoch (SELL), das bis dahin unberührt war,
//      und schließt wieder dahinter.
//   2. BOS: innerhalb maxBosBars schließt eine Kerze jenseits des letzten Swing-Hochs/-Tiefs vor dem Sweep.
//   3. FVG in Bruchrichtung (Mindestgröße MIN_FVG_ATR × ATR), entstanden mit der BOS-Kerze oder bis fvgBars danach.
//   4. Fib: 1,0 = Extrem zwischen Sweep und BOS, 0 = Impuls-Extrem bis jetzt. Einstieg (Market), wenn der aktuelle Kurs
//      zwischen 0,618 und 0,75 liegt, spätestens entryBars nach dem BOS. Schluss jenseits von 1,0 = Setup tot.
//   SL hinter 1,0 + slBufferAtr × ATR (min 5 / max 20 Pips wie im Template), TP = TP_RR × SL oder Fib 0 (tpMode 'FIB0').
//   Alle übrigen Template-Regeln (Handelszeit, Spread, News, ADX ≥ 20, ATR ≥ 2 Pips, Cooldown, Direction-Lock) bleiben.
const SBF_DEFAULT = { useBias: true, swingLb: 3, maxSetupBars: 48, maxBosBars: 24, fvgBars: 3, entryBars: 36, fibFrom: 0.618, fibTo: 0.75, slBufferAtr: 0.3, tpMode: 'RR' };
const SBF_BLOCK = `
  if (ENTRY_MODE === "SWEEP_BOS_FVG") {
    const LB = __SBF.swingLb;
    const sw = findSwings(c5.slice(0, closed5 + 1), LB);   // nur abgeschlossene Kerzen
    const dirs = __SBF.useBias ? [bias] : ["BUY", "SELL"];
    let best = null;
    for (const d of dirs) {
      const up = d === "BUY";
      const liq = up ? sw.lows : sw.highs;     // Liquidität, die gesweept wird
      const str = up ? sw.highs : sw.lows;     // Struktur, die gebrochen wird
      for (let k = closed5; k >= Math.max(2, closed5 - __SBF.maxSetupBars); k--) {
        // 1. Sweep
        const prior = liq.filter(s => s.index + LB < k);
        if (!prior.length) continue;
        const lv = prior[prior.length - 1];
        const ck = c5[k];
        if (!(up ? (ck.low < lv.price && ck.close > lv.price) : (ck.high > lv.price && ck.close < lv.price))) continue;
        let fresh = true;
        for (let j = lv.index + 1; j < k; j++) if (up ? c5[j].low < lv.price : c5[j].high > lv.price) { fresh = false; break; }
        if (!fresh) continue;
        // 2. BOS
        const refs = str.filter(s => s.index < k);
        if (!refs.length) continue;
        const ref = refs[refs.length - 1];
        let b = -1;
        for (let j = k + 1; j <= Math.min(closed5, k + __SBF.maxBosBars); j++) {
          if (up ? c5[j].close > ref.price : c5[j].close < ref.price) { b = j; break; }
        }
        if (b < 0) continue;
        // 3. FVG
        let fvg = null;
        for (let j = Math.max(b, 2); j <= Math.min(closed5, b + __SBF.fvgBars); j++) {
          if (up && c5[j].low > c5[j-2].high && c5[j].low - c5[j-2].high >= atr * MIN_FVG_ATR) { fvg = j; break; }
          if (!up && c5[j].high < c5[j-2].low && c5[j-2].low - c5[j].high >= atr * MIN_FVG_ATR) { fvg = j; break; }
        }
        if (fvg === null) continue;
        if (closed5 - b > __SBF.entryBars) break;
        // 4. Fib-Anker
        let ext = up ? Infinity : -Infinity;
        for (let j = k; j <= b; j++) ext = up ? Math.min(ext, c5[j].low) : Math.max(ext, c5[j].high);
        let imp = up ? -Infinity : Infinity;
        for (let j = k; j <= closed5; j++) imp = up ? Math.max(imp, c5[j].high) : Math.min(imp, c5[j].low);
        let dead = false;
        for (let j = b; j <= closed5; j++) if (up ? c5[j].close < ext : c5[j].close > ext) { dead = true; break; }
        if (!dead && (!best || k > best.k)) best = { d, k, b, ext, imp };
        break; // jüngster Sweep je Richtung
      }
    }
    if (!best) return none("keine Sweep→BOS→FVG-Sequenz");
    const up = best.d === "BUY";
    const R = Math.abs(best.imp - best.ext);
    const zA = up ? best.imp - __SBF.fibFrom * R : best.imp + __SBF.fibFrom * R;
    const zB = up ? best.imp - __SBF.fibTo * R : best.imp + __SBF.fibTo * R;
    const inZone = up ? (price <= zA && price >= zB) : (price >= zA && price <= zB);
    if (!inZone) return none(\`Sequenz \${best.d} aktiv, warte auf Pullback \${Math.min(zA, zB).toFixed(5)}–\${Math.max(zA, zB).toFixed(5)}\`);
    const slLevel = up ? best.ext - atr * __SBF.slBufferAtr : best.ext + atr * __SBF.slBufferAtr;
    slDistance = clampSL(Math.abs(price - slLevel));
    if (slDistance > SL_MAX_PIPS * PIP) return none(\`SL zu weit (\${(slDistance / PIP).toFixed(1)} Pips)\`);
    signal = best.d; isBuy = up; entry = price;
    if (__SBF.tpMode === "FIB0") __tpDist = Math.abs(best.imp - price);
    const fibAt = Math.abs(best.imp - price) / R;
    __sbfFeat = { sbfFib: +fibAt.toFixed(3), sbfBosMin: (best.b - best.k) * 5, sbfAgeMin: (closed5 - best.b) * 5, sbfRangePips: +(R / PIP).toFixed(1) };
    fingerprint = \`\${best.d}_SBF_\${c5[best.k].time}\`;
    entryReason = \`Sweep \${c5[best.k].time.slice(11, 16)} → BOS \${c5[best.b].time.slice(11, 16)} → FVG → Pullback Fib \${fibAt.toFixed(3)}\`;
  }
`;
function euSweepPatch(code, cfg) {
  const c = { ...SBF_DEFAULT, ...cfg };
  code = setConst(code, 'BOT_ID', c.botId);
  code = setConst(code, 'ENTRY_MODE', 'SWEEP_BOS_FVG');
  code = setConst(code, 'ORDER_TYPE', 'MARKET');
  code = setConst(code, 'TP_RR', c.tpR ?? 1.5);
  code = code.replace(/try\s*\{/, (m) => `${m}\n  const __SBF = ${JSON.stringify(c)};\n  let __tpDist = null;\n  let __sbfFeat = null;\n`);
  code = replaceExact(code, '["LEGACY", "EMA_PULLBACK", "BREAK_RETEST"].includes(ENTRY_MODE)', '["LEGACY", "EMA_PULLBACK", "BREAK_RETEST", "SWEEP_BOS_FVG"].includes(ENTRY_MODE)');
  code = replaceExact(code, 'if (bias === "NONE") return none("H1- und M15-Trend uneinig"', 'if (bias === "NONE" && __SBF.useBias) return none("H1- und M15-Trend uneinig"');
  code = replaceExact(code, 'const isBuy = bias === "BUY";', 'let isBuy = bias === "BUY";');
  code = replaceExact(code, '  if (signal === "NONE") return none("kein Signal");', SBF_BLOCK + '\n  if (signal === "NONE") return none("kein Signal");');
  code = replaceExact(code, 'const tpDistance = slDistance * TP_RR;', 'const tpDistance = __tpDist > 0 ? __tpDist : slDistance * TP_RR;');
  return replaceExact(code, '    reason: "Signal",', '    reason: "Signal",\n    ...(__sbfFeat || {}),');
}

// EURUSD-Muster (04.11.2026): Mi + Fr in allen 7 EURUSD-Varianten schwächer (beide Hälften, alle Drittel), ADX 30–35 nur
// zusammen damit hilfreich. Als Code-Patch (wie live umsetzbar): gesperrte Läufe setzen weder Cooldown noch Fingerprint.
function euDayAdxPatch(code, { noMiFr = false, noAdx3035 = false } = {}) {
  if (noMiFr) code = replaceExact(code, 'if (utcDay === 0 || utcDay === 6) return none("Wochenende");',
    'if (utcDay === 0 || utcDay === 6) return none("Wochenende");\n  if (utcDay === 3 || utcDay === 5) return none("Mi/Fr-Filter");');
  if (noAdx3035) code = replaceExact(code, '  if (adx < MIN_ADX) return none(',
    '  if (adx >= 30 && adx < 35) return none(`ADX-Filter 30–35: ${adx.toFixed(1)}`);\n  if (adx < MIN_ADX) return none(');
  return code;
}

// ---------------------------------------------------------------- Swing-Methoden (Test 04.11.2026)
// Helfer für die NAS-M15-Fib-Bots. Alle arbeiten auf Hoch/Tief (Dochte), nur bestätigte Swings.
//   fractal L/R : Hoch höher als L Kerzen links und R Kerzen rechts (Original = L = R = Lookback)
//   zigzag k    : Swing bestätigt, sobald der Kurs um k × ATR14(M15) vom Extrem zurückläuft (keine Mini-Swings)
const SWING_HELPERS = `
  function __atrSeries(h, l, c, n = 14) {
    const tr = h.map((x, i) => i === 0 ? x - l[i] : Math.max(x - l[i], Math.abs(x - c[i-1]), Math.abs(l[i] - c[i-1])));
    const out = []; let s = 0;
    for (let i = 0; i < tr.length; i++) { s += tr[i]; if (i >= n) s -= tr[i-n]; out.push(s / Math.min(i + 1, n)); }
    return out;
  }
  function __fractal(arr, L, R, isHigh) {
    const o = [];
    for (let i = L; i < arr.length - R; i++) {
      let ok = true;
      for (let j = 1; j <= Math.max(L, R) && ok; j++) {
        if (j <= L && (isHigh ? arr[i-j] >= arr[i] : arr[i-j] <= arr[i])) ok = false;
        if (j <= R && (isHigh ? arr[i+j] >= arr[i] : arr[i+j] <= arr[i])) ok = false;
      }
      if (ok) o.push({ index: i, price: arr[i] });
    }
    return o;
  }
  function __zigzag(h, l, c, k) {
    const atr = __atrSeries(h, l, c);
    const H = [], L = []; let dir = 0, hi = 0, lo = 0;
    for (let i = 1; i < h.length; i++) {
      if (dir >= 0 && h[i] > h[hi]) hi = i;
      if (dir <= 0 && l[i] < l[lo]) lo = i;
      const th = k * atr[i];
      if (dir >= 0 && i > hi && h[hi] - l[i] >= th) { H.push({ index: hi, price: h[hi] }); dir = -1; lo = i; continue; }
      if (dir <= 0 && i > lo && h[i] - l[lo] >= th) { L.push({ index: lo, price: l[lo] }); dir = 1; hi = i; continue; }
    }
    return { H, L };
  }
  function __swings(h, l, c, m) {
    if (m.type === 'zigzag') return __zigzag(h, l, c, m.k);
    return { H: __fractal(h, m.L, m.R, true), L: __fractal(l, m.L, m.R, false) };
  }
`;

// NAS: Swing-Methode tauschen (+ optional BOS per Schlusskurs, echtes Extrem der Bewegung als Fib-Anker,
//      Mindestabstand sh2 -> sh1 in Punkten (minBos), in × ATR14 M15 (minBosAtr) oder in Kerzen (minBars),
//      Höchstabstand in Punkten (maxBos) oder × ATR (maxBosAtr),
//      Kontext über N Kerzen: hiWin = sh1 ist Extrem der N Kerzen bis sh1, winN = sh2 und sh1 in den letzten N Kerzen,
//      anchorN = Fib-Anker = Extrem der N Kerzen vor sh1/sl1)
export function nasSwingPatch(code, cfg, currentLb) {
  const c = { method: null, bosClose: false, trueExt: false, minBos: null, minBosAtr: null, minBars: null, maxBos: null, maxBosAtr: null, hiWin: null, winN: null, anchorN: null, ...cfg };
  code = code.replace(/try\s*\{/, (m) => `${m}\n  const __SW = ${JSON.stringify(c)};\n${SWING_HELPERS}
  function __bosOk(dir, ref, cur) {
    const dist = dir === 'BUY' ? cur.price - ref.price : ref.price - cur.price;
    if (__SW.minBos != null && dist < __SW.minBos) return false;
    if (__SW.minBosAtr != null) { const a = __atrSeries(highs, lows, closes); if (dist < __SW.minBosAtr * a[a.length - 1]) return false; }
    if (__SW.minBars != null && cur.index - ref.index < __SW.minBars) return false;
    if (__SW.hiWin != null) { for (let k = Math.max(0, cur.index - __SW.hiWin + 1); k <= cur.index; k++) if (dir === 'BUY' ? highs[k] > cur.price : lows[k] < cur.price) return false; }
    if (__SW.winN != null && ref.index < closes.length - __SW.winN) return false;
    if (__SW.maxBos != null && dist > __SW.maxBos) return false;
    if (__SW.maxBosAtr != null) { const a = __atrSeries(highs, lows, closes); if (dist > __SW.maxBosAtr * a[a.length - 1]) return false; }
    if (!__SW.bosClose) return true;
    for (let k = ref.index + 1; k < closes.length; k++) if (dir === 'BUY' ? closes[k] > ref.price : closes[k] < ref.price) return true;
    return false; }
  function __ext(dir, a, b) { let best = null;
    for (let k = a + 1; k < b; k++) { const p = dir === 'BUY' ? lows[k] : highs[k];
      if (!best || (dir === 'BUY' ? p < best.price : p > best.price)) best = { index: k, price: p }; }
    return best; }
`);
  if (c.method) {
    code = replaceExact(code, `const swH = findSwingHighs(highs, ${currentLb});\n  const swL = findSwingLows(lows, ${currentLb});`,
      'const __sw = __swings(highs, lows, closes, __SW.method);\n  const swH = __sw.H;\n  const swL = __sw.L;');
  }
  code = replaceExact(code, 'if (sh1.price > sh2.price) {', "if (sh1.price > sh2.price && __bosOk('BUY', sh2, sh1)) {");
  code = replaceExact(code, 'if (sl1.price < sl2.price) {', "if (sl1.price < sl2.price && __bosOk('SELL', sl2, sl1)) {");
  if (c.anchorN) {
    code = replaceExact(code, 'const range = sh1.price - relevantLow.price;',
      "{ let e = null; for (let k = Math.max(0, sh1.index - __SW.anchorN); k < sh1.index; k++) if (!e || lows[k] < e.price) e = { index: k, price: lows[k] }; if (e && e.price < relevantLow.price) relevantLow = e; }\n        const range = sh1.price - relevantLow.price;");
    code = replaceExact(code, 'const range = relevantHigh.price - sl1.price;',
      "{ let e = null; for (let k = Math.max(0, sl1.index - __SW.anchorN); k < sl1.index; k++) if (!e || highs[k] > e.price) e = { index: k, price: highs[k] }; if (e && e.price > relevantHigh.price) relevantHigh = e; }\n        const range = relevantHigh.price - sl1.price;");
  }
  if (c.trueExt) {
    code = replaceExact(code, 'const range = sh1.price - relevantLow.price;',
      "{ const e = __ext('BUY', sh2.index, sh1.index); if (e && e.price < relevantLow.price) relevantLow = e; }\n        const range = sh1.price - relevantLow.price;");
    code = replaceExact(code, 'const range = relevantHigh.price - sl1.price;',
      "{ const e = __ext('SELL', sl2.index, sl1.index); if (e && e.price > relevantHigh.price) relevantHigh = e; }\n        const range = relevantHigh.price - sl1.price;");
  }
  return code;
}

// NAS: Qualität der Swing-Bewegung / Marktphase (Test 05.11.2026, Chop vermeiden). Alle Werte auf M15, ATR = ATR14 M15.
//   er        : Efficiency Ratio des Impulsbeins (relevantLow -> sh1): |Netto| / Summe |Schluss-Änderungen| >= er
//   chopMax   : Choppiness Index (chopN Kerzen, Default 14) <= chopMax
//   crossMax  : Kreuzungen Schluss / EMA50 in den letzten crossN Kerzen (Default 30) <= crossMax
//   slopeAtr  : EMA50-Steigung über 8 Kerzen in Trade-Richtung >= slopeAtr × ATR
//   sepAtr    : SMA50 auf der richtigen Seite der SMA200 und |SMA50 - SMA200| >= sepAtr × ATR
//   adxMin    : ADX14 (M15) >= adxMin
//   speedAtr  : Impulsbein-Range / Anzahl Kerzen >= speedAtr × ATR (Verdrängung)
export function nasQualityPatch(code, cfg) {
  const q = { er: null, chopMax: null, chopN: 14, crossMax: null, crossN: 30, slopeAtr: null, sepAtr: null, adxMin: null, speedAtr: null, ...cfg };
  code = code.replace(/try\s*\{/, (m) => `${m}\n  const __Q = ${JSON.stringify(q)};
  function __qOk(dir, a, b) {
    const H = highs, Lo = lows, C = closes, n = C.length;
    const tr = (k) => Math.max(H[k] - Lo[k], Math.abs(H[k] - C[k-1]), Math.abs(Lo[k] - C[k-1]));
    let atr = 0; for (let k = n - 14; k < n; k++) atr += tr(k); atr /= 14;
    const up = dir === 'BUY';
    if (__Q.er != null) { let path = 0; for (let k = a.index + 1; k <= b.index; k++) path += Math.abs(C[k] - C[k-1]);
      const net = Math.abs(C[b.index] - C[a.index]); if (!(path > 0 && net / path >= __Q.er)) return false; }
    if (__Q.speedAtr != null) { const bars = Math.max(1, b.index - a.index); if (Math.abs(b.price - a.price) / bars < __Q.speedAtr * atr) return false; }
    if (__Q.chopMax != null) { const N = __Q.chopN; let s = 0, hi = -Infinity, lo = Infinity;
      for (let k = n - N; k < n; k++) { s += tr(k); hi = Math.max(hi, H[k]); lo = Math.min(lo, Lo[k]); }
      const chop = 100 * Math.log10(s / (hi - lo)) / Math.log10(N); if (chop > __Q.chopMax) return false; }
    const ema = []; { const kk = 2 / 51; let e = C.slice(0, 50).reduce((x, y) => x + y, 0) / 50; for (let k = 0; k < n; k++) { if (k >= 50) e = C[k] * kk + e * (1 - kk); ema.push(e); } }
    if (__Q.crossMax != null) { let c = 0; for (let k = n - __Q.crossN + 1; k < n; k++) if (Math.sign(C[k] - ema[k]) !== Math.sign(C[k-1] - ema[k-1])) c++; if (c > __Q.crossMax) return false; }
    if (__Q.slopeAtr != null) { const sl = ema[n-1] - ema[n-9]; if ((up ? sl : -sl) < __Q.slopeAtr * atr) return false; }
    if (__Q.sepAtr != null) { const s50 = C.slice(-50).reduce((x, y) => x + y, 0) / 50, s200 = C.slice(-200).reduce((x, y) => x + y, 0) / Math.min(200, n);
      const d = up ? s50 - s200 : s200 - s50; if (d < __Q.sepAtr * atr) return false; }
    if (__Q.adxMin != null) { const P = 14; let trs = 0, pd = 0, md = 0; const dx = [];
      for (let k = 1; k < n; k++) { const t = tr(k), u = H[k] - H[k-1], d = Lo[k-1] - Lo[k]; const p = u > d && u > 0 ? u : 0, mm = d > u && d > 0 ? d : 0;
        if (k <= P) { trs += t; pd += p; md += mm; if (k < P) continue; } else { trs = trs - trs / P + t; pd = pd - pd / P + p; md = md - md / P + mm; }
        const pi = trs ? 100 * pd / trs : 0, mi = trs ? 100 * md / trs : 0; dx.push(pi + mi ? 100 * Math.abs(pi - mi) / (pi + mi) : 0); }
      let adx = dx.slice(0, P).reduce((x, y) => x + y, 0) / P; for (let k = P; k < dx.length; k++) adx = (adx * (P - 1) + dx[k]) / P;
      if (adx < __Q.adxMin) return false; }
    return true;
  }
`);
  const parts = code.split('if (range > RANGE_MIN) {');
  if (parts.length !== 3) throw new Error('Range-Bedingung nicht 2x gefunden');
  return parts[0] + "if (range > RANGE_MIN && __qOk('BUY', relevantLow, sh1)) {" + parts[1] + "if (range > RANGE_MIN && __qOk('SELL', relevantHigh, sl1)) {" + parts[2];
}

// NAS: Entry-Parameter weglassen/verändern (Test 05.11.2026)
export function nasEntryPatch(code, { consts = {}, noEma = false, noDistCheck = false, maMode = null } = {}) {
  for (const [k, v] of Object.entries(consts)) code = setConst(code, k, v);
  // maMode: 'sma50' = nur Fib-Level jenseits SMA50 prüfen, 'sma200' = nur Abstand zur SMA200 prüfen
  if (maMode === 'sma50') {
    code = replaceExact(code, '(fibLevel > sma50 && (fibLevel - sma200) > MA_DIST_MIN)', '(fibLevel > sma50)');
    code = replaceExact(code, '(fibLevel < sma50 && (sma200 - fibLevel) > MA_DIST_MIN)', '(fibLevel < sma50)');
  } else if (maMode === 'sma200') {
    code = replaceExact(code, '(fibLevel > sma50 && (fibLevel - sma200) > MA_DIST_MIN)', '((fibLevel - sma200) > MA_DIST_MIN)');
    code = replaceExact(code, '(fibLevel < sma50 && (sma200 - fibLevel) > MA_DIST_MIN)', '((sma200 - fibLevel) > MA_DIST_MIN)');
  }
  if (noEma) {
    code = replaceExact(code, 'if (emaBull) {', 'if (true) {');
    code = replaceExact(code, 'if (emaBear && signal === "NONE") {', 'if (signal === "NONE") {');
  }
  if (noDistCheck) code = replaceExact(code, 'distToFib > 0 && distToFib < range', 'distToFib > 0', 2);
  return code;
}

// Muster-Filter als Code-Patch (Test 04.11.2026, Übersicht out/live/muster-swing.html)
// NAS: keine Signale in der Berliner Stunde 15 (US-Eröffnung), optional kein Montag.
export function nasFilterPatch(code, { noHour15 = false, noMonday = false } = {}) {
  const at = 'if (utcDay === 0 || utcDay === 6) return [{json:{signal:"NONE",error:"Wochenende"}}];';
  let add = '';
  if (noHour15) add += `\n  { const __bh = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (__bh === 15) return [{json:{signal:"NONE",error:"Filter: keine Signale 15:00–15:59 Berlin (US-Eröffnung)"}}]; }`;
  if (noMonday) add += '\n  if (utcDay === 1) return [{json:{signal:"NONE",error:"Filter: kein Handel am Montag"}}];';
  return replaceExact(code, at, at + add);
}
// DE40 LVN: ADX-Mindestwert, kein Montag (Berlin), LVN mit Tal-Tiefe im Bereich lvnExcl auslassen.
export function deFilterPatch(code, { adxMin = null, noMonday = false, lvnExcl = null } = {}) {
  if (adxMin != null) {
    if (!/ADX_MIN:\s*\d+(\.\d+)?,/.test(code)) throw new Error('CONFIG.ADX_MIN nicht gefunden');
    code = code.replace(/ADX_MIN:\s*\d+(\.\d+)?,/, `ADX_MIN: ${adxMin},`);
  }
  if (noMonday) code = replaceExact(code, '  if (h1Trend === "NEUTRAL") {', '  if (nowBerlin.weekday === 1) return stopWithReason("FILTER_MONTAG", {});\n  if (h1Trend === "NEUTRAL") {');
  if (lvnExcl) code = replaceExact(code, 'const deep = inWindow.filter(z => z.depth < CONFIG.LVN_QUALITY_MAX)',
    `const deep = inWindow.filter(z => z.depth < CONFIG.LVN_QUALITY_MAX && !(z.depth >= ${lvnExcl[0]} && z.depth <= ${lvnExcl[1]}))`);
  return code;
}

// Strategie-Review FTMO (strategy-review/, ab 12.11.2026): Punkt-Schwellen proportional zum Kurs.
// RANGE_MIN, MA_DIST_MIN, SL_BUF, SL_MAX, SL_MIN gelten bei Kurs = ref unverändert, sonst × Kurs/ref (M15-Schluss).
export function nasPxScalePatch(code, { ref }) {
  code = replaceExact(code, "let signal = 'NONE', fibLevel = 0", `const __px = currentClose / ${ref};\n  let signal = 'NONE', fibLevel = 0`);
  code = replaceExact(code, 'range > RANGE_MIN', 'range > RANGE_MIN * __px', 2);
  code = replaceExact(code, '(fibLevel - sma200) > MA_DIST_MIN', '(fibLevel - sma200) > MA_DIST_MIN * __px');
  code = replaceExact(code, '(sma200 - fibLevel) > MA_DIST_MIN', '(sma200 - fibLevel) > MA_DIST_MIN * __px');
  code = replaceExact(code, 'relevantLow.price - SL_BUF', 'relevantLow.price - SL_BUF * __px');
  code = replaceExact(code, 'relevantHigh.price + SL_BUF', 'relevantHigh.price + SL_BUF * __px');
  code = replaceExact(code, 'if (slDistance > SL_MAX)', 'if (slDistance > SL_MAX * __px)');
  return replaceExact(code, 'if (slDistance < SL_MIN)', 'if (slDistance < SL_MIN * __px)');
}
// Review: keine Signale 15:00–15:59 Berlin (US-Eröffnung) im FTMO-Code (Fundstelle = Wochenend-Zeile mit botId).
export function ftmoHourPatch(code, { hours = [15] } = {}) {
  const at = "if (utcDay === 0 || utcDay === 6) return [{json:{signal:'NONE',error:'Wochenende',botId:BOT_ID}}];";
  return replaceExact(code, at, at + `\n  { const __bh = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (${JSON.stringify(hours)}.includes(__bh)) return [{json:{signal:'NONE',error:'Filter: keine Signale Berlin-Stunde ${hours.join('+')}',botId:BOT_ID}}]; }`);
}
// ---------------------------------------------------------------- Familien-Defaults
const NAS_FEAT = ['rr', 'h4Trend', 'trend', 'atrPct'];
const DE_FEAT = ['confluenceScore', 'adx', 'rr', 'lvnSource', 'phase', 'entryLVN.depth', 'h1Trend'];
const EU_FEAT = ['adx', 'atr', 'slPips'];
const EXITS_SWING = [
  { key: 'tp1', label: 'TP auf 1R vorziehen', tpR: 1 },
  { key: 'tp1.5', label: 'TP auf 1,5R vorziehen', tpR: 1.5 },
  { key: 'be1', label: 'SL auf Einstand ab +1R', beR: 1 },
  { key: 'be1.5', label: 'SL auf Einstand ab +1,5R', beR: 1.5 },
  { key: 'sl0.75', label: 'Engerer SL (0,75×)', stopMult: 0.75 },
];
const EXITS_EU = [
  { key: 'tp0.75', label: 'TP auf 0,75R vorziehen', tpR: 0.75 },
  { key: 'be0.5', label: 'SL auf Einstand ab +0,5R', beR: 0.5 },
  { key: 'be1', label: 'SL auf Einstand ab +1R', beR: 1 },
  { key: 'sl0.75', label: 'Engerer SL (0,75×)', stopMult: 0.75 },
];
const EXITS_DE = [...EXITS_SWING, { key: 't1730', label: 'Zeit-Exit 17:30 (kein Übernacht)', timeExitHm: '17:30' }];

const ENG_STD = { startBalance: 10000, riskPercent: 1, compounding: false };
const ENG_FTMO = { startBalance: 100000, riskPercent: 0.5, compounding: false };

const nas = (id, name, file, extra = {}) => ({ id, name, family: 'NAS', symbol: 'US100', group: extra.group || 'NAS100 Fib (Capital, live)', code: extra.code || read('capital/' + file), featureKeys: NAS_FEAT, exitVariants: EXITS_SWING, engine: ENG_STD, base: extra.base || null, desc: extra.desc || '', opts: extra.opts || {} });
const ftmo = (id, name, desc, mut = (c) => c, opts = {}, base = 'ftmo-basis') => ({ id, name, family: 'NAS_FTMO', symbol: 'US100', group: 'NAS100 F618ATR FTMO – Backtest-Auftrag', code: mut(read('ftmo/NAS_F618ATR_FTMO.js')), featureKeys: NAS_FEAT, exitVariants: EXITS_SWING, engine: ENG_FTMO, base: id === 'ftmo-basis' ? null : base, desc, opts: { ftmo: true, ...opts } });

export function buildCatalog() {
  const V = [];
  // ---- NAS100 live (d_ilikebigbots)
  V.push(nas('nas-fib50-lb2', 'NAS Fib50 LB2', 'NAS_Fib50_LB2.js', { desc: 'Fib 50 %/Ext 50 %, Lookback 2, MA-Filter an' }));
  V.push(nas('nas-fib50-lb3', 'NAS Fib50 LB3', 'NAS_Fib50_LB3.js', { desc: 'Fib 50 %, Lookback 3' }));
  V.push(nas('nas-fib61-lb1', 'NAS Fib61 LB1', 'NAS_Fib61_LB1.js', { desc: 'Fib 61,8 %, Lookback 1' }));
  V.push(nas('nas-fib61-lb2', 'NAS Fib61 LB2', 'NAS_Fib61_LB2.js', { desc: 'Fib 61,8 %, Lookback 2' }));
  V.push(nas('nas-fib61-lb3', 'NAS Fib61 LB3', 'NAS_Fib61_LB3.js', { desc: 'Fib 61,8 %, Lookback 3' }));
  V.push(nas('nas-f618atr', 'NAS F618ATR (Capital)', 'NAS_F618ATR.js', { desc: 'Fib61 LB1 + MA-Abstand 30 + ATR-Pause 1,6 %' }));
  // ---- NAS v5.0-Achsen aus dem Backtest-Projekt (Basis Fib61 LB2)
  const b = read('capital/NAS_Fib61_LB2.js');
  const g1 = 'NAS100 v5.0-Achsen (Basis Fib61 LB2)';
  V.push(nas('nas-lb2-h4on', 'LB2 + H4-Trendfilter', null, { group: g1, base: 'nas-fib61-lb2', code: setConst(b, 'USE_H4_TREND_FILTER', true), desc: 'H4-Trendfilter wieder an' }));
  V.push(nas('nas-lb2-maon', 'LB2 + MA-Abstand', null, { group: g1, base: 'nas-fib61-lb2', code: setConst(b, 'USE_MA_DISTANCE_FILTER', true), desc: 'SMA50/200-Abstandsfilter an' }));
  V.push(nas('nas-lb2-fri', 'LB2 + Freitag-Filter', null, { group: g1, base: 'nas-fib61-lb2', code: setConst(b, 'USE_FRIDAY_FILTER', true), desc: 'keine neuen Orders Fr ab 16 UTC' }));
  // ---- F618ATR: ATR-Schwelle (vergleich_atr)
  const a = read('capital/NAS_F618ATR.js');
  const g2 = 'NAS100 F618ATR ATR-Schwelle (Capital)';
  V.push(nas('nas-atr-off', 'F618ATR ohne ATR-Pause', null, { group: g2, base: 'nas-f618atr', code: setConst(a, 'USE_ATR_FILTER', false) }));
  for (const t of [1.2, 1.4, 1.8, 2.0]) V.push(nas(`nas-atr-${t}`, `F618ATR ATR ≥ ${t} %`, null, { group: g2, base: 'nas-f618atr', code: setConst(a, 'ATR_MIN_PCT', t) }));
  // ---- FTMO-Basis + Backtest-Auftrag
  V.push(ftmo('ftmo-basis', 'FTMO-Basis (v5.0-F618ATR-FTMO)', 'Live-Code d_ftmo, nur abgeschlossene Kerzen, Fr-Filter, Fr 20:30 glattstellen, 0,5 % fix'));
  V.push(ftmo('ftmo-v1-cancel', 'V1 Lösch-Regel ohne Signal', 'Order löschen sobald Kurs über sh1/unter sl1', (c) => c, { cancelWithoutSignal: true }));
  for (const p of [0.2, 0.25, 0.3]) V.push(ftmo(`ftmo-v2-p${p}`, `V2 Ausbruch ≥ ${p} × Range`, 'sl2−sl1 bzw. sh1−sh2 ≥ P × Range', (c) => nasSetupPatch(c, { breakoutP: p })));
  V.push(ftmo('ftmo-v3-fresh', 'V3 Setup noch frisch', 'kein neues Extrem seit sl1/sh1', (c) => nasSetupPatch(c, { fresh: true })));
  for (const k of [2, 3, 4]) V.push(ftmo(`ftmo-v4-k${k}`, `V4 Range ≥ ${k} × ATR(M15)`, 'statt Range > 50', (c) => nasSetupPatch(c, { rangeK: k })));
  for (const rr of [0.38, 0.5]) V.push(ftmo(`ftmo-v5-r${rr}`, `V5 Impulswelle ≤ ${rr}`, 'kein Zwischenhoch > R × Bewegung', (c) => nasSetupPatch(c, { cleanR: rr })));
  for (const m of [60, 100, 120]) V.push(ftmo(`ftmo-slmax${m}`, `SL_MAX ${m} (Plateau-Check)`, `Konstante SL_MAX 200 -> ${m} Punkte`, (c) => setConst(c, 'SL_MAX', m)));
  V.push(ftmo('ftmo-slmax80', 'SL_MAX 80 (aus Muster-Analyse)', 'Konstante SL_MAX 200 -> 80 Punkte im Code', (c) => setConst(c, 'SL_MAX', 80)));
  for (const lb of [2, 3, 4]) V.push(ftmo(`ftmo-v6-lb${lb}`, `V6 Lookback ${lb}`, 'Swing-Lookback M15', (c) => setLookback(c, lb, 1)));
  // ---- DE40 LVN (d_ilikebigbots)
  const de = (id, name, file, desc) => ({ id, name, family: 'DE40', symbol: 'DE40', group: 'DE40 LVN v3.4 (Capital, live)', code: read('capital/' + file), featureKeys: DE_FEAT, exitVariants: EXITS_DE, engine: ENG_STD, base: id === 'de40-basis' ? null : 'de40-basis', desc, opts: {} });
  V.push(de('de40-basis', 'DE40 LVN Basis (loose)', 'DE40_Basis.js', 'ADX aus, Distanz 5–100, Qualität 0,5, Confluence 2, Mittag an'));
  V.push(de('de40-confl3', 'DE40 Confluence 3', 'DE40_Confluence_3.js', 'ADX 20, Distanz 15–100, Confluence 3, Mittag aus'));
  V.push(de('de40-dist150', 'DE40 Distance 150', 'DE40_Distance_150.js', 'ADX 20, Distanz 15–150, Mittag aus'));
  V.push(de('de40-q07', 'DE40 Quality 0.7', 'DE40_Quality_0_7.js', 'ADX 20, Distanz 15–100, Qualität 0,7, Mittag aus'));
  V.push(de('de40-adx25', 'DE40 ADX 25', 'DE40_ADX_25.js', 'ADX 25, Distanz 15–100, Mittag aus'));
  V.push(de('de40-combo', 'DE40 Combo', 'DE40_Combo.js', 'ADX 20, Distanz 15–150, Confluence 3, Mittag an'));
  // ---- EURUSD v3.0 (d_ilikebigbots)
  const eu = (id, name, file, desc) => ({ id, name, family: 'EURUSD', symbol: 'EURUSD', pip: 0.0001, group: 'EURUSD v3.0 C1–C6 (Capital, live)', code: read('capital/' + file), featureKeys: EU_FEAT, exitVariants: EXITS_EU, engine: { ...ENG_STD, pointValue: 1 }, base: id === 'eu-c1' ? null : 'eu-c1', desc, opts: {} });
  V.push(eu('eu-c1', 'EURUSD C1 Legacy TP1', 'EURUSD_C1.js', 'LEGACY, Market, TP 1R, SL 2×ATR'));
  V.push(eu('eu-c2', 'EURUSD C2 Pullback TP1', 'EURUSD_C2.js', 'EMA-Pullback, Market, TP 1R, SL 1,5×ATR'));
  V.push(eu('eu-c3', 'EURUSD C3 Pullback TP1.5', 'EURUSD_C3.js', 'EMA-Pullback, Market, TP 1,5R'));
  V.push(eu('eu-c4', 'EURUSD C4 Break&Retest Market TP1.5', 'EURUSD_C4.js', 'Break & Retest, Market, TP 1,5R'));
  V.push(eu('eu-c5', 'EURUSD C5 Break&Retest Limit TP1.5', 'EURUSD_C5.js', 'Break & Retest, Limit in FVG-Mitte, TP 1,5R'));
  V.push(eu('eu-c6', 'EURUSD C6 Break&Retest Market TP1', 'EURUSD_C6.js', 'Break & Retest, Market, TP 1R'));
  // ---- EURUSD Test: Sweep -> BOS -> FVG -> Pullback Fib 0,618–0,75 (Basis: C4, gleiches Template)
  const sbf = (id, name, desc, cfg) => ({ ...eu(id, name, 'EURUSD_C4.js', desc), group: 'EURUSD Sweep→BOS→FVG→Fib (Test)', base: 'eu-c4',
    code: euSweepPatch(read('capital/EURUSD_C4.js'), cfg), featureKeys: [...EU_FEAT, 'sbfFib', 'sbfBosMin', 'sbfAgeMin', 'sbfRangePips'] });
  V.push(sbf('eu-sbf', 'EURUSD Sweep→BOS→FVG Fib 0,618–0,75 TP1.5', 'H1/M15-Trend wie Template, Market im Fib-Pullback, TP 1,5R', { botId: 'EUSBF' }));
  V.push(sbf('eu-sbf-nobias', 'EURUSD Sweep→BOS→FVG ohne Trendfilter TP1.5', 'wie eu-sbf, aber Richtung nur aus der Sequenz (kein H1/M15-Trend)', { botId: 'EUSBFNB', useBias: false }));
  V.push(sbf('eu-sbf-fib0', 'EURUSD Sweep→BOS→FVG TP am Impuls-Extrem', 'wie eu-sbf, TP = Fib 0 (Hoch/Tief des Impulses)', { botId: 'EUSBFF0', tpMode: 'FIB0' }));
  V.push(sbf('eu-sbf-tp075', 'EURUSD Sweep→BOS→FVG TP0.75', 'wie eu-sbf, TP 0,75R (aus Ausstiegs-Analyse von eu-sbf)', { botId: 'EUSBF075', tpR: 0.75 }));
  // ---- EURUSD Muster-Filter: kein Handel Mi + Fr, optional ADX 30–35 aus (Basis = jeweilige Variante)
  const gMF = 'EURUSD Muster-Filter Mi/Fr + ADX (Test)';
  const mf = (id, baseId, name, cfg) => {
    const b = V.find((x) => x.id === baseId);
    const desc = `${b.name}: ${cfg.noMiFr ? 'kein Handel Mi + Fr (UTC)' : ''}${cfg.noAdx3035 ? ', kein Einstieg bei ADX(M15) 30–35' : ''}`;
    return { ...b, id, name, group: gMF, base: baseId, desc, code: euDayAdxPatch(b.code, cfg) };
  };
  V.push(mf('eu-c3-mifr', 'eu-c3', 'C3 ohne Mi+Fr', { noMiFr: true }));
  V.push(mf('eu-c3-mifr-adx', 'eu-c3', 'C3 ohne Mi+Fr, ohne ADX 30–35', { noMiFr: true, noAdx3035: true }));
  V.push(mf('eu-c4-mifr-adx', 'eu-c4', 'C4 ohne Mi+Fr, ohne ADX 30–35', { noMiFr: true, noAdx3035: true }));
  V.push(mf('eu-c5-mifr-adx', 'eu-c5', 'C5 ohne Mi+Fr, ohne ADX 30–35', { noMiFr: true, noAdx3035: true }));
  V.push(mf('eu-c6-mifr-adx', 'eu-c6', 'C6 ohne Mi+Fr, ohne ADX 30–35', { noMiFr: true, noAdx3035: true }));
  V.push(mf('eu-sbf-mifr-adx', 'eu-sbf', 'Sweep→BOS→FVG TP1.5 ohne Mi+Fr, ohne ADX 30–35', { noMiFr: true, noAdx3035: true }));
  V.push(mf('eu-sbf-tp075-mifr', 'eu-sbf-tp075', 'Sweep→BOS→FVG TP0.75 ohne Mi+Fr', { noMiFr: true }));
  // ---- DE40 LVN Muster-Filter: ADX ≥ 30 + kein Montag + LVN-Tiefe nicht 0,20–0,35 (alle 6), ADX 30 allein (Basis, Dist150)
  const gDE = 'DE40 LVN Muster-Filter (Test)';
  const DEN = { 'de40-basis': 'Basis', 'de40-confl3': 'Confluence 3', 'de40-dist150': 'Distance 150', 'de40-q07': 'Quality 0.7', 'de40-adx25': 'ADX 25', 'de40-combo': 'Combo' };
  for (const [bid, nm] of Object.entries(DEN)) {
    const b = V.find((x) => x.id === bid);
    V.push({ ...b, id: `${bid}-mf`, name: `LVN ${nm}: ADX ≥ 30, ohne Mo, LVN-Tiefe`, group: gDE, base: bid,
      desc: `${b.name} + ADX_MIN 30, kein Montag, LVN-Tiefe nicht 0,20–0,35`, code: deFilterPatch(b.code, { adxMin: 30, noMonday: true, lvnExcl: [0.2, 0.35] }) });
  }
  for (const bid of ['de40-basis', 'de40-dist150']) {
    const b = V.find((x) => x.id === bid);
    V.push({ ...b, id: `${bid}-adx30`, name: `LVN ${DEN[bid]}: ADX ≥ 30`, group: gDE, base: bid, desc: `${b.name} + ADX_MIN 30`, code: deFilterPatch(b.code, { adxMin: 30 }) });
  }
  // ---- NAS Muster + Swing: F618ATR und Fib50 LB2 (Gap-Filter bewusst NICHT: Merkmal enthält für Signale vor 15:30 Lookahead)
  const gNM = 'NAS Muster + Swing (Test)';
  const f618 = V.find((x) => x.id === 'nas-f618atr'), f50 = V.find((x) => x.id === 'nas-fib50-lb2');
  const nm = (id, b, name, desc, code) => ({ ...b, id, name, group: gNM, base: b.id, desc, code });
  V.push(nm('nas-f618-h15', f618, 'F618ATR ohne 15 Uhr', 'keine Signale 15:00–15:59 Berlin', nasFilterPatch(f618.code, { noHour15: true })));
  V.push(nm('nas-f618-bosext', f618, 'F618ATR BOS + echtes Extrem', 'Swing: BOS per Schlusskurs, Fib-Anker = echtes Extrem', nasSwingPatch(f618.code, { bosClose: true, trueExt: true }, 1)));
  V.push(nm('nas-f618-l2r1ext', f618, 'F618ATR Fraktal L2/R1 + echtes Extrem', 'Swing: Fraktal 2 links / 1 rechts, Fib-Anker = echtes Extrem', nasSwingPatch(f618.code, { method: { type: 'fractal', L: 2, R: 1 }, trueExt: true }, 1)));
  V.push(nm('nas-f618-l2r1ext-h15', f618, 'F618ATR L2/R1 + Extrem, ohne 15 Uhr', 'Swing L2/R1 + echtes Extrem, keine Signale 15 Uhr',
    nasFilterPatch(nasSwingPatch(f618.code, { method: { type: 'fractal', L: 2, R: 1 }, trueExt: true }, 1), { noHour15: true })));
  V.push(nm('nas-f50lb2-h15mo', f50, 'Fib50 LB2 ohne 15 Uhr, ohne Mo', 'keine Signale 15 Uhr, kein Montag', nasFilterPatch(f50.code, { noHour15: true, noMonday: true })));
  // ---- NAS Chop-Filter (05.11.2026): MA-Regel „Fib-Level jenseits SMA50 + SMA200“ (MA-Filter an, Abstand 0) + beste Kombi je Bot
  const gCH = 'NAS Chop-Filter (Test)';
  const ma0 = (c) => nasEntryPatch(c, { consts: { USE_MA_DISTANCE_FILTER: true, MA_DIST_MIN: 0 } });
  const NASN = { 'nas-f618atr': ['f618', 'F618ATR'], 'nas-fib50-lb2': ['f50lb2', 'Fib50 LB2'], 'nas-fib50-lb3': ['f50lb3', 'Fib50 LB3'],
    'nas-fib61-lb1': ['f61lb1', 'Fib61 LB1'], 'nas-fib61-lb2': ['f61lb2', 'Fib61 LB2'], 'nas-fib61-lb3': ['f61lb3', 'Fib61 LB3'] };
  const ch = (bid, suf, label, desc, fn) => { const b = V.find((x) => x.id === bid);
    V.push({ ...b, id: `nas-${NASN[bid][0]}-${suf}`, name: `${NASN[bid][1]}: ${label}`, group: gCH, base: bid, desc, code: fn(b.code) }); };
  for (const bid of Object.keys(NASN)) ch(bid, 'ma0', 'MA-Regel (Fib jenseits SMA50+200)', 'USE_MA_DISTANCE_FILTER an, MA_DIST_MIN 0', ma0);
  ch('nas-f618atr', 'ma0-er04', 'MA-Regel + Effizienz ≥ 0,4', 'MA-Regel + Efficiency Ratio des Impulsbeins ≥ 0,4', (c) => nasQualityPatch(ma0(c), { er: 0.4 }));
  ch('nas-f618atr', 'ma0-h15', 'MA-Regel + ohne 15 Uhr', 'MA-Regel + keine Signale 15:00–15:59 Berlin', (c) => nasFilterPatch(ma0(c), { noHour15: true }));
  ch('nas-f618atr', 'ma0-x6', 'MA-Regel + EMA50-Kreuzungen ≤ 6', 'MA-Regel + max. 6 Kreuzungen Schluss/EMA50 in 30 M15-Kerzen', (c) => nasQualityPatch(ma0(c), { crossMax: 6 }));
  ch('nas-fib61-lb1', 'ma0-h15', 'MA-Regel + ohne 15 Uhr', 'MA-Regel + keine Signale 15:00–15:59 Berlin', (c) => nasFilterPatch(ma0(c), { noHour15: true }));
  ch('nas-fib50-lb2', 'ma0-h15', 'MA-Regel + ohne 15 Uhr', 'MA-Regel + keine Signale 15:00–15:59 Berlin', (c) => nasFilterPatch(ma0(c), { noHour15: true }));
  ch('nas-fib50-lb3', 'ma0-chop60', 'MA-Regel + CHOP ≤ 60', 'MA-Regel + Choppiness Index (14 M15) ≤ 60', (c) => nasQualityPatch(ma0(c), { chopMax: 60 }));
  ch('nas-fib61-lb2', 'ma0-chop60', 'MA-Regel + CHOP ≤ 60', 'MA-Regel + Choppiness Index (14 M15) ≤ 60', (c) => nasQualityPatch(ma0(c), { chopMax: 60 }));
  ch('nas-fib61-lb3', 'ma0-x6', 'MA-Regel + EMA50-Kreuzungen ≤ 6', 'MA-Regel + max. 6 Kreuzungen Schluss/EMA50 in 30 M15-Kerzen', (c) => nasQualityPatch(ma0(c), { crossMax: 6 }));
  // ---- NAS: Swing-Methoden auf F618ATR (Lookback 1) und Fib61 LB2
  const SW_NAS = [
    ['zz1', 'Zigzag 1,0×ATR', { method: { type: 'zigzag', k: 1 } }],
    ['zz15', 'Zigzag 1,5×ATR', { method: { type: 'zigzag', k: 1.5 } }],
    ['zz2', 'Zigzag 2,0×ATR', { method: { type: 'zigzag', k: 2 } }],
    ['zz3', 'Zigzag 3,0×ATR', { method: { type: 'zigzag', k: 3 } }],
    ['l3r1', 'Fraktal links 3 / rechts 1', { method: { type: 'fractal', L: 3, R: 1 } }],
    ['l5r2', 'Fraktal links 5 / rechts 2', { method: { type: 'fractal', L: 5, R: 2 } }],
    ['bos', 'BOS per Schlusskurs', { bosClose: true }],
    ['ext', 'Echtes Extrem als Fib-Anker', { trueExt: true }],
  ];
  for (const [bid, short, lb] of [['nas-f618atr', 'f618', 1], ['nas-fib61-lb2', 'lb2', 2]]) {
    const b = V.find((x) => x.id === bid);
    for (const [k, label, cfg] of SW_NAS) {
      V.push({ ...b, id: `nas-sw-${short}-${k}`, name: `${short === 'f618' ? 'F618ATR' : 'Fib61 LB2'}: ${label}`, group: 'NAS Swing-Methoden (Test)',
        base: bid, desc: `${b.name}, Swing-Erkennung: ${label}`, code: nasSwingPatch(b.code, cfg, lb) });
    }
  }
  // ---- Strategie-Review FTMO (strategy-review/experiments.jsonl)
  const RV = 'FTMO Strategie-Review';
  for (const ref of [16000, 20000, 25000]) V.push({ ...ftmo(`ftmo-rv-px${ref / 1000}k`, `Review: Punkt-Schwellen × Kurs/${ref}`, `RANGE_MIN, MA_DIST_MIN, SL_BUF, SL_MAX, SL_MIN proportional zum Kurs (Referenz ${ref})`, (c) => nasPxScalePatch(c, { ref })), group: RV });
  V.push({ ...ftmo('ftmo-rv-h15', 'Review: ohne 15 Uhr Berlin', 'keine Signale 15:00–15:59 Berlin (US-Eröffnung)', (c) => ftmoHourPatch(c, { hours: [15] })), group: RV });
  V.push({ ...ftmo('ftmo-rv-h1415', 'Review: ohne 14+15 Uhr Berlin', 'Plateau-Nachbar: keine Signale 14:00–15:59 Berlin', (c) => ftmoHourPatch(c, { hours: [14, 15] })), group: RV });
  V.push({ ...ftmo('ftmo-rv-h1516', 'Review: ohne 15+16 Uhr Berlin', 'Plateau-Nachbar: keine Signale 15:00–16:59 Berlin', (c) => ftmoHourPatch(c, { hours: [15, 16] })), group: RV });
  return V;
}

export function comboVariant(base, cfg, opts, id, name) {
  const v = buildCatalog().find((x) => x.id === base);
  let code = v.code;
  if (cfg.lookback) code = setLookback(code, cfg.lookback, 1);
  const setup = { breakoutP: cfg.breakoutP ?? null, fresh: !!cfg.fresh, rangeK: cfg.rangeK ?? null, cleanR: cfg.cleanR ?? null };
  if (Object.values(setup).some((x) => x)) code = nasSetupPatch(code, setup);
  return { ...v, id, name, code, base, desc: JSON.stringify({ ...cfg, ...opts }), opts: { ...v.opts, ...opts } };
}
