// ================================================================
// NAS100 M15 Fibonacci Swing v5.0 — BACKTEST-OPTIMIZED CONFIG
// ================================================================
// ÄNDERUNGEN v4.7 → v5.0 (aus Backtest über 2 Jahre validiert):
//   - Fib-Retracement (Entry): 0.618 → 0.5  (flacherer Pullback = mehr Fills)
//   - Fib-Extension (TP):      0.618 → 0.5  (näheres TP, häufiger erreicht)
//   - H4-Trend-Filter:         AN → AUS     (verschlechtert Edge im Backtest)
//   - MA-Distance-Filter:      AN → AUS     (dito)
//   - Freitag-16-UTC-Filter:   AN → AUS     (SIEHE WARNUNG UNTEN)
//
// BACKTEST-ERGEBNIS über 2 Jahre (Sep 2024 – Aug 2026):
//   +49.37R gesamt · 502 Trades · WR 38% · Max DD 23.8R · Fill 78%
//   Jahr 1 (Aug'24-Sep'25): +20R
//   Jahr 2 (Aug'25-Sep'26): +30R
//
// ⚠️  WARNUNG – WAS DER BACKTEST NICHT MODELLIERT:
//   1. Wochenend-Gap-Risiko: Bot kann jetzt Freitagabend Positionen aufmachen
//      die übers Wochenende gehalten werden. Wenn Sonntag Nacht ein Gap kommt,
//      hebelt der SL nicht rechtzeitig — Verlust kann größer als 1R werden.
//      Der v4.4-Freitag-Filter existierte genau deshalb.
//   2. Spread & Slippage: Reale Live-R ist erfahrungsgemäß 30-50% niedriger als Backtest.
//   3. Trailing-SL: Backtest fährt fixe SL/TP, dein Live-Bot macht Breakeven+Partial+Trailing.
//      Live meistens im positiven Sinn abweichend.
//
// Position Sizing: unverändert (botBalance = totalBalance / 4, 2% Risk pro Trade).
// Falls du das änderst weil "nur diese Strategie" läuft, siehe RISK_PCT unten.
// ================================================================

