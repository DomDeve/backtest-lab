// Daten laden: Capital.com-JSON (/prices), CSV, flache JSON-Zeilen (z.B. n8n Data-Table-Export), ZIP oder Ordner.
// Ergebnis: Rohkerzen im kanonischen Format { t, bo,bh,bl,bc, ao,ah,al,ac, vol, src } (t = UTC-ms Kerzenbeginn).

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { utcFor } from '../core/time.js';

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(String(v).replace(',', '.')));

/** Zeitstempel -> UTC-ms. Strings ohne Zone werden in inputTz interpretiert (Capital snapshotTimeUTC = UTC). */
export function parseTime(v, inputTz = 'UTC') {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n > 1e12 ? n : n * 1000;
  }
  let s = String(v).trim().replace(' ', 'T').replace(/\//g, '-');
  // 28.10.2026 11:30 -> 2026-10-28T11:30
  const de = s.match(/^(\d{2})\.(\d{2})\.(\d{4})T?(.*)$/);
  if (de) s = `${de[3]}-${de[2]}-${de[1]}T${de[4] || '00:00'}`;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  if (inputTz === 'UTC') return Date.parse(s + 'Z');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? utcFor(m[1], m[2], inputTz) ?? NaN : NaN;
}

// ---------- Capital.com /prices ----------
function fromCapitalPrice(c) {
  const t = Date.parse((c.snapshotTimeUTC || c.snapshotTime) + (/[zZ]$/.test(String(c.snapshotTimeUTC || c.snapshotTime)) ? '' : 'Z'));
  return {
    t,
    bo: num(c.openPrice?.bid), bh: num(c.highPrice?.bid), bl: num(c.lowPrice?.bid), bc: num(c.closePrice?.bid),
    ao: num(c.openPrice?.ask), ah: num(c.highPrice?.ask), al: num(c.lowPrice?.ask), ac: num(c.closePrice?.ask),
    vol: num(c.lastTradedVolume),
  };
}
const isCapitalPrice = (o) => o && typeof o === 'object' && o.openPrice && (o.snapshotTimeUTC || o.snapshotTime);

