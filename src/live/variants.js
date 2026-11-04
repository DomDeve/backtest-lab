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
