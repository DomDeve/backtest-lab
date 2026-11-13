// Kerzen so, wie sie der Bot zum Zeitpunkt T vom Broker bekommt.
//
// Capital.com liefert bei /prices die LAUFENDE Kerze als letzte mit. Bei einem Lauf um T (Cron, kurz nach
// dem 5-Min-Wechsel) besteht die laufende M5-Kerze praktisch nur aus dem ersten Kurs. Höhere Zeitebenen
// (M15/H1/H4) enthalten die schon abgeschlossenen M5-Kerzen ihrer Periode plus diesen ersten Kurs.
// Die cTrader-Bridge (FTMO) liefert dagegen nur ABGESCHLOSSENE Kerzen.

const STEP = { M5: 5, M15: 15, H1: 60, H4: 240 };

export class TimeframeSeries {
  constructor(bars, tf) {
    this.bars = bars;
    this.step = STEP[tf] * 60000;
    this.tf = tf;
    if (tf === 'M5') { this.agg = bars; return; }
    const agg = [];
    let cur = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const p = Math.floor(b.t / this.step) * this.step;
      if (!cur || cur.t !== p) {
        cur = { t: p, bo: b.bo, bh: b.bh, bl: b.bl, bc: b.bc, ao: b.ao, ah: b.ah, al: b.al, ac: b.ac, vol: b.vol || 0 };
        agg.push(cur);
      } else {
        cur.bh = Math.max(cur.bh, b.bh); cur.bl = Math.min(cur.bl, b.bl); cur.bc = b.bc;
        cur.ah = Math.max(cur.ah, b.ah); cur.al = Math.min(cur.al, b.al); cur.ac = b.ac;
        cur.vol += b.vol || 0;
      }
    }
    this.agg = agg;
    this.ptr = 0;
  }

  /** Kerzen für einen Lauf zum Zeitpunkt bars[i].t: n Stück, letzte = laufende (running=true) */
  view(i, n, running = true, noTick = false) {
    // noTick: Capital hat zum Abrufzeitpunkt noch keinen Kurs der neuen M5-Kerze -> keine laufende M5-Kerze;
    // höhere Zeitebenen: laufende Kerze nur aus den schon abgeschlossenen M5 der Periode (ohne erste Kurs von T).
    const T = this.bars[i].t;
    const P = Math.floor(T / this.step) * this.step;
    let done;
    if (this.tf === 'M5') {
      done = this.bars.slice(Math.max(0, i - (running ? n - 1 : n)), i);
    } else {
      while (this.ptr < this.agg.length && this.agg[this.ptr].t < P) this.ptr++;
      while (this.ptr > 0 && this.agg[this.ptr - 1].t >= P) this.ptr--;
      done = this.agg.slice(Math.max(0, this.ptr - (running ? n - 1 : n)), this.ptr);
    }
    if (!running) return done;
    if (noTick) {
      if (this.tf === 'M5') return this.bars.slice(Math.max(0, i - n), i);
      const part = [];
      for (let j = i - 1; j >= 0 && this.bars[j].t >= P; j--) part.unshift(this.bars[j]);
      if (!part.length) return this.agg.slice(Math.max(0, this.ptr - n), this.ptr);
      const r = { t: P, bo: part[0].bo, ao: part[0].ao, bc: part.at(-1).bc, ac: part.at(-1).ac, running: true,
        bh: Math.max(...part.map((x) => x.bh)), bl: Math.min(...part.map((x) => x.bl)), ah: Math.max(...part.map((x) => x.ah)), al: Math.min(...part.map((x) => x.al)),
        vol: part.reduce((s2, x) => s2 + (x.vol || 0), 0) };
      return [...done, r];
    }
    // laufende Kerze: abgeschlossene M5 dieser Periode + erster Kurs von T
    const tick = this.bars[i];
    const r = { t: P, bo: tick.bo, bh: tick.bo, bl: tick.bo, bc: tick.bo, ao: tick.ao, ah: tick.ao, al: tick.ao, ac: tick.ao, vol: 1, running: true };
    if (this.tf !== 'M5') {
      let j = i - 1;
      const part = [];
      while (j >= 0 && this.bars[j].t >= P) { part.push(this.bars[j]); j--; }
      if (part.length) {
        part.reverse();
        r.bo = part[0].bo; r.ao = part[0].ao;
        r.bh = Math.max(tick.bo, ...part.map((x) => x.bh)); r.bl = Math.min(tick.bo, ...part.map((x) => x.bl));
        r.ah = Math.max(tick.ao, ...part.map((x) => x.ah)); r.al = Math.min(tick.ao, ...part.map((x) => x.al));
        r.vol = part.reduce((s, x) => s + (x.vol || 0), 0) + 1;
      }
    }
    return [...done, r];
  }
}

const iso = (t) => new Date(t).toISOString().slice(0, 19);

/** Capital.com /prices-Format */
export function toCapital(b) {
  if (b._cap && !b.running) return b._cap;
  const c = {
    snapshotTime: iso(b.t), snapshotTimeUTC: iso(b.t),
    openPrice: { bid: b.bo, ask: b.ao }, highPrice: { bid: b.bh, ask: b.ah },
    lowPrice: { bid: b.bl, ask: b.al }, closePrice: { bid: b.bc, ask: b.ac },
    lastTradedVolume: b.vol,
  };
  if (!b.running) Object.defineProperty(b, '_cap', { value: c, enumerable: false });
  return c;
}

/** cTrader-Bridge-Format (FTMO). Preise: Mitte aus Capital-Bid/Ask (FTMO-Kurse weichen leicht ab).
 *  Felder wie live (GET /candles, Ausführung 92941): time, open, high, low, close, tick_volume, spread.
 *  tick_volume = Volumen der Datenquelle (Capital bzw. Dukascopy-Ticks) – nicht das cTrader-Tickvolumen. */
export function toBridge(b) {
  if (b._br) return b._br;
  const c = { time: b.t / 1000, open: (b.bo + b.ao) / 2, high: (b.bh + b.ah) / 2, low: (b.bl + b.al) / 2, close: (b.bc + b.ac) / 2, tick_volume: b.vol, spread: 0 };
  Object.defineProperty(b, '_br', { value: c, enumerable: false });
  return c;
}