// ---------- flache Zeilen (CSV / JSON-Zeilen) ----------
const ALIASES = {
  time: ['snapshottimeutc', 'time', 'timestamp', 'datetime', 'date_time', 'datum_zeit', 'bar_time', 'bar_ts', 't', 'date'],
  bo: ['bo', 'openbid', 'bidopen', 'open_bid', 'bid_open'], bh: ['bh', 'highbid', 'bidhigh', 'high_bid', 'bid_high'],
  bl: ['bl', 'lowbid', 'bidlow', 'low_bid', 'bid_low'], bc: ['bc', 'closebid', 'bidclose', 'close_bid', 'bid_close'],
  ao: ['ao', 'openask', 'askopen', 'open_ask', 'ask_open'], ah: ['ah', 'highask', 'askhigh', 'high_ask', 'ask_high'],
  al: ['al', 'lowask', 'asklow', 'low_ask', 'ask_low'], ac: ['ac', 'closeask', 'askclose', 'close_ask', 'ask_close'],
  o: ['open', 'o', 'mid_open'], h: ['high', 'h', 'mid_high'], l: ['low', 'l', 'mid_low'], c: ['close', 'c', 'mid_close'],
  spread: ['spread', 'spr'], vol: ['volume', 'vol', 'lasttradedvolume', 'tickvolume'],
  symbol: ['symbol', 'epic', 'instrument', 'ticker'], source: ['source'],
};
function mapper(keys) {
  const lower = Object.fromEntries(keys.map((k) => [k.toLowerCase().replace(/[\s.]/g, ''), k]));
  const m = {};
  for (const [field, al] of Object.entries(ALIASES)) for (const a of al) if (lower[a] !== undefined) { m[field] = lower[a]; break; }
  return m;
}
function fromFlat(row, m, opt) {
  if (opt.symbol && m.symbol && row[m.symbol] && String(row[m.symbol]).toUpperCase() !== opt.symbol.toUpperCase()) return null;
  if (opt.source && m.source && row[m.source] && String(row[m.source]) !== opt.source) return null;
  const t = parseTime(row[m.time], opt.inputTz);
  const g = (f) => (m[f] ? num(row[m[f]]) : NaN);
  let bar;
  if (m.bo && m.ao) {
    bar = { t, bo: g('bo'), bh: g('bh'), bl: g('bl'), bc: g('bc'), ao: g('ao'), ah: g('ah'), al: g('al'), ac: g('ac') };
  } else if (m.o) {
    // Nur Mid-Preise: Bid/Ask aus Spread-Spalte oder Default-Spread rekonstruieren
    let sp = g('spread');
    if (!Number.isFinite(sp) || sp <= 0) sp = opt.defaultSpread;
    const hs = sp / 2;
    const [o, h, l, c] = [g('o'), g('h'), g('l'), g('c')];
    bar = { t, bo: o - hs, bh: h - hs, bl: l - hs, bc: c - hs, ao: o + hs, ah: h + hs, al: l + hs, ac: c + hs, spreadAssumed: !(g('spread') > 0) };
  } else return null;
  bar.vol = g('vol');
  return bar;
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = [';', ',', '\t'].map((s) => [s, lines[0].split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const head = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((l) => {
    const cells = l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

function barsFromParsed(data, opt, src) {
  const out = [];
  const visit = (x) => {
    if (Array.isArray(x)) {
      if (!x.length) return;
      if (isCapitalPrice(x[0])) { for (const c of x) out.push({ ...fromCapitalPrice(c), src }); return; }
      if (x[0] && typeof x[0] === 'object' && !Array.isArray(x[0]) && !x[0].prices) {
        const m = mapper(Object.keys(x[0]));
        if (m.time) { for (const r of x) { const b = fromFlat(r, m, opt); if (b) out.push({ ...b, src }); } return; }
      }
      for (const y of x) visit(y);
    } else if (x && typeof x === 'object') {
      if (Array.isArray(x.prices)) return visit(x.prices);
      if (Array.isArray(x.data)) return visit(x.data);
      if (Array.isArray(x.rows)) return visit(x.rows);
      if (isCapitalPrice(x)) out.push({ ...fromCapitalPrice(x), src });
      else for (const v of Object.values(x)) if (v && typeof v === 'object') visit(v);
    }
  };
  visit(data);
  return out;
}

function parseText(text, name, opt) {
  if (/\.csv$|\.txt$/i.test(name)) {
    const rows = parseCsv(text);
    return barsFromParsed(rows, opt, name);
  }
  const t = text.trim();
  // NDJSON (eine JSON-Zeile je Kerze/Antwort)
  if (t.startsWith('{') && t.includes('\n{')) {
    return t.split(/\r?\n/).filter(Boolean).flatMap((l) => barsFromParsed(JSON.parse(l), opt, name));
  }
  return barsFromParsed(JSON.parse(t), opt, name);
}

/**
 * Lädt Kerzen aus Datei, ZIP oder Ordner (rekursiv).
 * @param {string|string[]} input
 * @param {{symbol?:string, source?:string, inputTz?:string, defaultSpread?:number}} opt
 */
export function loadBars(input, opt = {}) {
  const o = { inputTz: 'UTC', defaultSpread: 1.8, ...opt };
  const files = [];
  const collect = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) collect(path.join(p, f));
    else if (/\.(json|csv|txt|ndjson|zip)$/i.test(p)) files.push(p);
  };
  for (const p of [].concat(input)) collect(p);
  const bars = [];
  const sources = [];
  for (const f of files) {
    if (/\.zip$/i.test(f)) {
      const zip = new AdmZip(f);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !/\.(json|csv|txt|ndjson)$/i.test(e.entryName)) continue;
        const b = parseText(e.getData().toString('utf8'), e.entryName, o);
        sources.push({ file: `${path.basename(f)}:${e.entryName}`, bars: b.length });
        bars.push(...b);
      }
    } else {
      const b = parseText(fs.readFileSync(f, 'utf8'), f, o);
      sources.push({ file: path.basename(f), bars: b.length });
      bars.push(...b);
    }
  }
  return { bars, sources };
}
