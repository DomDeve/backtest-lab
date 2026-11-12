#!/usr/bin/env node
// Kandidaten K1/K2/K5 auf allen Epics mit Kursdaten rechnen (Auftrag 07.11.2026).
//   node bin/k2k5.js            -> out/kandidaten/k2k5/runs/<session>.json, quality.json, config/epics.json (Stammdaten)
// Auswertung danach: python3 tools/k2k5_report.py
import fs from 'node:fs';
import path from 'node:path';
import { loadBars } from '../src/data/load.js';
import { cleanBars } from '../src/data/clean.js';
import { cleanSession, loadSessions, epicSession } from '../src/core/sessions.js';
import { local } from '../src/core/time.js';
import { prepare, sessionDays, k2Context, runK1, runK2, runK5 } from '../src/candidates/k2k5.js';

const CFG = JSON.parse(fs.readFileSync('config/kandidaten_k2k5.json', 'utf8'));
const KOST = JSON.parse(fs.readFileSync('config/kosten.json', 'utf8'));
const OUT = 'out/kandidaten/k2k5';
fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true });
const S = loadSessions();
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// ---------------------------------------------------------------- Epic-Universum = alle Epics mit Kursdaten
const dataDir = (k) => [S.epics[k].data, `data/raw/${k.toLowerCase()}`].find((d) => d && fs.existsSync(d) && fs.readdirSync(d).some((f) => /MINUTE_5_.*\.csv$/.test(f)));
const epics = Object.keys(S.epics).filter((k) => dataDir(k));
// Sessions je Asset-Klasse (Auftrag 07.11.2026); explizite Einträge aus config/kandidaten_k2k5.json haben Vorrang
function sessionDefs(epic) {
  const e = S.epics[epic], cls = e.asset_class, defs = CFG.sessions.filter((x) => x.epic === epic);
  if (defs.length) return defs;
  const out = [];
  for (const name of Object.keys(e.sessions)) out.push({ id: Object.keys(e.sessions).length > 1 ? `${epic}-${name}` : epic, epic, session: name });
  if (cls === 'metal' || cls === 'energy') {
    out[0].close_local = '14:30';
    out.push({ id: `${epic}-LON0800`, epic, session: Object.keys(e.sessions)[0], open_local: '08:00', tz: 'Europe/London', close_local: '14:30', closeTz: 'America/New_York', label: `${epic} London-Open 08:00 (Variante)` });
  }
  if (cls === 'crypto') { out[0].label = `${epic} 00:00 UTC (keine echte Eröffnung)`; out[0].close_local = '23:55'; out.push({ id: `${epic}-LON0800`, epic, session: Object.keys(e.sessions)[0], open_local: '08:00', tz: 'Europe/London', fx: true, label: `${epic} 08:00 London (Variante)` }); }
  return out;
}
const withEnd = (sd) => ({ ...sd, ...(S.epics[sd.epic].asset_class === 'fx' || sd.fx ? { fxEndHours: CFG.fx_end_hours, fxEndLatestBerlin: CFG.fx_end_latest_berlin } : {}) });
const FTMO = { DE40: 'GER40.cash', US100: 'US100.cash', EURUSD: 'EURUSD', US500: 'US500.cash', US30: 'US30.cash', UK100: 'UK100.cash', EU50: 'EU50.cash', FR40: 'FRA40.cash', J225: 'JP225.cash', AU200: 'AUS200.cash', HK50: 'HK50.cash', GBPUSD: 'GBPUSD', USDJPY: 'USDJPY', GOLD: 'XAUUSD', SILVER: 'XAGUSD', OIL_CRUDE: 'USOIL.cash', BTCUSD: 'BTCUSD', ETHUSD: 'ETHUSD' };
const data = {}, quality = {}, stamm = {};
for (const epic of epics) {
  const dir = dataDir(epic);
  const files = fs.readdirSync(dir).filter((f) => /MINUTE_5_.*\.csv$/.test(f)).map((f) => path.join(dir, f));
  const c = cleanBars(loadBars(files).bars, { session: cleanSession(epic), asDelivered: true });
  const P = prepare(c.bars);
  data[epic] = P;
  // Datenqualität: Monate, fehlende Kerzen in den Session-Fenstern aller Sessions dieses Epics
  const first = c.bars[0].t, last = c.bars.at(-1).t;
  const months = (last - first) / (30.44 * 86400000);
  const miss = {};
  for (const sd of sessionDefs(epic)) {
    const days = sessionDays(P, withEnd(sd));
    const exp = days.reduce((s, d) => s + d.expected, 0), have = days.reduce((s, d) => s + Math.min(d.have, d.expected), 0);
    miss[sd.id] = { days: days.length, missing_pct: Math.round((1 - have / exp) * 10000) / 100 };
  }
  const worst = Math.max(...Object.values(miss).map((m) => m.missing_pct));
  const ok = months >= CFG.quality.min_months && worst <= CFG.quality.max_missing_pct;
  quality[epic] = { from: new Date(first).toISOString().slice(0, 10), to: new Date(last).toISOString().slice(0, 10), months: Math.round(months * 10) / 10, sessions: miss,
    ok, reason: ok ? null : months < CFG.quality.min_months ? `nur ${months.toFixed(1)} Monate` : `${worst} % fehlende Kerzen im Session-Fenster`, clean: c.report.dropped };
  // Stammdaten (berechnet bzw. Annahmen – API-Werte folgen mit tools/capital_hours.py)
  const sp = {};
  for (const b of c.bars) { const h = local(b.t, 'UTC').hm.slice(0, 2); (sp[h] ||= []).push(b.ac - b.bc); }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const e = S.epics[epic], ms = epicSession(epic);
  stamm[epic] = {
    asset_class: e.asset_class, reference_exchange: e.reference_exchange, tz: ms.tz, sessions: e.sessions, ftmo_symbol: FTMO[epic] || null,
    point_value_per_lot: KOST[epic]?.point_value_per_lot ?? null, min_size: null, swap_pts_per_night: KOST[epic]?.swap_pts_per_night ?? null, commission_per_lot: KOST[epic]?.commission_per_lot ?? null,
    slippage_assumed: CFG.slippage[epic] ?? '0,25 × Median-Spread der Session', spread_median_by_hour_utc: Object.fromEntries(Object.entries(sp).sort().map(([h, a]) => [h, Math.round(med(a) * 1e5) / 1e5])),
    source: 'Kursdaten (Spread), config/kosten.json (Swap/Kommission = Annahme 0), Min-Size/Punktwert über API noch offen',
  };
}
fs.writeFileSync(path.join(OUT, 'quality.json'), JSON.stringify(quality, null, 1));
fs.writeFileSync('config/epics.json', JSON.stringify({ _hinweis: 'Stammdaten je Epic (bin/k2k5.js). FTMO-Symbole laut FTMO-Instrumentliste (Annahme, nicht über API geprüft).', created: new Date().toISOString().slice(0, 10), epics: stamm }, null, 1));
for (const [k, q] of Object.entries(quality)) console.log(`${k.padEnd(8)} ${q.from} → ${q.to} ${q.months} Mon. ${q.ok ? 'OK' : 'AUSGESCHLOSSEN: ' + q.reason}  ${JSON.stringify(q.sessions)}`);

