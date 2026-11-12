// DE40 NoiseB (Noise Area) – 1:1 aus dem n8n-Workflow "FT DE40 ORB60 + NoiseB (Forward-Test)".
//
// Regeln (live):
//   Profil: σ je Uhrzeit = Mittel von |Close(hm) / Open(09:00) - 1| über die letzten 14 gültigen Tage
//           (gültig = 09:00- und 17:30-Kerze vorhanden, >= 100 Kerzen 09:00–17:30, jede Uhrzeit vorhanden).
//   Zone:   Open 09:00 × (1 ± σ(hm)).
//   Einstieg: erster Schluss außerhalb der Zone ab 09:30 bis 17:20 -> Einstieg zur nächsten Kerze.
//             Nur der erste Ausbruch zählt. SL = Open 09:00.
//   Ausstieg: Schluss zurück in der Zone (ab Einstiegskerze) -> raus zur nächsten Kerze, spätestens 17:30.

import { berlinSession } from '../core/sessions.js';
import { hmList, addMinutes } from '../core/time.js';

function byHmOf(bars) { const m = {}; for (const c of bars) m[c.hm] = c; return m; }

const XETRA = berlinSession('DE40'); // Xetra 09:00–17:30 Europe/Berlin

export default {
  id: 'de40-noiseb',
  name: 'FT NoiseB DE40',
  symbol: 'DE40',
  description: 'Noise-Area-Ausbruch (σ-Profil 14 Tage) ab 09:30, SL Open 09:00, Exit Zone/17:30',
  historyDays: 40,
  defaults: {
    halfSpread: 0.9,
    openHm: XETRA.from, // config/sessions.yaml
    signalFrom: '09:30',
    signalTo: '17:20', // inklusive
    exitHm: XETRA.to,
    lookback: 14,
    bandMult: 1, // Zone = Open × (1 ± bandMult·σ)
    exitOnZone: true,
    tpR: null,
    filters: [],
  },
  grid: {
    bandMult: [0.8, 1, 1.2, 1.5],
    signalFrom: ['09:30', '10:00', '10:30'],
    lookback: [10, 14, 20],
  },

  createState() { return {}; },

  onDay({ prevDays, state, params: p }) {
    state.done = false;
    state.profile = null;
    const lastHm = addMinutes(p.exitHm, -5);
    const HMS = hmList(p.openHm, lastHm);
    const valid = [];
    for (let k = prevDays.length - 1; k >= 0 && valid.length < p.lookback; k--) {
      const m = byHmOf(prevDays[k]);
      const n = Object.keys(m).filter((h) => h >= p.openHm && h <= p.exitHm).length;
      if (m[p.openHm] && m[p.exitHm] && n >= 100) valid.push(m);
    }
    if (valid.length < p.lookback) return; // kein Profil -> kein Handel (wie live)
    const sig = {};
    for (const hm of HMS) {
      let s = 0, ok = true;
      for (const m of valid) {
        const o = m[p.openHm].bo + p.halfSpread;
        const c = m[hm];
        if (!c) { ok = false; break; }
        s += Math.abs((c.bc + p.halfSpread) / o - 1);
      }
      sig[hm] = ok ? s / valid.length : null;
    }
    state.profile = sig;
  },

  onBar(ctx) {
    const { bar, hm, byHm, position, state, params: p, tradesToday } = ctx;
    const lastHm = addMinutes(p.exitHm, -5);
    const o0 = byHm[p.openHm];
    const o = o0 ? o0.bo + p.halfSpread : null;
    const c = bar.bc + p.halfSpread;
    const sg = state.profile ? state.profile[hm] : null;

    if (position) {
      if (hm >= lastHm) return [{ type: 'EXIT', reason: '1730' }];
      if (p.exitOnZone && o && sg != null && hm >= position.entryHm) {
        const L = position.dir === 'BUY';
        const band = L ? o * (1 + p.bandMult * sg) : o * (1 - p.bandMult * sg);
        if ((L && c < band) || (!L && c > band)) return [{ type: 'EXIT', reason: 'ZONE' }];
      }
      return [];
    }
    if (tradesToday > 0 || state.done || !state.profile || !o) return [];
    if (hm < p.signalFrom || hm > p.signalTo) return [];
    if (sg == null) return [];
    let dir = null;
    if (c > o * (1 + p.bandMult * sg)) dir = 'BUY';
    else if (c < o * (1 - p.bandMult * sg)) dir = 'SELL';
    if (!dir) return [];
    state.done = true;
    const stop = Math.round(o * 10 + 1e-6) / 10;
    const refPrice = dir === 'BUY' ? bar.bc + 2 * p.halfSpread : bar.bc;
    const atr = ctx.dayContext?.ctx_atr14;
    return [{
      type: 'ENTER', dir, stop, refPrice, signalHm: hm, tpR: p.tpR || null,
      features: {
        sigma: Math.round(sg * 1e6) / 1e6,
        stopPts: Math.round(Math.abs(refPrice - stop) * 10) / 10,
        stopRel: atr ? Math.round((Math.abs(refPrice - stop) / atr) * 1000) / 1000 : null,
        moveFromOpenPct: Math.round((c / o - 1) * 1e5) / 1e3,
      },
    }];
  },
};
