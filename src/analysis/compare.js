// Abgleich Backtest vs. Live-Trades. Erst wenn das deckungsgleich ist, ist der Backtest vertrauenswürdig.
//
// Unterstützte Live-Formate:
//   * ft_trades (Forward-Test-Tabelle): Datum, Strategie, Status, Richtung, Signal_hm, Einstieg_hm, Ausstieg_Grund, Ausstieg_hm, ...
//   * d_tradelog: bot, direction, entry_price, exit_price, opened_at, closed_at, stop_loss, take_profit, pl_money
//   * trades (Live-Bots): Strategie, Richtung, Einstiegspreis, Ausstiegspreis, Time, Exit_Zeit_UTC, stopLevel, Exit_Grund
// Datei: JSON (Array oder {rows|data}) oder CSV.

import fs from 'node:fs';
import { local } from '../core/time.js';
import { parseTime } from '../data/load.js';
import { mean, round } from './stats.js';

function readRows(file) {
  const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (/\.csv$/i.test(file)) {
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const sep = lines[0].includes(';') ? ';' : ',';
    const head = lines[0].split(sep).map((h) => h.replace(/^"|"$/g, ''));
    return lines.slice(1).map((l) => Object.fromEntries(l.split(sep).map((c, i) => [head[i], c.replace(/^"|"$/g, '')])));
  }
  const j = JSON.parse(txt);
  return Array.isArray(j) ? j : j.rows || j.data || [];
}

const floor5 = (hm) => `${hm.slice(0, 3)}${String(Math.floor(Number(hm.slice(3)) / 5) * 5).padStart(2, '0')}`;
const nrm = (s) => (s == null ? null : String(s).toUpperCase());
const normReason = (r) => {
  const s = nrm(r) || '';
  if (s.startsWith('SL')) return 'SL';
  if (s.startsWith('TP')) return 'TP';
  if (s.includes('1730') || s.includes('TIME') || s.includes('EOD')) return '1730';
  return s;
};

/** Live-Zeilen in ein einheitliches Format bringen */
export function normalizeLive(rows, { tz = 'Europe/Berlin', strategyName } = {}) {
  const out = [];
  for (const r of rows) {
    if ('Datum' in r && 'Strategie' in r) { // ft_trades
      if (!['OPEN', 'CLOSED'].includes(r.Status)) { out.push({ date: r.Datum, strategy: r.Strategie, status: r.Status, raw: r }); continue; }
      out.push({
        date: r.Datum, strategy: r.Strategie, status: r.Status, dir: nrm(r.Richtung), signalHm: r.Signal_hm, entryHm: r.Einstieg_hm,
        entry: Number(r.Einstiegspreis), stop: Number(r.SL), exit: Number(r.Ausstiegspreis), exitHm: r.Ausstieg_hm,
        reason: normReason(r.Ausstieg_Grund), R: Number(r.PnL_R), pts: Number(r.PnL_Pkt), slippage: Number(r.Slippage_Pkt), raw: r,
      });
    } else if ('opened_at' in r || 'entry_price' in r) { // d_tradelog
      const to = parseTime(r.opened_at), tc = parseTime(r.closed_at);
      if (!Number.isFinite(to)) continue;
      const lo = local(to, tz), lc = Number.isFinite(tc) ? local(tc, tz) : null;
      const e = Number(r.entry_price), x = Number(r.exit_price), sl = Number(r.stop_loss);
      const sg = nrm(r.direction) === 'BUY' ? 1 : -1;
      out.push({
        date: lo.date, strategy: r.bot, status: lc ? 'CLOSED' : 'OPEN', dir: nrm(r.direction), entryHm: floor5(lo.hm), entry: e, stop: sl,
        exit: x, exitHm: lc ? floor5(lc.hm) : null, reason: null, R: sl && e !== sl && x ? ((x - e) * sg) / Math.abs(e - sl) : NaN, raw: r,
      });
    } else if ('Einstiegspreis' in r && ('Time' in r || 'trade_id' in r)) { // trades (Live-Bots)
      const to = parseTime(r.Time);
      if (!Number.isFinite(to)) continue;
      const lo = local(to, tz);
      const tc = parseTime(r.Exit_Zeit_UTC);
      out.push({
        date: lo.date, strategy: r.Strategie, status: r.Status, dir: nrm(r.Richtung), entryHm: floor5(lo.hm), entry: Number(r.Einstiegspreis),
        stop: Number(r.stopLevel), exit: Number(r.Ausstiegspreis), exitHm: Number.isFinite(tc) ? floor5(local(tc, tz).hm) : null,
        reason: normReason(r.Exit_Grund), R: NaN, raw: r,
      });
    }
  }
  return strategyName ? out.filter((x) => !x.strategy || String(x.strategy) === strategyName) : out;
}

