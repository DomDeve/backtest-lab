// ================================================================
// EURUSD Bot v3.0 – Varianten-Template (C1–C6)
//
// Drei Entry-Ansätze, gesteuert über ENTRY_MODE:
//   LEGACY        – alte v2.9-Entry-Logik OHNE Overextension-Filter (Kontrollgruppe)
//   EMA_PULLBACK  – Trend (H1+M15), Rücklauf zur EMA21 (M5), Einstieg wenn
//                   die letzte geschlossene Kerze wieder in Trendrichtung schließt
//   BREAK_RETEST  – sequenziell: Phase 1 erkennt M15-Struktur-Bruch + M5-FVG und
//                   speichert das Setup, Phase 2 steigt beim Retest der FVG ein
//                   (MARKET) bzw. legt sofort eine Limit-Order in die FVG-Mitte (LIMIT)
//
// Gemeinsam: H1- und M15-Trend müssen übereinstimmen, ADX(M15) >= 20,
//            ATR(M5) >= 2 Pips, Spread <= 2 Pips, Distanz-Cooldown, Direction-Lock
//
// Sizing: botBalance = totalBalance / 18, Risiko 1 % pro Trade
//
// Inputs (unverändert): items[0]=Account, [1]=M15, [2]=M5, [3]=H1
//
// Hinweis: Signale werden auf der letzten GESCHLOSSENEN M5-Kerze geprüft
//          (Index length-2), der Entry-Preis ist der aktuelle Kurs (length-1).
// ================================================================