// ---------------------------------------------------------------- Varianten
const K2 = [];
for (const orMin of [15, 30]) for (const tf of ['M5', 'M15']) for (const tol of [0.1, 0.2]) for (const tgt of [1.5, 2, 3]) for (const be of [false, true]) for (const fade of [false, true])
  K2.push({ id: `K2|or${orMin}|${tf}|tol${tol}|${tgt}R|be${+be}|fade${+fade}`, orMin, tf, tol, tgt, be, fade });
const K5MAIN = { ema: [9, 11, 21], stop: [1.5, 2] };
const K5 = [];
for (const anchor of ['session', 'midnight']) for (const tf of ['M5', 'M15']) for (const tgt of [null, 2]) for (const side of [0, 1, -1]) for (const flat of [false, true])
  for (const ema of [7, 9, 11, 15, 21]) for (const stopAtr of [1, 1.5, 2, 2.5, 3])
    K5.push({ id: `K5|${anchor}|${tf}|ema${ema}|stop${stopAtr}|${tgt ? tgt + 'R' : 'exitCross'}|${side === 0 ? 'beide' : side > 0 ? 'long' : 'short'}|flat${+flat}`, anchor, tf, ema, stopAtr, tgt, side, flat,
      main: K5MAIN.ema.includes(ema) && K5MAIN.stop.includes(stopAtr) });