export function loadLive(file, opts) {
  return normalizeLive(readRows(file), opts);
}

/** Vergleich je Tag (max. 1 Trade/Tag/Strategie angenommen; sonst Zuordnung über Einstiegszeit) */
export function compareLive(btTrades, liveRows, { from, to } = {}) {
  const live = liveRows.filter((l) => (!from || l.date >= from) && (!to || l.date <= to));
  const dates = [...new Set(live.map((l) => l.date))].sort();
  const lo = dates[0], hi = dates[dates.length - 1];
  const bt = btTrades.filter((t) => t.date >= lo && t.date <= hi);
  const rows = [];
  for (const d of [...new Set([...dates, ...bt.map((t) => t.date)])].sort()) {
    const L = live.filter((l) => l.date === d);
    const B = bt.filter((t) => t.date === d);
    const usedB = new Set();
    for (const l of L) {
      const b = B.find((x) => !usedB.has(x.id) && x.entryHm === l.entryHm) || B.find((x) => !usedB.has(x.id));
      if (b) usedB.add(b.id);
      if (!['OPEN', 'CLOSED'].includes(l.status)) {
        rows.push({ date: d, kind: b ? 'LIVE_FEHLT' : 'BEIDE_KEIN_TRADE', liveStatus: l.status, bt: b ? { dir: b.dir, entryHm: b.entryHm, reason: b.reason, R: b.R } : null, note: l.raw?.Notiz || null });
        continue;
      }
      if (!b) { rows.push({ date: d, kind: 'NUR_LIVE', live: pick(l) }); continue; }
      const btExitHm = b.reason === 'ZONE' ? b.exitSignalHm : b.exitHm;
      const m = {
        dir: l.dir === b.dir,
        entry: l.entryHm === b.entryHm,
        reason: l.reason ? normReason(b.reason) === l.reason : null,
        exitTime: l.exitHm ? l.exitHm === btExitHm || l.exitHm === b.exitHm : null,
      };
      const sg = b.dir === 'BUY' ? 1 : -1;
      rows.push({
        date: d, kind: m.dir && m.entry && m.reason !== false && m.exitTime !== false ? 'MATCH' : 'ABWEICHUNG', match: m,
        live: pick(l), bt: { dir: b.dir, signalHm: b.signalHm, entryHm: b.entryHm, entry: b.entry, exitHm: btExitHm, exit: b.exit, reason: b.reason, R: b.R },
        entryDiffPts: Number.isFinite(l.entry) ? round((l.entry - b.entry) * sg, 2) : null, // + = live schlechter
        exitDiffPts: Number.isFinite(l.exit) ? round((b.exit - l.exit) * sg, 2) : null, // + = live schlechter
        rDiff: Number.isFinite(l.R) ? round(l.R - b.R, 3) : null,
      });
    }
    for (const b of B) if (!usedB.has(b.id)) rows.push({ date: d, kind: 'NUR_BACKTEST', bt: { dir: b.dir, entryHm: b.entryHm, reason: b.reason, R: b.R } });
  }
  const traded = rows.filter((r) => ['MATCH', 'ABWEICHUNG', 'NUR_LIVE', 'NUR_BACKTEST', 'LIVE_FEHLT'].includes(r.kind));
  const matched = rows.filter((r) => r.kind === 'MATCH').length;
  const pairs = rows.filter((r) => r.kind === 'MATCH' || r.kind === 'ABWEICHUNG');
  const num = (a) => a.filter((x) => Number.isFinite(x));
  return {
    period: { from: lo, to: hi }, liveTrades: live.filter((l) => ['OPEN', 'CLOSED'].includes(l.status)).length, btTrades: bt.length,
    matchRate: traded.length ? round(matched / traded.length, 3) : null,
    avgEntryDiffPts: round(mean(num(pairs.map((r) => r.entryDiffPts))), 2),
    avgExitDiffPts: round(mean(num(pairs.map((r) => r.exitDiffPts))), 2),
    avgRDiff: round(mean(num(pairs.map((r) => r.rDiff))), 3),
    sumRLive: round(num(pairs.map((r) => r.live.R)).reduce((s, x) => s + x, 0), 2),
    sumRBacktest: round(pairs.reduce((s, r) => s + r.bt.R, 0), 2),
    rows,
  };
}

function pick(l) {
  return { dir: l.dir, signalHm: l.signalHm, entryHm: l.entryHm, entry: l.entry, exitHm: l.exitHm, exit: l.exit, reason: l.reason, R: round(l.R, 3) };
}