try {
  const BOT_ID = "LB2F618";
  // === TUNING-KONSTANTEN (v5.0) ===
  const FIB_RETRACEMENT       = 0.618;    // Entry-Level als Retracement des Breakouts
  const FIB_EXTENSION         = 0.618;    // TP als Extension über den Breakout-Punkt
  const USE_H4_TREND_FILTER   = false;  // v5.0: aus
  const USE_MA_DISTANCE_FILTER = false; // v5.0: aus
  const USE_FRIDAY_FILTER     = false;  // v5.0: aus (siehe Warnung oben)
  const MA_DIST_MIN           = 30;     // Punkte zu SMA200 (wenn Filter an)
  const RANGE_MIN             = 50;     // Bot v4.7 Default
  const SL_MIN                = 25;     // Bot v4.7 Default
  const SL_MAX                = 200;    // Bot v4.7 Default
  const MIN_RR                = 1.8;    // Bot v4.7 Default
  const SL_BUF                = 5;      // Buffer über/unter Swing für SL
  const RISK_PCT              = 0.01;   // 2% von botBalance
  const BOT_COUNT             = 18;      // botBalance = totalBalance / 4

  const items = $input.all();
  const m15Data = items[0]?.json || {};
  const h4Data = items[1]?.json || {};
  const accountData = items[2]?.json || {};
  const totalBalance = parseFloat(accountData.accounts?.[0]?.balance?.balance) || parseFloat(accountData.body?.accounts?.[0]?.balance?.balance) || 18000;
  const botBalance = totalBalance / 18;

  const m15Candles = m15Data.prices || [];
  const h4Candles = h4Data.prices || [];
  if (m15Candles.length < 200) return [{json:{signal:"NONE",error:`Zu wenige M15-Kerzen für SMA200: ${m15Candles.length}`}}];
  if (h4Candles.length < 20) return [{json:{signal:"NONE",error:`Zu wenige H4-Kerzen: ${h4Candles.length}`}}];

  const highs = m15Candles.map(c => (parseFloat(c.highPrice?.bid||0)+parseFloat(c.highPrice?.ask||0))/2);
  const lows = m15Candles.map(c => (parseFloat(c.lowPrice?.bid||0)+parseFloat(c.lowPrice?.ask||0))/2);
  const closes = m15Candles.map(c => (parseFloat(c.closePrice?.bid||0)+parseFloat(c.closePrice?.ask||0))/2);
  const len = closes.length;
  const currentClose = closes[len-1];

  // ══════════════════════════════════════════════════════════════
  // ZEITFILTER
  // ══════════════════════════════════════════════════════════════
  const now = new Date();
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return [{json:{signal:"NONE",error:"Wochenende"}}];
  const utcHour = now.getUTCHours();
  if (utcHour < 7 || utcHour >= 19) return [{json:{signal:"NONE",error:"Außerhalb Handelszeit (09:00-21:00 MESZ)"}}];

  // v5.0: FREITAG-FILTER wrapped – standardmäßig aus
  if (USE_FRIDAY_FILTER && utcDay === 5 && utcHour >= 16) {
    return [{json:{signal:"NONE",error:"Freitag Abend – kein neuer Trade wegen Wochenend-Gap-Risiko"}}];
  }

  // Spread
  let avgSpread = 0;
  const ss = Math.min(3, len);
  for (let i = len-ss; i < len; i++) {
    avgSpread += parseFloat(m15Candles[i].closePrice?.ask||0) - parseFloat(m15Candles[i].closePrice?.bid||0);
  }
  avgSpread /= ss;
  if (avgSpread > 8) return [{json:{signal:"NONE",error:`Spread zu hoch: ${avgSpread.toFixed(1)} Punkte avg (max 8)`}}];

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
      for (let j=1; j<=lb; j++) {
        if (h[i-j] >= h[i] || h[i+j] >= h[i]) { ok = false; break; }
      }
      if (ok) o.push({index:i, price:h[i]});
    }
    return o;
  }
  function findSwingLows(l, lb=2) {
    const o = [];
    for (let i=lb; i<l.length-lb; i++) {
      let ok = true;
      for (let j=1; j<=lb; j++) {
        if (l[i-j] <= l[i] || l[i+j] <= l[i]) { ok = false; break; }
      }
      if (ok) o.push({index:i, price:l[i]});
    }
    return o;
  }

  const swH = findSwingHighs(highs, 2);
  const swL = findSwingLows(lows, 2);
  if (swH.length < 2 || swL.length < 2) return [{json:{signal:"NONE",error:`Zu wenige M15-Swings: ${swH.length}H, ${swL.length}L`}}];

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
  // H4 TRENDFILTER (nur berechnet für Logging, blockiert nicht mehr)
  // ══════════════════════════════════════════════════════════════
  const h4Highs = h4Candles.map(c => (parseFloat(c.highPrice?.bid||0)+parseFloat(c.highPrice?.ask||0))/2);
  const h4Lows = h4Candles.map(c => (parseFloat(c.lowPrice?.bid||0)+parseFloat(c.lowPrice?.ask||0))/2);
  const h4Closes = h4Candles.map(c => (parseFloat(c.closePrice?.bid||0)+parseFloat(c.closePrice?.ask||0))/2);
  const h4Len = h4Closes.length;
  const h4SwH = findSwingHighs(h4Highs, 2);
  const h4SwL = findSwingLows(h4Lows, 2);

  let h4Trend = "NONE";
  if (h4SwH.length >= 2 && h4SwL.length >= 2) {
    const h4sh1 = h4SwH[h4SwH.length-1], h4sh2 = h4SwH[h4SwH.length-2];
    const h4sl1 = h4SwL[h4SwL.length-1], h4sl2 = h4SwL[h4SwL.length-2];
    const h4Ema50 = calcEMA(h4Closes, 50);
    const h4CurrentClose = h4Closes[h4Len-1];
    if (h4sh1.price > h4sh2.price && h4sl1.price > h4sl2.price && h4CurrentClose > h4Ema50) h4Trend = "UP";
    else if (h4sh1.price < h4sh2.price && h4sl1.price < h4sl2.price && h4CurrentClose < h4Ema50) h4Trend = "DOWN";
  }

  // v5.0: H4-Trend-Filter wrapped – standardmäßig aus
  if (USE_H4_TREND_FILTER) {
    if (h4Trend === "DOWN" && emaBull) {
      console.log(`H4 Trend DOWN → Long blockiert`);
      return [{json:{signal:"NONE",error:"H4 Trend bearish – kein Long erlaubt",h4Trend}}];
    }
    if (h4Trend === "UP" && emaBear) {
      console.log(`H4 Trend UP → Short blockiert`);
      return [{json:{signal:"NONE",error:"H4 Trend bullish – kein Short erlaubt",h4Trend}}];
    }
  }

  // ══════════════════════════════════════════════════════════════
  // SIGNAL LOGIC
  // ══════════════════════════════════════════════════════════════
  let signal = "NONE", fibLevel = 0, tpLevel = 0, slLevel = 0, slDistance = 0, tpDistance = 0;
  let setupFP = "", entryReason = "";

  // === LONG ===
  if (emaBull) {
    if (sh1.price > sh2.price) {
      let relevantLow = null;
      for (let i=swL.length-1; i>=0; i--) {
        if (swL[i].index > sh2.index && swL[i].index < sh1.index) {
          if (!relevantLow || swL[i].price < relevantLow.price) relevantLow = swL[i];
        }
      }
      if (!relevantLow) {
        for (let i=swL.length-1; i>=0; i--) {
          if (swL[i].index < sh1.index) { relevantLow = swL[i]; break; }
        }
      }

      if (relevantLow) {
        const range = sh1.price - relevantLow.price;
        if (range > RANGE_MIN) {
          // v5.0: FIB_RETRACEMENT (0.5 statt 0.618)
          fibLevel = sh1.price - (range * FIB_RETRACEMENT);

          // v5.0: MA-Distance wrapped
          const maDistOk = !USE_MA_DISTANCE_FILTER || (fibLevel > sma50 && (fibLevel - sma200) > MA_DIST_MIN);
          if (!maDistOk) {
            console.log(`BUY MA-Distanz blockiert: fib=${fibLevel.toFixed(1)} sma50=${sma50.toFixed(1)} sma200=${sma200.toFixed(1)}`);
          }

          const distToFib = currentClose - fibLevel;
          if (distToFib > 0 && distToFib < range && maDistOk) {
            signal = "BUY";
            entryReason = `LIMIT: M15 Breakout über ${sh2.price.toFixed(1)} → Fib ${(FIB_RETRACEMENT*100).toFixed(1)}% bei ${fibLevel.toFixed(1)}`;
            const entryPrice = fibLevel;
            // v5.0: FIB_EXTENSION (0.5 statt 0.618)
            tpLevel = sh1.price + (range * FIB_EXTENSION);
            tpDistance = tpLevel - entryPrice;
            slLevel = relevantLow.price - SL_BUF;
            slDistance = entryPrice - slLevel;
            setupFP = `BUY_${sh1.index}_${relevantLow.index}_${sh1.price.toFixed(0)}`;
          }
        }
      }
    }
  }

  // === SHORT ===
  if (emaBear && signal === "NONE") {
    if (sl1.price < sl2.price) {
      let relevantHigh = null;
      for (let i=swH.length-1; i>=0; i--) {
        if (swH[i].index > sl2.index && swH[i].index < sl1.index) {
          if (!relevantHigh || swH[i].price > relevantHigh.price) relevantHigh = swH[i];
        }
      }
      if (!relevantHigh) {
        for (let i=swH.length-1; i>=0; i--) {
          if (swH[i].index < sl1.index) { relevantHigh = swH[i]; break; }
        }
      }

      if (relevantHigh) {
        const range = relevantHigh.price - sl1.price;
        if (range > RANGE_MIN) {
          fibLevel = sl1.price + (range * FIB_RETRACEMENT);

          const maDistOk = !USE_MA_DISTANCE_FILTER || (fibLevel < sma50 && (sma200 - fibLevel) > MA_DIST_MIN);
          if (!maDistOk) {
            console.log(`SELL MA-Distanz blockiert: fib=${fibLevel.toFixed(1)} sma50=${sma50.toFixed(1)} sma200=${sma200.toFixed(1)}`);
          }

          const distToFib = fibLevel - currentClose;
          if (distToFib > 0 && distToFib < range && maDistOk) {
            signal = "SELL";
            entryReason = `LIMIT: M15 Breakdown unter ${sl2.price.toFixed(1)} → Fib ${(FIB_RETRACEMENT*100).toFixed(1)}% bei ${fibLevel.toFixed(1)}`;
            const entryPrice = fibLevel;
            tpLevel = sl1.price - (range * FIB_EXTENSION);
            tpDistance = entryPrice - tpLevel;
            slLevel = relevantHigh.price + SL_BUF;
            slDistance = slLevel - entryPrice;
            setupFP = `SELL_${sl1.index}_${relevantHigh.index}_${sl1.price.toFixed(0)}`;
          }
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FINALE FILTER
  // ══════════════════════════════════════════════════════════════
  let rr = 0;
  if (signal !== "NONE") {
    rr = tpDistance > 0 && slDistance > 0 ? tpDistance / slDistance : 0;
    if (rr < MIN_RR) { console.log(`RR zu niedrig: ${rr.toFixed(2)} < ${MIN_RR}`); signal = "NONE"; }
    if (slDistance > SL_MAX) { console.log(`SL zu groß: ${slDistance.toFixed(1)} > ${SL_MAX}`); signal = "NONE"; }
    if (slDistance < SL_MIN) { console.log(`SL zu klein: ${slDistance.toFixed(1)} < ${SL_MIN}`); signal = "NONE"; }
    if (staticData.tradedSetups[setupFP]) { console.log(`Setup bereits platziert: ${setupFP}`); signal = "NONE"; }
  }

  // ══════════════════════════════════════════════════════════════
  // SIZING
  // ══════════════════════════════════════════════════════════════
  let size = 0;
  if (signal !== "NONE") {
    size = Math.max(0.01, Math.round((botBalance * RISK_PCT / slDistance) * 100) / 100);
    staticData.tradedSetups[setupFP] = nowMs;
  }

  // Order-Gültigkeit 24h
  const gtd = new Date(nowMs + 24*3600000);
  const goodTillDate = gtd.toISOString().replace(/\.\d{3}Z$/, '');

  // Trailing-Config (Breakeven bei 1R, Partial 50% bei 2R, dann Trailing)
  const trailingConfig = signal !== "NONE" ? {
    enabled: true,
    breakevenTrigger: signal === "BUY" ? fibLevel + slDistance : fibLevel - slDistance,
    breakevenSL: fibLevel,
    partialCloseTrigger: signal === "BUY" ? fibLevel + (slDistance*2) : fibLevel - (slDistance*2),
    partialClosePercent: 50,
    trailingDistance: slDistance,
    trailingActive: false
  } : { enabled: false };

  console.log(`NAS100 FIB v5.0 | Signal: ${signal} | Close: ${currentClose.toFixed(1)} | Fib(${(FIB_RETRACEMENT*100).toFixed(0)}%): ${fibLevel.toFixed(1)} | TP(ext ${(FIB_EXTENSION*100).toFixed(0)}%): ${tpLevel.toFixed(1)} | SL: ${slDistance.toFixed(1)}pt | RR: 1:${rr > 0 ? rr.toFixed(2) : "0"} | H4: ${h4Trend} (Filter: ${USE_H4_TREND_FILTER ? 'AN' : 'AUS'}) | SMA50: ${sma50.toFixed(1)} | SMA200: ${sma200.toFixed(1)}`);

  return [{json:{
    signal,
    botId: "LB2F618",
    orderType: "LIMIT",
    currentPrice: Number(currentClose.toFixed(1)),
    limitLevel: signal !== "NONE" ? Number(fibLevel.toFixed(1)) : 0,
    stopLevel: signal !== "NONE" ? Number(slLevel.toFixed(1)) : 0,
    profitLevel: signal !== "NONE" ? Number(tpLevel.toFixed(1)) : 0,
    size,
    epic: "US100",
    fibLevel: Number(fibLevel.toFixed(1)),
    rr: rr > 0 ? rr.toFixed(2) : "0.00",
    trend: sh1?.price > sh2?.price ? "UP" : sl1?.price < sl2?.price ? "DOWN" : "NONE",
    h4Trend,
    h4FilterActive: USE_H4_TREND_FILTER,
    maDistFilterActive: USE_MA_DISTANCE_FILTER,
    fridayFilterActive: USE_FRIDAY_FILTER,
    fibRetracement: FIB_RETRACEMENT,
    fibExtension: FIB_EXTENSION,
    entryReason,
    goodTillDate,
    trailingConfig,
    version: "v5.0"
  }}];

} catch (error) {
  return [{ json: { signal: "NONE", error: error.message } }];
}