try {
  // ══════════════════════════════════════════════════════════════
  // VARIANTEN-KONSTANTEN – pro Code-Node anpassen (siehe Tabelle)
  // ══════════════════════════════════════════════════════════════
  const BOT_ID            = "EUC1LEGTP1";      // Prefix der dealReference
  const ENTRY_MODE        = "LEGACY";   // "LEGACY" | "EMA_PULLBACK" | "BREAK_RETEST"
  const ORDER_TYPE        = "MARKET";         // "MARKET" | "LIMIT" (LIMIT nur mit BREAK_RETEST)
  const TP_RR             = 1.0;              // TP = TP_RR × SL
  const SL_ATR_MULTIPLIER = 2.0;              // SL für LEGACY / EMA_PULLBACK (BREAK_RETEST: strukturell)

  // ══════════════════════════════════════════════════════════════
  // GEMEINSAME KONSTANTEN
  // ══════════════════════════════════════════════════════════════
  const BALANCE_DIVISOR        = 18;
  const RISK_PCT               = 0.01;
  const MIN_ATR_PIPS           = 2;
  const MIN_ADX                = 20;
  const MAX_SPREAD_PIPS        = 2;
  const SL_MIN_PIPS            = 5;
  const SL_MAX_PIPS            = 20;
  const PULLBACK_LOOKBACK      = 3;    // EMA21 muss in den letzten 3 geschlossenen Kerzen berührt worden sein
  const PULLBACK_TOUCH_ATR     = 0.2;  // Toleranz um die EMA21
  const PULLBACK_MAX_DEPTH_ATR = 1.5;  // tieferer Rücklauf = Trend wackelt, kein Entry
  const PULLBACK_MAX_EXT_ATR   = 1.5;  // Kurs darf beim Entry nicht schon wieder weit weg sein
  const RETEST_WINDOW_MIN      = 60;   // so lange wartet ein Break-&-Retest-Setup
  const BREAK_MAX_AGE_M15      = 4;    // Struktur-Bruch darf max. 4 M15-Kerzen (1 h) alt sein
  const FVG_LOOKBACK           = 12;   // M5-Kerzen, in denen die FVG entstanden sein muss
  const MIN_FVG_ATR            = 0.2;  // Mindestgröße der FVG
  const SL_BUFFER_ATR          = 0.3;  // Puffer hinter der FVG für den strukturellen SL
  const COOLDOWN_ATR           = 1.5;  // Mindestabstand zum letzten Entry
  const DIRECTION_LOCK_H       = 3;
  const PIP                    = 0.0001;

  const none = (reason, extra = {}) => [{ json: {
    signal: "NONE", botId: BOT_ID, entryMode: ENTRY_MODE, orderType: ORDER_TYPE,
    reason, error: reason, ...extra
  } }];

  if (!["LEGACY", "EMA_PULLBACK", "BREAK_RETEST"].includes(ENTRY_MODE)) {
    return none(`Konfigurationsfehler: unbekannter ENTRY_MODE "${ENTRY_MODE}"`);
  }
  if (!["MARKET", "LIMIT"].includes(ORDER_TYPE)) {
    return none(`Konfigurationsfehler: unbekannter ORDER_TYPE "${ORDER_TYPE}"`);
  }
  if (ORDER_TYPE === "LIMIT" && ENTRY_MODE !== "BREAK_RETEST") {
    return none("Konfigurationsfehler: LIMIT nur mit BREAK_RETEST");
  }

  // ══════════════════════════════════════════════════════════════
  // DATEN
  // ══════════════════════════════════════════════════════════════
  const items = $input.all();
  const accountData = items[0]?.json || {};
  const parse = raw => (raw || []).map(c => ({
    time:   c.snapshotTimeUTC || c.snapshotTime || "",
    open:  (parseFloat(c.openPrice?.bid  || 0) + parseFloat(c.openPrice?.ask  || 0)) / 2,
    high:  (parseFloat(c.highPrice?.bid  || 0) + parseFloat(c.highPrice?.ask  || 0)) / 2,
    low:   (parseFloat(c.lowPrice?.bid   || 0) + parseFloat(c.lowPrice?.ask   || 0)) / 2,
    close: (parseFloat(c.closePrice?.bid || 0) + parseFloat(c.closePrice?.ask || 0)) / 2,
    spread: parseFloat(c.closePrice?.ask || 0) - parseFloat(c.closePrice?.bid || 0)
  }));

  const c15 = parse(items[1]?.json?.prices);
  const c5  = parse(items[2]?.json?.prices);
  const c1h = parse(items[3]?.json?.prices);

  if (c5.length < 60)  return none(`Zu wenige M5 Kerzen: ${c5.length}`);
  if (c15.length < 60) return none(`Zu wenige M15 Kerzen: ${c15.length}`);
  if (c1h.length < 55) return none(`Zu wenige H1 Kerzen: ${c1h.length}`);

  const totalBalance = parseFloat(accountData.accounts?.[0]?.balance?.balance) || 18000;
  const botBalance = totalBalance / BALANCE_DIVISOR;

  // ══════════════════════════════════════════════════════════════
  // ZEIT / SPREAD / NEWS
  // ══════════════════════════════════════════════════════════════
  const now = new Date();
  const nowMs = now.getTime();
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return none("Wochenende");
  const utcHour = now.getUTCHours();
  if (utcHour >= 19 || utcHour < 6) return none("Außerhalb Handelszeit");

  const spreadSample = c5.slice(-3);
  const avgSpreadPips = spreadSample.reduce((s, c) => s + c.spread, 0) / spreadSample.length / PIP;
  if (avgSpreadPips > MAX_SPREAD_PIPS) return none(`Spread zu hoch: ${avgSpreadPips.toFixed(1)} Pips (max ${MAX_SPREAD_PIPS})`);

  function getNYHourMinute() {
    const year = now.getUTCFullYear();
    const dstStart = new Date(Date.UTC(year, 2, 1));
    dstStart.setUTCDate(1 + (7 - dstStart.getUTCDay()) % 7 + 7); dstStart.setUTCHours(7);
    const dstEnd = new Date(Date.UTC(year, 10, 1));
    dstEnd.setUTCDate(1 + (7 - dstEnd.getUTCDay()) % 7); dstEnd.setUTCHours(6);
    const offset = (now >= dstStart && now < dstEnd) ? -4 : -5;
    const ny = new Date(nowMs + offset * 3600000);
    return { hour: ny.getUTCHours(), minute: ny.getUTCMinutes() };
  }
  const ny = getNYHourMinute();
  if (ny.hour === 8 && ny.minute >= 25 && ny.minute <= 55) return none("News-Fenster aktiv");

  // ══════════════════════════════════════════════════════════════
  // STATE (pro BOT_ID isoliert)
  // ══════════════════════════════════════════════════════════════
  const sd = $getWorkflowStaticData('node');
  const K = name => `${name}_${BOT_ID}`;
  if (!sd[K('fp')]) sd[K('fp')] = {};
  for (const fp in sd[K('fp')]) {
    if (nowMs - sd[K('fp')][fp] > 12 * 3600000) delete sd[K('fp')][fp];
  }
  const lastTrade = sd[K('lastTrade')] || null;
  let setup = sd[K('setup')] || null;
  if (setup && nowMs > setup.expiresAt) { delete sd[K('setup')]; setup = null; }

  // ══════════════════════════════════════════════════════════════
  // HILFSFUNKTIONEN
  // ══════════════════════════════════════════════════════════════
  function emaSeries(data, period) {
    const out = new Array(data.length).fill(null);
    if (data.length < period) return out;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = ema;
    for (let i = period; i < data.length; i++) { ema = data[i] * k + ema * (1 - k); out[i] = ema; }
    return out;
  }

  function calcATR(c, period = 14) {
    const tr = [];
    for (let i = 1; i < c.length; i++) {
      tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
    }
    const recent = tr.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  function calcADX(c, period = 14) {
    if (c.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
    const tr = [], pDMs = [], mDMs = [];
    for (let i = 1; i < c.length; i++) {
      tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
      const up = c[i].high - c[i-1].high, down = c[i-1].low - c[i].low;
      pDMs.push(up > down && up > 0 ? up : 0);
      mDMs.push(down > up && down > 0 ? down : 0);
    }
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let pDM = pDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let mDM = mDMs.slice(0, period).reduce((a, b) => a + b, 0);
    const dx = []; let pDI = 0, mDI = 0;
    for (let i = period; i < tr.length; i++) {
      atr = atr - atr / period + tr[i];
      pDM = pDM - pDM / period + pDMs[i];
      mDM = mDM - mDM / period + mDMs[i];
      pDI = atr > 0 ? pDM / atr * 100 : 0;
      mDI = atr > 0 ? mDM / atr * 100 : 0;
      const sum = pDI + mDI;
      dx.push(sum > 0 ? Math.abs(pDI - mDI) / sum * 100 : 0);
    }
    if (dx.length < period) return { adx: 0, plusDI: 0, minusDI: 0 };
    let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
    return { adx, plusDI: pDI, minusDI: mDI };
  }

  function findSwings(c, lookback = 3) {
    const highs = [], lows = [];
    for (let i = lookback; i < c.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (c[i-j].high >= c[i].high || c[i+j].high >= c[i].high) isHigh = false;
        if (c[i-j].low  <= c[i].low  || c[i+j].low  <= c[i].low)  isLow  = false;
      }
      if (isHigh) highs.push({ index: i, price: c[i].high });
      if (isLow)  lows.push({ index: i, price: c[i].low });
    }
    return { highs, lows };
  }

  function findFVG(c, fromIdx, lookback, dir, minSize) {
    for (let j = fromIdx; j > fromIdx - lookback && j >= 2; j--) {
      if (dir === "BUY" && c[j].low > c[j-2].high && c[j].low - c[j-2].high >= minSize) {
        return { top: c[j].low, bottom: c[j-2].high, time: c[j].time, index: j };
      }
      if (dir === "SELL" && c[j].high < c[j-2].low && c[j-2].low - c[j].high >= minSize) {
        return { top: c[j-2].low, bottom: c[j].high, time: c[j].time, index: j };
      }
    }
    return null;
  }

  const clampSL = d => Math.max(SL_MIN_PIPS * PIP, d);
  const clampAtrSL = d => Math.min(SL_MAX_PIPS * PIP, clampSL(d));
  const fmtTime = ms => new Date(ms).toISOString().slice(11, 16);

  // ══════════════════════════════════════════════════════════════
  // INDIKATOREN
  // ══════════════════════════════════════════════════════════════
  const last5 = c5.length - 1;     // laufende Kerze
  const closed5 = c5.length - 2;   // letzte geschlossene Kerze
  const price = c5[last5].close;

  const atr = calcATR(c5, 14);
  const atrPips = atr / PIP;
  if (atrPips < MIN_ATR_PIPS) return none(`ATR zu niedrig: ${atrPips.toFixed(1)} Pips (min ${MIN_ATR_PIPS})`);

  const adxData = calcADX(c15, 14);
  const adx = adxData.adx;
  if (adx < MIN_ADX) return none(`ADX zu niedrig: ${adx.toFixed(1)} (min ${MIN_ADX})`, { atr: +atrPips.toFixed(1) });

  const ema50_1h  = emaSeries(c1h.map(c => c.close), 50);
  const ema50_15m = emaSeries(c15.map(c => c.close), 50);
  const ema21_5m  = emaSeries(c5.map(c => c.close), 21);

  const h1Last = c1h[c1h.length - 1].close, h1Ema = ema50_1h[c1h.length - 1];
  const m15Last = c15[c15.length - 1].close, m15Ema = ema50_15m[c15.length - 1];

  let bias = "NONE";
  if (h1Last > h1Ema && m15Last > m15Ema) bias = "BUY";
  else if (h1Last < h1Ema && m15Last < m15Ema) bias = "SELL";

  // Setup verwerfen, wenn sich der Trend gedreht hat
  // (ein bereits platziertes Limit bleibt bis goodTillDate bestehen und blockiert neue Orders)
  if (setup && !setup.ordered && setup.direction !== bias) { delete sd[K('setup')]; setup = null; }
  if (setup && setup.ordered) return none(`Limit-Order aktiv bis ${fmtTime(setup.expiresAt)} UTC`);

  if (bias === "NONE") return none("H1- und M15-Trend uneinig", { atr: +atrPips.toFixed(1), adx: +adx.toFixed(1) });

  const swings15 = findSwings(c15, 3);
  const lastSH15 = swings15.highs.length ? swings15.highs[swings15.highs.length - 1].price : 0;
  const lastSL15 = swings15.lows.length  ? swings15.lows[swings15.lows.length - 1].price   : 0;

  const isBuy = bias === "BUY";
  let signal = "NONE";
  let entry = price;
  let slDistance = 0;
  let fingerprint = "";
  let entryReason = "";
  let brokenLevel = null;   // für Direction-Lock bei BREAK_RETEST
  let goodTillDate = null;  // nur LIMIT

  // ══════════════════════════════════════════════════════════════
  // ENTRY-MODUS 1: LEGACY (v2.9-Logik ohne Overextension)
  // ══════════════════════════════════════════════════════════════
  if (ENTRY_MODE === "LEGACY") {
    const ema21Last = ema21_5m[last5];
    if (isBuy ? price <= ema21Last : price >= ema21Last) return none("M5 gegen Trend");

    const structBreak = isBuy ? (lastSH15 > 0 && price > lastSH15) : (lastSL15 > 0 && price < lastSL15);
    if (!structBreak) return none("kein M15-Struktur-Bruch");

    if (isBuy ? adxData.plusDI <= adxData.minusDI : adxData.minusDI <= adxData.plusDI) return none("DMI gegen Trend");

    const fvg = findFVG(c5, last5, 15, bias, 0);
    if (!fvg) return none("keine FVG");

    let bulls = 0, bears = 0, bullBody = 0, bearBody = 0;
    for (let i = c5.length - 5; i < c5.length; i++) {
      const body = c5[i].close - c5[i].open;
      if (body > 0) { bulls++; bullBody += body; } else if (body < 0) { bears++; bearBody -= body; }
    }
    const momOk = isBuy ? (bulls >= 3 && bullBody > bearBody * 1.2) : (bears >= 3 && bearBody > bullBody * 1.2);
    if (!momOk) return none("kein Momentum");

    signal = bias;
    slDistance = clampAtrSL(atr * SL_ATR_MULTIPLIER);
    fingerprint = `${bias}_LEG_${fvg.time}`;
    entryReason = `Legacy: StructBreak + FVG + Momentum`;
  }

  // ══════════════════════════════════════════════════════════════
  // ENTRY-MODUS 2: EMA_PULLBACK
  // ══════════════════════════════════════════════════════════════
  if (ENTRY_MODE === "EMA_PULLBACK") {
    const tol = atr * PULLBACK_TOUCH_ATR;
    let touched = false;
    let pbExtreme = isBuy ? Infinity : -Infinity;
    for (let j = closed5 - PULLBACK_LOOKBACK + 1; j <= closed5; j++) {
      if (isBuy) {
        if (c5[j].low <= ema21_5m[j] + tol) touched = true;
        pbExtreme = Math.min(pbExtreme, c5[j].low);
      } else {
        if (c5[j].high >= ema21_5m[j] - tol) touched = true;
        pbExtreme = Math.max(pbExtreme, c5[j].high);
      }
    }
    if (!touched) return none("kein Pullback zur EMA21");

    const emaClosed = ema21_5m[closed5];
    const depth = isBuy ? emaClosed - pbExtreme : pbExtreme - emaClosed;
    if (depth > atr * PULLBACK_MAX_DEPTH_ATR) return none(`Pullback zu tief (${(depth / atr).toFixed(2)}× ATR)`);

    const trig = c5[closed5];
    const trigger = isBuy
      ? (trig.close > trig.open && trig.close > emaClosed)
      : (trig.close < trig.open && trig.close < emaClosed);
    if (!trigger) return none("Pullback ohne Bestätigungskerze");

    const emaNow = ema21_5m[last5];
    const ext = isBuy ? price - emaNow : emaNow - price;
    if (ext < 0) return none("Kurs wieder hinter EMA21");
    if (ext > atr * PULLBACK_MAX_EXT_ATR) return none(`Kurs schon ${(ext / atr).toFixed(2)}× ATR von EMA21 entfernt`);

    signal = bias;
    slDistance = clampAtrSL(atr * SL_ATR_MULTIPLIER);
    fingerprint = `${bias}_PB_${trig.time}`;
    entryReason = `EMA-Pullback (Tiefe ${(depth / atr).toFixed(2)}× ATR)`;
  }

  // ══════════════════════════════════════════════════════════════
  // ENTRY-MODUS 3: BREAK_RETEST (sequenziell)
  // ══════════════════════════════════════════════════════════════
  if (ENTRY_MODE === "BREAK_RETEST") {
    // --- Phase 1: neues Setup erkennen ---
    // Bruch zählt nur, wenn die ERSTE M15-Schlusskerze jenseits des Swings
    // höchstens BREAK_MAX_AGE_M15 Kerzen alt ist (frischer Bruch, kein alter Trend)
    const swingList = isBuy ? swings15.highs : swings15.lows;
    const lastSwing = swingList.length ? swingList[swingList.length - 1] : null;
    const lastClosed15 = c15.length - 2;
    let broke = false;
    if (lastSwing) {
      for (let j = lastSwing.index + 1; j <= lastClosed15; j++) {
        const beyond = isBuy ? c15[j].close > lastSwing.price : c15[j].close < lastSwing.price;
        if (beyond) { broke = (lastClosed15 - j) < BREAK_MAX_AGE_M15; break; }
      }
    }
    let newSetup = false;

    if (broke) {
      const fvg = findFVG(c5, closed5, FVG_LOOKBACK, bias, atr * MIN_FVG_ATR);
      const fp = fvg ? `${bias}_BR_${fvg.time}` : "";
      const canReplace = !setup || (!setup.ordered && setup.fvgTime !== fvg?.time);
      if (fvg && canReplace && !sd[K('fp')][fp]) {
        setup = {
          direction: bias,
          top: fvg.top,
          bottom: fvg.bottom,
          fvgTime: fvg.time,
          brokenLevel: isBuy ? lastSH15 : lastSL15,
          createdAt: nowMs,
          expiresAt: nowMs + RETEST_WINDOW_MIN * 60000,
          ordered: false
        };
        sd[K('setup')] = setup;
        newSetup = true;
      }
    }

    if (!setup) return none(broke ? "Struktur-Bruch ohne passende FVG" : "kein Setup (kein M15-Struktur-Bruch)");

    const buffer = atr * SL_BUFFER_ATR;
    const slLevel = isBuy ? setup.bottom - buffer : setup.top + buffer;

    // Invalidierung: geschlossene Kerze durch die FVG hindurch
    const closedC = c5[closed5].close;
    if (isBuy ? closedC < slLevel : closedC > slLevel) {
      delete sd[K('setup')];
      return none("Setup invalidiert (FVG durchbrochen)");
    }

    brokenLevel = setup.brokenLevel;
    fingerprint = `${bias}_BR_${setup.fvgTime}`;
    const zone = `${setup.bottom.toFixed(5)}–${setup.top.toFixed(5)}`;

    if (ORDER_TYPE === "LIMIT") {
      entry = (setup.top + setup.bottom) / 2;
      slDistance = clampSL(Math.abs(entry - slLevel));
      if (slDistance > SL_MAX_PIPS * PIP) {
        delete sd[K('setup')];
        return none(`SL zu weit (${(slDistance / PIP).toFixed(1)} Pips)`);
      }
      // Limit nur sinnvoll, wenn der Kurs noch nicht durch die Mitte gelaufen ist
      if (isBuy ? price <= entry : price >= entry) {
        delete sd[K('setup')];
        return none("Kurs bereits unter/über Limit-Level");
      }
      goodTillDate = new Date(setup.expiresAt).toISOString().slice(0, 19);
      signal = bias;
      entryReason = `Break&Retest LIMIT in FVG ${zone}${newSetup ? " (neues Setup)" : ""}`;
    } else {
      const inZone = isBuy
        ? (price <= setup.top + atr * 0.1 && price > setup.bottom)
        : (price >= setup.bottom - atr * 0.1 && price < setup.top);
      if (!inZone) return none(`Setup wartet auf Retest ${zone} bis ${fmtTime(setup.expiresAt)} UTC`);

      entry = price;
      slDistance = clampSL(Math.abs(entry - slLevel));
      if (slDistance > SL_MAX_PIPS * PIP) return none(`SL zu weit (${(slDistance / PIP).toFixed(1)} Pips), warte`);
      signal = bias;
      entryReason = `Break&Retest MARKET in FVG ${zone}`;
    }
  }

  if (signal === "NONE") return none("kein Signal");

  // ══════════════════════════════════════════════════════════════
  // DUPLIKAT-, COOLDOWN- UND DIRECTION-LOCK-CHECKS
  // ══════════════════════════════════════════════════════════════
  if (sd[K('fp')][fingerprint]) return none(`Setup bereits gehandelt (${fingerprint})`);

  if (lastTrade) {
    const hoursSince = (nowMs - lastTrade.timestamp) / 3600000;
    const dist = Math.abs(entry - lastTrade.entryPrice);
    if (dist < atr * COOLDOWN_ATR) {
      return none(`Zu nah am letzten Entry (${(dist / PIP).toFixed(1)} < ${(atr * COOLDOWN_ATR / PIP).toFixed(1)} Pips)`);
    }
    if (signal === lastTrade.direction && hoursSince < DIRECTION_LOCK_H) {
      let newStructure;
      if (ENTRY_MODE === "BREAK_RETEST") {
        newStructure = isBuy ? brokenLevel > lastTrade.lastSH15 : brokenLevel < lastTrade.lastSL15;
      } else {
        newStructure = isBuy ? price > lastTrade.lastSH15 : price < lastTrade.lastSL15;
      }
      if (!newStructure) return none(`Direction-Lock ${signal} (${hoursSince.toFixed(1)}h, keine neue Struktur)`);
      entryReason += " | neue Struktur nach Direction-Lock";
    }
  }

  // ══════════════════════════════════════════════════════════════
  // LEVELS, SIZE, STATE
  // ══════════════════════════════════════════════════════════════
  const tpDistance = slDistance * TP_RR;
  const stopLevel   = +(isBuy ? entry - slDistance : entry + slDistance).toFixed(5);
  const profitLevel = +(isBuy ? entry + tpDistance : entry - tpDistance).toFixed(5);
  const size = Math.max(500, Math.round(botBalance * RISK_PCT / slDistance / 100) * 100);

  sd[K('fp')][fingerprint] = nowMs;
  // LIMIT: kein Cooldown/Direction-Lock setzen – eine Order, die nicht gefüllt wird,
  // soll die nächsten Setups nicht 3 h blockieren (setup.ordered + Fingerprint reichen)
  if (ORDER_TYPE !== "LIMIT") {
    sd[K('lastTrade')] = { direction: signal, entryPrice: entry, timestamp: nowMs, lastSH15, lastSL15 };
  }
  if (ENTRY_MODE === "BREAK_RETEST") {
    if (ORDER_TYPE === "LIMIT") { setup.ordered = true; sd[K('setup')] = setup; }
    else delete sd[K('setup')];
  }

  const slPips = +(slDistance / PIP).toFixed(1);
  entryReason += ` | SL ${slPips}p | TP 1:${TP_RR} | ADX ${adx.toFixed(0)} | ATR ${atrPips.toFixed(1)}p`;
  console.log(`${BOT_ID} | ${signal} ${ORDER_TYPE} @ ${entry.toFixed(5)} | ${entryReason}`);

  return [{ json: {
    signal,
    orderType: ORDER_TYPE,
    botId: BOT_ID,
    entryMode: ENTRY_MODE,
    epic: "EURUSD",
    currentPrice: +price.toFixed(5),
    level: +entry.toFixed(5),          // Entry (bei LIMIT das Limit-Level)
    goodTillDate,                      // nur LIMIT, sonst null
    size,
    slDistance: +slDistance.toFixed(5),
    tpDistance: +tpDistance.toFixed(5),
    stopLevel,
    profitLevel,
    slPips,
    tpRR: TP_RR,
    rr: TP_RR.toFixed(2),
    atr: +atrPips.toFixed(1),
    adx: +adx.toFixed(1),
    reason: "Signal",
    entryReason
  } }];

} catch (error) {
  return [{ json: { signal: "NONE", botId: "ERROR", reason: error.message, error: error.message } }];
}