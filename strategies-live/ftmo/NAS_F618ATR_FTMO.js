// ================================================================
// NAS100 M15 Fibonacci Swing v5.0 — Variante F618ATR — FTMO-Version (cTrader-Bridge)
// Signal-Logik unverändert gegenüber v5.0-F618ATR (Fib 61,8 %, Swing-Lookback 1,
// SMA200-Abstand 30 Pkt, ATR-Pause < 1,6 %).
// FTMO-Anpassungen:
//   - Kerzen kommen von der Bridge (open/high/low/close/time), Input:
//     items[0] = M15 (body), items[1] = H4 (body), items[2] = Symbol-Info US100.cash
//   - Spread-Check entfällt (Bridge liefert keinen Spread)
//   - Freitag-Filter AN: ab Fr 16 UTC keine neuen Orders (FTMO-Account Standard: kein Wochenende)
//   - Sizing: 0,5 % von 100.000 $ Startkapital, Lots = Risiko / (SL-Distanz × Einheiten pro Lot)
// ================================================================

try {
  const BOT_ID = 'F618ATR';
  const SYMBOL = 'US100.cash';
  // === TUNING-KONSTANTEN (v5.0-F618ATR, unverändert) ===
  const FIB_RETRACEMENT       = 0.618;
  const FIB_EXTENSION         = 0.618;
  const USE_H4_TREND_FILTER   = false;
  const USE_MA_DISTANCE_FILTER = true;
  const MA_DIST_MIN           = 30;
  const USE_ATR_FILTER        = true;
  const ATR_MIN_PCT           = 1.6;
  const ATR_DAYS              = 14;
  const RANGE_MIN             = 50;
  const SL_MIN                = 25;
  const SL_MAX                = 200;
  const MIN_RR                = 1.8;
  const SL_BUF                = 5;
  // === FTMO ===
  const USE_FRIDAY_FILTER     = true;   // FTMO: keine neuen Orders vor dem Wochenende
  const FRIDAY_CUTOFF_UTC     = 16;
  const INITIAL_CAPITAL       = 100000; // FTMO 2-Step 100k USD
  const RISK_PCT              = 0.005;  // 0,5 % = 500 $ pro Trade
  const EXPIRATION_HOURS      = 24;

  const items = $input.all();
  // Bridge liefert ggf. eine Kerze weniger als angefragt → mehr anfragen, exakt die letzten 200 verwenden (wie Capital.com/Backtest)
  const m15Candles = Array.isArray(items[0]?.json?.body) ? items[0].json.body.slice(-200) : [];
  const h4Candles  = Array.isArray(items[1]?.json?.body) ? items[1].json.body : [];
  const sym = items[2]?.json || {};
  if (m15Candles.length < 200) return [{json:{signal:'NONE',error:`Zu wenige M15-Kerzen für SMA200: ${m15Candles.length}`,botId:BOT_ID}}];
  if (h4Candles.length < 20) return [{json:{signal:'NONE',error:`Zu wenige H4-Kerzen: ${h4Candles.length}`,botId:BOT_ID}}];
  if (!(Number(sym.lot_size) > 0)) return [{json:{signal:'NONE',error:'Symbol-Info fehlt (lot_size)',botId:BOT_ID}}];

  const highs  = m15Candles.map(c => Number(c.high));
  const lows   = m15Candles.map(c => Number(c.low));
  const closes = m15Candles.map(c => Number(c.close));
  const len = closes.length;
  const currentClose = closes[len-1];

  // ══════════════════════════════════════════════════════════════
  // ZEITFILTER
  // ══════════════════════════════════════════════════════════════
  const now = new Date();
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return [{json:{signal:'NONE',error:'Wochenende',botId:BOT_ID}}];
  const utcHour = now.getUTCHours();
  if (utcHour < 7 || utcHour >= 19) return [{json:{signal:'NONE',error:'Außerhalb Handelszeit (07-19 UTC)',botId:BOT_ID}}];
  if (USE_FRIDAY_FILTER && utcDay === 5 && utcHour >= FRIDAY_CUTOFF_UTC) {
    return [{json:{signal:'NONE',error:'Freitag ab 16 UTC – keine neuen Orders (FTMO-Wochenendregel)',botId:BOT_ID}}];
  }

  // Setup-Fingerprint (verhindert dasselbe Setup 2x)
  const staticData = $getWorkflowStaticData('node');
  if (!staticData.tradedSetups) staticData.tradedSetups = {};
  const nowMs = Date.now();
  for (const fp in staticData.tradedSetups) {
    if (nowMs - staticData.tradedSetups[fp] > 24*3600000) delete staticData.tradedSetups[fp];
  }

  // ══════════════════════════════════════════════════════════════
  // SWING-ERKENNUNG
  // ══════════════════════════════════════════════════════════════
  function findSwingHighs(h, lb=2) {
    const o = [];
    for (let i=lb; i<h.length-lb; i++) {
      let ok = true;
      for (let j=1; j<=lb; j++) { if (h[i-j] >= h[i] || h[i+j] >= h[i]) { ok = false; break; } }
      if (ok) o.push({index:i, price:h[i]});
    }
    return o;
  }
  function findSwingLows(l, lb=2) {
    const o = [];
    for (let i=lb; i<l.length-lb; i++) {
      let ok = true;
      for (let j=1; j<=lb; j++) { if (l[i-j] <= l[i] || l[i+j] <= l[i]) { ok = false; break; } }
      if (ok) o.push({index:i, price:l[i]});
    }
    return o;
  }

  const swH = findSwingHighs(highs, 1);
  const swL = findSwingLows(lows, 1);
  if (swH.length < 2 || swL.length < 2) return [{json:{signal:'NONE',error:`Zu wenige M15-Swings: ${swH.length}H, ${swL.length}L`,botId:BOT_ID}}];

  const sh1 = swH[swH.length-1];
  const sh2 = swH[swH.length-2];
  const sl1 = swL[swL.length-1];
  const sl2 = swL[swL.length-2];

  // ══════════════════════════════════════════════════════════════
  // EMA/SMA
  // ══════════════════════════════════════════════════════════════
  function calcEMA(data, period) {
    if (data.length < period) return data[data.length-1];
    const k = 2/(period+1);
    let ema = data.slice(0,period).reduce((a,b)=>a+b,0) / period;
    for (let i=period; i<data.length; i++) ema = data[i]*k + ema*(1-k);
    return ema;
  }
  function calcSMA(data, period) {
    if (data.length < period) return data[data.length-1];
    let sum = 0;
    for (let i=data.length-period; i<data.length; i++) sum += data[i];
    return sum / period;
  }
  const ema50 = calcEMA(closes, 50);
  const emaBull = currentClose > ema50;
  const emaBear = currentClose < ema50;
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);

  // ══════════════════════════════════════════════════════════════
  // H4 TRENDFILTER (nur fürs Logging, Filter aus)
  // ══════════════════════════════════════════════════════════════
  const h4Highs  = h4Candles.map(c => Number(c.high));
  const h4Lows   = h4Candles.map(c => Number(c.low));
  const h4Closes = h4Candles.map(c => Number(c.close));
  const h4Len = h4Closes.length;
  const h4SwH = findSwingHighs(h4Highs, 2);
  const h4SwL = findSwingLows(h4Lows, 2);

  let h4Trend = 'NONE';
  if (h4SwH.length >= 2 && h4SwL.length >= 2) {
    const h4sh1 = h4SwH[h4SwH.length-1], h4sh2 = h4SwH[h4SwH.length-2];
    const h4sl1 = h4SwL[h4SwL.length-1], h4sl2 = h4SwL[h4SwL.length-2];
    const h4Ema50 = calcEMA(h4Closes, 50);
    const h4CurrentClose = h4Closes[h4Len-1];
    if (h4sh1.price > h4sh2.price && h4sl1.price > h4sl2.price && h4CurrentClose > h4Ema50) h4Trend = 'UP';
    else if (h4sh1.price < h4sh2.price && h4sl1.price < h4sl2.price && h4CurrentClose < h4Ema50) h4Trend = 'DOWN';
  }
  if (USE_H4_TREND_FILTER) {
    if (h4Trend === 'DOWN' && emaBull) return [{json:{signal:'NONE',error:'H4 Trend bearish – kein Long erlaubt',h4Trend,botId:BOT_ID}}];
    if (h4Trend === 'UP' && emaBear) return [{json:{signal:'NONE',error:'H4 Trend bullish – kein Short erlaubt',h4Trend,botId:BOT_ID}}];
  }

  // ══════════════════════════════════════════════════════════════
  // SIGNAL LOGIC (unverändert)
  // ══════════════════════════════════════════════════════════════
  let signal = 'NONE', fibLevel = 0, tpLevel = 0, slLevel = 0, slDistance = 0, tpDistance = 0;
  let setupFP = '', entryReason = '';

  if (emaBull && sh1.price > sh2.price) {
    let relevantLow = null;
    for (let i=swL.length-1; i>=0; i--) {
      if (swL[i].index > sh2.index && swL[i].index < sh1.index) {
        if (!relevantLow || swL[i].price < relevantLow.price) relevantLow = swL[i];
      }
    }
    if (!relevantLow) {
      for (let i=swL.length-1; i>=0; i--) { if (swL[i].index < sh1.index) { relevantLow = swL[i]; break; } }
    }
    if (relevantLow) {
      const range = sh1.price - relevantLow.price;
      if (range > RANGE_MIN) {
        fibLevel = sh1.price - (range * FIB_RETRACEMENT);
        const maDistOk = !USE_MA_DISTANCE_FILTER || (fibLevel > sma50 && (fibLevel - sma200) > MA_DIST_MIN);
        if (!maDistOk) console.log(`BUY MA-Distanz blockiert: fib=${fibLevel.toFixed(1)} sma50=${sma50.toFixed(1)} sma200=${sma200.toFixed(1)}`);
        const distToFib = currentClose - fibLevel;
        if (distToFib > 0 && distToFib < range && maDistOk) {
          signal = 'BUY';
          entryReason = `LIMIT: M15 Breakout über ${sh2.price.toFixed(1)} → Fib ${(FIB_RETRACEMENT*100).toFixed(1)}% bei ${fibLevel.toFixed(1)}`;
          tpLevel = sh1.price + (range * FIB_EXTENSION);
          tpDistance = tpLevel - fibLevel;
          slLevel = relevantLow.price - SL_BUF;
          slDistance = fibLevel - slLevel;
          setupFP = `BUY_${sh1.index}_${relevantLow.index}_${sh1.price.toFixed(0)}`;
        }
      }
    }
  }

  if (emaBear && signal === 'NONE' && sl1.price < sl2.price) {
    let relevantHigh = null;
    for (let i=swH.length-1; i>=0; i--) {
      if (swH[i].index > sl2.index && swH[i].index < sl1.index) {
        if (!relevantHigh || swH[i].price > relevantHigh.price) relevantHigh = swH[i];
      }
    }
    if (!relevantHigh) {
      for (let i=swH.length-1; i>=0; i--) { if (swH[i].index < sl1.index) { relevantHigh = swH[i]; break; } }
    }
    if (relevantHigh) {
      const range = relevantHigh.price - sl1.price;
      if (range > RANGE_MIN) {
        fibLevel = sl1.price + (range * FIB_RETRACEMENT);
        const maDistOk = !USE_MA_DISTANCE_FILTER || (fibLevel < sma50 && (sma200 - fibLevel) > MA_DIST_MIN);
        if (!maDistOk) console.log(`SELL MA-Distanz blockiert: fib=${fibLevel.toFixed(1)} sma50=${sma50.toFixed(1)} sma200=${sma200.toFixed(1)}`);
        const distToFib = fibLevel - currentClose;
        if (distToFib > 0 && distToFib < range && maDistOk) {
          signal = 'SELL';
          entryReason = `LIMIT: M15 Breakdown unter ${sl2.price.toFixed(1)} → Fib ${(FIB_RETRACEMENT*100).toFixed(1)}% bei ${fibLevel.toFixed(1)}`;
          tpLevel = sl1.price - (range * FIB_EXTENSION);
          tpDistance = fibLevel - tpLevel;
          slLevel = relevantHigh.price + SL_BUF;
          slDistance = slLevel - fibLevel;
          setupFP = `SELL_${sl1.index}_${relevantHigh.index}_${sl1.price.toFixed(0)}`;
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FINALE FILTER
  // ══════════════════════════════════════════════════════════════
  let rr = 0;
  if (signal !== 'NONE') {
    rr = tpDistance > 0 && slDistance > 0 ? tpDistance / slDistance : 0;
    if (rr < MIN_RR) { console.log(`RR zu niedrig: ${rr.toFixed(2)} < ${MIN_RR}`); signal = 'NONE'; }
    if (slDistance > SL_MAX) { console.log(`SL zu groß: ${slDistance.toFixed(1)} > ${SL_MAX}`); signal = 'NONE'; }
    if (slDistance < SL_MIN) { console.log(`SL zu klein: ${slDistance.toFixed(1)} < ${SL_MIN}`); signal = 'NONE'; }
    if (staticData.tradedSetups[setupFP]) { console.log(`Setup bereits platziert: ${setupFP}`); signal = 'NONE'; }
  }

  // ══════════════════════════════════════════════════════════════
  // SIZING (FTMO: fester Prozentsatz vom Startkapital)
  // US100.cash: lot_size 100 (Hundertstel-Einheiten) → 1 Einheit pro Lot → 1 $ pro Punkt und Lot
  // ══════════════════════════════════════════════════════════════
  const riskUsd = INITIAL_CAPITAL * RISK_PCT;
  let size = 0;
  if (signal !== 'NONE') {
    const unitsPerLot = Number(sym.lot_size) / 100;
    const step   = Number(sym.volume_step) || 0.01;
    const volMin = Number(sym.volume_min)  || 0.01;
    const volMax = Number(sym.volume_max)  || 1000;
    let lots = riskUsd / (slDistance * unitsPerLot);
    lots = Math.floor(lots / step + 1e-9) * step;
    lots = Math.min(volMax, lots);
    size = Number(lots.toFixed(2));
    if (size < volMin) { console.log(`Lotgröße ${size} < Minimum ${volMin}`); signal = 'NONE'; size = 0; }
    staticData.tradedSetups[setupFP] = nowMs;
  }

  const trailingConfig = signal !== 'NONE' ? {
    enabled: true,
    breakevenTrigger: signal === 'BUY' ? fibLevel + slDistance : fibLevel - slDistance,
    breakevenSL: fibLevel,
    partialCloseTrigger: signal === 'BUY' ? fibLevel + (slDistance*2) : fibLevel - (slDistance*2),
    partialClosePercent: 50,
    trailingDistance: slDistance,
    trailingActive: false
  } : { enabled: false };

  console.log(`NAS100 FTMO F618ATR | Signal: ${signal} | Close: ${currentClose.toFixed(1)} | Fib: ${fibLevel.toFixed(1)} | TP: ${tpLevel.toFixed(1)} | SL: ${slDistance.toFixed(1)}pt | RR: 1:${rr > 0 ? rr.toFixed(2) : '0'} | Lots: ${size} | SMA50: ${sma50.toFixed(1)} | SMA200: ${sma200.toFixed(1)}`);

  // ══════════════════════════════════════════════════════════════
  // ATR-PAUSE (Tages-ATR14 aus H4-Kerzen, nach UTC-Tag gebündelt) – unverändert
  // ══════════════════════════════════════════════════════════════
  function dailyAtrPct(candles, nDays) {
    const days = {};
    for (const c of candles) {
      const t = new Date(Number(c.time) * 1000).toISOString();
      const d = t.slice(0, 10);
      const hi = Number(c.high), lo = Number(c.low), cl = Number(c.close);
      const x = days[d];
      if (!x) days[d] = { h: hi, l: lo, c: cl, t, n: 1 };
      else { x.h = Math.max(x.h, hi); x.l = Math.min(x.l, lo); if (t > x.t) { x.c = cl; x.t = t; } x.n++; }
    }
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    const list = Object.keys(days).sort().filter(d => d < today && days[d].n >= 3).map(d => days[d]);
    if (list.length < nDays + 1) return null;
    let sum = 0;
    for (let i = list.length - nDays; i < list.length; i++) {
      const pc = list[i-1].c, x = list[i];
      sum += Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)) / pc * 100;
    }
    return sum / nDays;
  }
  const atrPct = dailyAtrPct(h4Candles, ATR_DAYS);
  if (USE_ATR_FILTER && signal !== 'NONE') {
    if (atrPct === null) return [{json:{signal:'NONE',error:`ATR nicht berechenbar: zu wenige H4-Kerzen (${h4Candles.length})`,botId:BOT_ID}}];
    if (atrPct < ATR_MIN_PCT) return [{json:{signal:'NONE',error:`ATR-Pause: ATR14 ${atrPct.toFixed(2)} % < ${ATR_MIN_PCT} %`,atrPct:Number(atrPct.toFixed(3)),botId:BOT_ID}}];
  }

  return [{json:{
    signal,
    botId: BOT_ID,
    symbol: SYMBOL,
    orderType: 'LIMIT',
    currentPrice: Number(currentClose.toFixed(2)),
    limitLevel:  signal !== 'NONE' ? Number(fibLevel.toFixed(1)) : 0,
    stopLevel:   signal !== 'NONE' ? Number(slLevel.toFixed(1)) : 0,
    profitLevel: signal !== 'NONE' ? Number(tpLevel.toFixed(1)) : 0,
    size,
    riskUsd,
    expirationHours: EXPIRATION_HOURS,
    fibLevel: Number(fibLevel.toFixed(1)),
    rr: rr > 0 ? rr.toFixed(2) : '0.00',
    trend: sh1?.price > sh2?.price ? 'UP' : sl1?.price < sl2?.price ? 'DOWN' : 'NONE',
    h4Trend,
    entryReason,
    trailingConfig,
    atrPct: atrPct === null ? null : Number(atrPct.toFixed(3)),
    version: 'v5.0-F618ATR-FTMO'
  }}];

} catch (error) {
  return [{ json: { signal: 'NONE', error: error.message } }];
}
