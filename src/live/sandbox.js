// Sandbox: führt den UNVERÄNDERTEN Text eines n8n-Code-Nodes aus.
// Umgelenkt werden nur die Dinge, die n8n bzw. die Laufzeit bereitstellt:
//   $input.all()/first()      -> die Kerzen-/Konto-Antworten, wie sie die HTTP-Nodes liefern würden
//   $getWorkflowStaticData()  -> Zustand je Bot (bleibt über die Läufe erhalten, wie live)
//   Date / Date.now()         -> simulierte Uhrzeit des Laufs
//   Intl.DateTimeFormat       -> schnelle, DST-korrekte Variante (gleiche Ausgabe, ~100x schneller)
//   console                   -> Meldungen werden für die Filter-Statistik gesammelt
//   $('Node')                 -> leerer Stub (Strategie-Nodes lesen keine anderen Nodes)

import { local } from '../core/time.js';

const RealDate = Date;
const RealDTF = Intl.DateTimeFormat;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

export function makeClock() { return { now: 0 }; }

export function makeDate(clock) {
  // Gibt echte Date-Objekte zurück (schneller als eine Unterklasse); nur "jetzt" ist simuliert.
  const parsed = new Map();
  function SimDate(...a) {
    if (!new.target) return new RealDate(clock.now).toString();
    if (a.length === 0) return new RealDate(clock.now);
    if (a.length === 1 && typeof a[0] === 'string') {
      let v = parsed.get(a[0]);
      if (v === undefined) { v = RealDate.parse(a[0]); if (parsed.size > 1000000) parsed.clear(); parsed.set(a[0], v); }
      return new RealDate(v);
    }
    return new RealDate(...a);
  }
  SimDate.now = () => clock.now;
  SimDate.UTC = RealDate.UTC;
  SimDate.parse = RealDate.parse;
  SimDate.prototype = RealDate.prototype;
  return SimDate;
}

const partsCache = new Map(); // tz -> Optionen-Bits -> Minute -> formatToParts-Ergebnis
class FastDTF {
  constructor(locale, opts = {}) {
    this.locale = locale; this.o = opts; this.tz = opts.timeZone || 'UTC';
  }
  _parts(d) {
    const ms = typeof d === 'number' ? d : d === undefined ? Date.now() : d.getTime();
    const L = local(ms, this.tz);
    const [y, m, dd] = L.date.split('-');
    return { year: y, month: m, day: dd, hour: pad(L.hour), minute: pad(L.minute), weekday: WD[L.weekday] };
  }
  formatToParts(d) {
    const ms = typeof d === 'number' ? d : d === undefined ? Date.now() : d.getTime();
    const o = this.o;
    const bits = (o.weekday ? 1 : 0) | (o.year ? 2 : 0) | (o.month ? 4 : 0) | (o.day ? 8 : 0) | (o.hour ? 16 : 0) | (o.minute ? 32 : 0);
    let byTz = partsCache.get(this.tz);
    if (!byTz) { byTz = new Map(); partsCache.set(this.tz, byTz); }
    let byBits = byTz.get(bits);
    if (!byBits) { byBits = new Map(); byTz.set(bits, byBits); }
    const minute = Math.floor(ms / 60000);
    let out = byBits.get(minute);
    if (out) return out;
    const p = this._parts(ms);
    out = [];
    for (const k of ['weekday', 'year', 'month', 'day', 'hour', 'minute']) if (o[k] !== undefined) out.push({ type: k, value: p[k] });
    if (byBits.size > 1500000) byBits.clear();
    byBits.set(minute, out);
    return out;
  }
  format(d) {
    const p = this._parts(d);
    const keys = Object.keys(this.o).filter((k) => !['timeZone', 'hour12', 'hourCycle'].includes(k));
    if (keys.length === 0 && /^en-CA/.test(this.locale)) return `${p.year}-${p.month}-${p.day}`;
    if (keys.length === 1 && keys[0] === 'hour') return p.hour;
    return new RealDTF(this.locale, this.o).format(d);
  }
}

export function makeIntl() {
  return { ...Intl, DateTimeFormat: FastDTF };
}

/**
 * Kompiliert Code-Node-Text einmal. Aufruf je Lauf mit Kontext.
 * @returns {(ctx:{items:Array, state:object, clock:object, logs?:Array}) => Array}
 */
export function compileNode(code) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('$input', '$getWorkflowStaticData', 'Date', 'Intl', 'console', '$', code);
  return ({ items, state, DateCls, IntlObj, logs }) => {
    const input = { all: () => items, first: () => items[0], item: items[0] };
    const getSD = (type = 'global') => (state[type] ||= {});
    const con = logs ? { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: () => {} } : { log() {}, warn() {}, error() {} };
    const $ = () => ({ item: { json: {} }, first: () => ({ json: {} }), all: () => [], isExecuted: false });
    return fn(input, getSD, DateCls, IntlObj, con, $);
  };
}