// Slippage: Vorgabe je Epic, sonst 0,25 × Median-Spread in den Session-Fenstern (Annahme)
function slipOf(epic, days, P) {
  if (CFG.slippage[epic] !== undefined) return CFG.slippage[epic];
  const sp = [];
  for (const d of days) for (let i = d.i0; i <= d.i1; i++) sp.push(P.bars[i].ao - P.bars[i].bo);
  sp.sort((a, b) => a - b);
  return 0.25 * (sp[Math.floor(sp.length / 2)] || 0);
}
const summ = (tr, cut) => { const all = tr.map((t) => t[3]); const oos = tr.filter((t) => t[0] >= cut).map((t) => t[3]); const m = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null); return { n: all.length, exp: m(all), n_oos: oos.length, exp_oos: m(oos) }; };

for (const sd0 of epics.flatMap(sessionDefs)) {
  if (only.length && !only.includes(sd0.id)) continue;
  const epic = sd0.epic, P = data[epic];
  if (!P) { console.log(sd0.id, 'keine Daten'); continue; }
  const sd = withEnd(sd0);
  const days = sessionDays(P, sd);
  if (days.length < 100) { console.log(sd.id, 'zu wenige Tage', days.length); continue; }
  const cut = days[Math.floor(days.length * 0.7)].date;
  const slip = slipOf(epic, days, P);
  const t0 = Date.now();
  const res = { id: sd.id, epic, label: sd.label || `${epic} ${sd.session}`, asset_class: S.epics[epic].asset_class, ftmo: FTMO[epic] || null, cut, days: days.map((d) => d.date), slip,
    open_local: sd.open_local || epicSession(epic, sd.session).open_local, tz: sd.tz || epicSession(epic, sd.session).tz,
    fields: ['date', 'entryT', 'dir', 'rNet', 'rGross', 'maeR', 'why', 'exitT', 'f1', 'f2', 'f3', 'f4', 'f5', 'fade'], variants: {}, grid: {} };
  const ctx = { 15: k2Context(P, days, 15), 30: k2Context(P, days, 30) };
  for (const orMin of [15, 30]) res.variants[`K1|or${orMin}`] = { strategy: 'K1', params: { orMin, tgt: 1.5 }, trades: runK1(P, days, ctx[orMin].ors, { slip, tgt: 1.5 }) };
  for (const v of K2) res.variants[v.id] = { strategy: 'K2', params: v, trades: runK2(P, days, ctx[v.orMin], v, slip) };
  for (const v of K5) {
    const tr = runK5(P, days, v, slip);
    res.grid[v.id] = summ(tr, cut);
    if (v.main) res.variants[v.id] = { strategy: 'K5', params: v, trades: tr };
  }
  fs.writeFileSync(path.join(OUT, 'runs', `${sd.id}.json`), JSON.stringify(res));
  const k1 = res.variants['K1|or15'].trades;
  console.log(`${sd.id.padEnd(16)} Tage ${days.length} (OOS ab ${cut}), K1 ${k1.length} Tr., K2 ${K2.length} Var., K5 ${K5.length} Gitter (${Object.values(res.variants).filter((x) => x.strategy === 'K5').length} Haupt) – ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
