// DE40 ORB60 – 1:1 aus dem n8n-Workflow "FT DE40 ORB60 + NoiseB (Forward-Test)", Node "Entscheidung".
//
// Regeln (live):
//   Range 09:00–10:00 (Kerzen 09:00..09:55 müssen alle da sein), Hoch/Tief aus Signalpreisen.
//   Erster M5-Schluss außerhalb der Range zwischen 10:00 und 12:00 -> Einstieg zur nächsten Kerze.
//   Nur der ERSTE Ausbruch zählt (wird er verpasst, gibt es keinen späteren Einstieg).
//   SL = Range-Mitte (auf 0,1 gerundet), kein TP, Exit 17:30. Max. 1 Trade/Tag.
//   Signalpreis = Bid + HALF_SPREAD (wie parseCandles() im Bot).
//
// Zusätzliche Parameter (Default = live-identisch) erlauben Varianten für die Analyse:
//   tpR (fester TP in R, z.B. 2 = "Schatten TP2R"), stopMode 'mid'|'opposite', breakevenR.

import { berlinSession } from '../core/sessions.js';
import { hmList, addMinutes } from '../core/time.js';

const XETRA = berlinSession('DE40'); // Xetra 09:00–17:30 Europe/Berlin

export default {
  id: 'de40-orb60',
  name: 'FT ORB60 DE40',
  symbol: 'DE40',
  description: 'Opening Range Breakout 09:00–10:00, Signal bis 12:00, SL Range-Mitte, Exit 17:30',
  historyDays: 2,
  defaults: {
    halfSpread: 0.9,
    rangeFrom: XETRA.from, // config/sessions.yaml
    rangeTo: '10:00', // exklusiv: letzte Range-Kerze = 09:55
    signalTo: '12:00', // exklusiv
    exitHm: XETRA.to,
    stopMode: 'mid', // 'mid' = Range-Mitte (live), 'opposite' = gegenüberliegende Range-Seite
    tpR: null, // null = kein TP (live)
    breakevenR: null, // z.B. 1 -> SL auf Einstand, sobald 1R erreicht (Schlusskurs-Basis)
    minRangePts: 0,
    maxRangePts: Infinity,
    filters: [],
  },
  // Raster für Sensitivitäts-/Walk-Forward-Analyse
  grid: {
    signalTo: ['11:00', '12:00', '13:00'],
    stopMode: ['mid', 'opposite'],
    tpR: [null, 1.5, 2, 3],
  },

  createState() { return {}; },

  onDay({ state }) {
    state.done = false; // erster Ausbruch gesehen (gehandelt oder nicht)
    state.range = null;
  },

  onBar(ctx) {
    const { bar, hm, byHm, position, state, params: p, tradesToday } = ctx;
    const px = (b, k) => b['b' + k] + p.halfSpread; // Signalpreis wie live
    const lastHm = addMinutes(p.exitHm, -5);

    // --- offene Position ---
    if (position) {
      if (hm >= lastHm) return [{ type: 'EXIT', reason: '1730' }];
      if (p.breakevenR && !state.beDone) {
        const risk = Math.abs(position.entry - position.stop);
        const gain = position.dir === 'BUY' ? bar.bc - position.entry : position.entry - bar.ac;
        if (risk > 0 && gain >= p.breakevenR * risk) { state.beDone = true; return [{ type: 'MODIFY', stop: position.entry }]; }
      }
      return [];
    }
    if (tradesToday > 0 || state.done) return [];

    // --- Range bestimmen (sobald die letzte Range-Kerze abgeschlossen ist) ---
    if (!state.range) {
      if (hm < addMinutes(p.rangeTo, -5)) return [];
      const rng = hmList(p.rangeFrom, addMinutes(p.rangeTo, -5)).map((h) => byHm[h]);
      if (!rng.every(Boolean)) { state.done = true; return []; } // Range unvollständig -> kein Trade (wie live)
      const hi = Math.max(...rng.map((c) => px(c, 'h')));
      const lo = Math.min(...rng.map((c) => px(c, 'l')));
      state.range = { hi, lo, mid: (hi + lo) / 2 };
      if (hi - lo < p.minRangePts || hi - lo > p.maxRangePts) { state.done = true; return []; }
    }

    // --- Signal ---
    if (hm < p.rangeTo || hm >= p.signalTo) { if (hm >= p.signalTo) state.done = true; return []; }
    const c = px(bar, 'c');
    const { hi, lo, mid } = state.range;
    if (!(c > hi || c < lo)) return [];
    state.done = true;
    state.beDone = false;
    const dir = c > hi ? 'BUY' : 'SELL';
    const rawStop = p.stopMode === 'opposite' ? (dir === 'BUY' ? lo : hi) : mid;
    const stop = Math.round(rawStop * 10 + 1e-6) / 10; // +1e-6: Gleitkomma-Rauschen bei x,x5 wie live aufrunden
    const refPrice = dir === 'BUY' ? bar.bc + 2 * p.halfSpread : bar.bc;
    const risk = Math.abs(refPrice - stop);
    const atr = ctx.dayContext?.ctx_atr14;
    return [{
      type: 'ENTER', dir, stop, refPrice, signalHm: hm,
      tpR: p.tpR || null, // Engine setzt TP ab tatsächlichem Einstieg
      features: {
        rangePts: Math.round((hi - lo) * 10) / 10,
        rangeRel: atr ? Math.round(((hi - lo) / atr) * 1000) / 1000 : null,
        breakoutPts: Math.round((dir === 'BUY' ? c - hi : lo - c) * 10) / 10,
        signalMinutesAfterRange: (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))) - (Number(p.rangeTo.slice(0, 2)) * 60 + Number(p.rangeTo.slice(3))),
        stopPts: Math.round(risk * 10) / 10,
      },
    }];
  },
};
