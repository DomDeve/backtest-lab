// ============================================================
// DAX40 – VOLUME PROFILE LVN RETEST STRATEGY v3.4 (Multi-Bot)
// ============================================================
// v3.4 CHANGES (vs. v3.3):
//   - LVN neu definiert: echtes Volumen-Tal zwischen zwei Peaks
//     (vorher: unterstes Viertel der Value Area → bestand nie den
//     Qualitätsfilter, 0 Signale in KW 42)
//   - LVN_QUALITY_MAX = max. Tal-Tiefe (Tal-Volumen / kleinerer Nachbar-Peak)
//   - Vortagesprofil nur Xetra-Session 09:00–17:30 (vorher 24h)
//   - Fallback: Profil des laufenden Tages, wenn das Vortagesprofil
//     kein Setup liefert (Gap-/Trendtage)
//   - Eigener Filtergrund LVN_QUALITY (vorher als DISTANCE_TO_LVN getarnt)
//   - SL_MIN: Mindest-Stopabstand
//   - Feste Bin-Größe in Punkten statt 70 Bins
//
// KLONEN: nur BOT_ID, BOT_NAME und CONFIG anpassen.
// ============================================================
try {

  // ============================================================
  // BOT CONFIG — nur dieser Block unterscheidet sich zwischen Bots
  // ============================================================
  const BOT_ID   = "de40lvn07";
  const BOT_NAME = "DAX LVN Quality 0.7";

  const CONFIG = {
    ADX_MIN:                 20,      // 0 = ADX-Filter aus
    DISTANCE_TO_LVN_MIN:     15,
    DISTANCE_TO_LVN_MAX:     100,
    LVN_QUALITY_MAX:         0.7,    // max. Tal-Tiefe: Tal-Volumen / kleinerer Nachbar-Peak
    HVN_TARGET_MIN_RR:       1.8,
    SL_PUFFER:               8,
    CONFLUENCE_MIN:          2,
    MAX_TRADES_PER_DAY:      2,
    TRADE_MIDDAY:            false,   // 13:00-15:30 Berlin handelbar
    // v3.4
    BIN_SIZE:                5,      // Punkte pro Volumen-Bin
    PEAK_WINDOW_PTS:         40,     // Suchfenster für Nachbar-Peaks um ein Tal
    SL_MIN:                  15,     // Mindest-Stopabstand in Punkten
    USE_INTRADAY_PROFILE:    true    // Fallback auf Tagesprofil ab 09:00
  };
  // ============================================================

  const items = $input.all();
  const m5Data       = items[0]?.json || {};
  const accountData  = items[1]?.json || {};
  const h1Data       = items[2]?.json || {};
  const m15Data      = items[3]?.json || {};

  const totalBalance = parseFloat(accountData.accounts?.[0]?.balance?.balance) ||
                       parseFloat(accountData.body?.accounts?.[0]?.balance?.balance) || 18000;
  const botBalance = totalBalance / 18;
  const RISK_PCT = 0.01;

  const m5Candles  = m5Data.prices || [];
  const h1Candles  = h1Data.prices || [];
  const m15Candles = m15Data.prices || [];

  // ============================================================
  // ZEITZONEN-HELPER (Europe/Berlin, DST-safe)
  // ============================================================
  function getBerlinParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(date);
    const get = (t) => parts.find(p => p.type === t)?.value;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      hour: parseInt(get('hour')),
      minute: parseInt(get('minute')),
      totalMin: parseInt(get('hour')) * 60 + parseInt(get('minute')),
      weekday: dayMap[get('weekday')]
    };
  }
  function getBerlinFromUTCString(utcString) {
    if (!utcString) return null;
    const normalized = utcString.endsWith('Z') ? utcString : utcString + 'Z';
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return null;
    return getBerlinParts(d);
  }
  const nowBerlin     = getBerlinParts(new Date());
  const todayBerlin   = nowBerlin.date;
  const berlinTimeStr = `${String(nowBerlin.hour).padStart(2,'0')}:${String(nowBerlin.minute).padStart(2,'0')}`;

  // ============================================================
  // BASIS-FUNKTIONEN
  // ============================================================
  function getMid(candle, field) {
    return (parseFloat(candle[field]?.bid || 0) + parseFloat(candle[field]?.ask || 0)) / 2;
  }
  function calcEMA(values, period) {
    if (values.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
    return ema;
  }
  function calcADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return 0;
    const highs = candles.map(c => getMid(c, 'highPrice'));
    const lows  = candles.map(c => getMid(c, 'lowPrice'));
    const closes = candles.map(c => getMid(c, 'closePrice'));
    const trList = [], plusDmList = [], minusDmList = [];
    for (let i = 1; i < candles.length; i++) {
      const highDiff = highs[i] - highs[i - 1];
      const lowDiff  = lows[i - 1] - lows[i];
      plusDmList.push((highDiff > lowDiff && highDiff > 0) ? highDiff : 0);
      minusDmList.push((lowDiff > highDiff && lowDiff > 0) ? lowDiff : 0);
      trList.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
    let trS = trList.slice(0, period).reduce((a,b)=>a+b,0);
    let pdmS = plusDmList.slice(0, period).reduce((a,b)=>a+b,0);
    let mdmS = minusDmList.slice(0, period).reduce((a,b)=>a+b,0);
    const dxList = [];
    for (let i = period; i < trList.length; i++) {
      trS  = trS  - (trS / period)  + trList[i];
      pdmS = pdmS - (pdmS / period) + plusDmList[i];
      mdmS = mdmS - (mdmS / period) + minusDmList[i];
      const pDI = trS > 0 ? (pdmS / trS) * 100 : 0;
      const mDI = trS > 0 ? (mdmS / trS) * 100 : 0;
      const sum = pDI + mDI;
      dxList.push(sum > 0 ? (Math.abs(pDI - mDI) / sum) * 100 : 0);
    }
    if (dxList.length < period) return 0;
    let adx = dxList.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < dxList.length; i++) adx = (adx * (period - 1) + dxList[i]) / period;
    return adx;
  }

  // ============================================================
  // ZEITFILTER (Xetra-Open 09:00 Berlin)
  // ============================================================
  function getTradingPhase(bt) {
    if (bt.weekday === 0 || bt.weekday === 6) return 'CLOSED';
    const m = bt.totalMin;
    if (m >=  9*60      && m < 10*60     ) return 'OPENING_RANGE';
    if (m >= 10*60      && m < 11*60 + 30) return 'PRIME_ENTRY';
    if (m >= 11*60 + 30 && m < 13*60     ) return 'SECONDARY_ENTRY';
    if (m >= 13*60      && m < 15*60 + 30) return 'MIDDAY';
    if (m >= 15*60 + 30 && m < 17*60 + 30) return 'US_SPILLOVER';
    return 'CLOSED';
  }
  const phase = getTradingPhase(nowBerlin);
  const isTradeableWindow = (phase === 'PRIME_ENTRY' || phase === 'SECONDARY_ENTRY' || phase === 'US_SPILLOVER'
                             || (phase === 'MIDDAY' && CONFIG.TRADE_MIDDAY === true));

  // ============================================================
  // STATIC DATA + FILTER STATS (pro Bot getrennt)
  // ============================================================
  const staticData = $getWorkflowStaticData('node');

  const setupsKey = `de40_setups_${BOT_ID}`;
  if (!staticData[setupsKey]) staticData[setupsKey] = {};
  const nowMs = Date.now();
  for (const fp in staticData[setupsKey]) {
    if (nowMs - staticData[setupsKey][fp] > 24 * 3600000) delete staticData[setupsKey][fp];
  }

  const filterStatsKey = `de40_filter_stats_${BOT_ID}`;
  if (!staticData[filterStatsKey]) staticData[filterStatsKey] = {};
  if (staticData[filterStatsKey].date !== todayBerlin) {
    staticData[filterStatsKey] = { date: todayBerlin, summarySent: false, counters: {} };
  }
  const stats = staticData[filterStatsKey];

  function trackStop(reason) {
    if (!isTradeableWindow) return;
    stats.counters[reason] = (stats.counters[reason] || 0) + 1;
  }
  function maybeGenerateDailySummary() {
    if (nowBerlin.totalMin < 17*60) return null;
    if (stats.summarySent) return null;
    const counters = stats.counters || {};
    const total = Object.values(counters).reduce((a,b) => a+b, 0);
    if (total === 0) return null;
    const sorted = Object.entries(counters).sort((a,b) => b[1] - a[1]);
    const lines = sorted.map(([k,v]) => `• <code>${k}</code>: ${v}`).join('\n');
    stats.summarySent = true;
    return `📊 <b>${BOT_NAME} – Tages-Filterreport</b>\n📅 ${todayBerlin}\n🔢 Runs in Trade-Fenstern: ${total}\n\n<b>Filter-Aktivität:</b>\n${lines}`;
  }

  // Konsistente Default-Felder für alle Return-Pfade
  function emptyTradingFields() {
    return {
      size: 0,
      currentPrice: 0,
      limitLevel: 0,
      stopLevel: 0,
      profitLevel: 0,
      referenceLevel: 0,
      goodTillDate: "",
      epic: "DE40",
      botId: BOT_ID,
      Bot: BOT_NAME
    };
  }
  function stopWithReason(reason, extra = {}) {
    trackStop(reason);
    const dailySummary = maybeGenerateDailySummary();
    const out = {
      signal: "NONE",
      reason,
      berlinTime: berlinTimeStr,
      phase,
      botId: BOT_ID,
      Bot: BOT_NAME,
      dailyFilterStats: { ...stats.counters },
      ...emptyTradingFields()
    };
    if (dailySummary) out.dailySummary = dailySummary;
    Object.assign(out, extra);
    return [{ json: out }];
  }
  function silentStop(reason, extra = {}) {
    const dailySummary = maybeGenerateDailySummary();
    const out = {
      signal: "NONE",
      reason,
      berlinTime: berlinTimeStr,
      phase,
      botId: BOT_ID,
      Bot: BOT_NAME,
      ...emptyTradingFields()
    };
    if (dailySummary) out.dailySummary = dailySummary;
    Object.assign(out, extra);
    return [{ json: out }];
  }

  // ============================================================
  // FRÜHE SANITY CHECKS
  // ============================================================
  if (m5Candles.length < 50)  return silentStop(`Zu wenige M5-Kerzen: ${m5Candles.length}`);
  if (h1Candles.length < 20)  return silentStop(`Zu wenige H1-Kerzen: ${h1Candles.length}`);
  if (m15Candles.length < 50) return silentStop(`Zu wenige M15-Kerzen: ${m15Candles.length}`);
  if (phase === 'CLOSED' || phase === 'OPENING_RANGE' || (phase === 'MIDDAY' && CONFIG.TRADE_MIDDAY !== true)) {
    return silentStop(`Phase: ${phase}`);
  }

  // ============================================================
  // OR-SANITY
  // ============================================================
  const openingRangeCandles = m5Candles.filter(c => {
    const bt = getBerlinFromUTCString(c.snapshotTimeUTC);
    if (!bt) return false;
    return bt.date === todayBerlin && bt.totalMin >= 9*60 && bt.totalMin < 10*60;
  });
  if (openingRangeCandles.length < 6) {
    return stopWithReason("OR_INCOMPLETE", { orCandleCount: openingRangeCandles.length });
  }
  const orHighs = openingRangeCandles.map(c => getMid(c, 'highPrice'));
  const orLows  = openingRangeCandles.map(c => getMid(c, 'lowPrice'));
  const openingHigh = Math.max(...orHighs);
  const openingLow  = Math.min(...orLows);
  const orRangeSize = openingHigh - openingLow;
  const recentM5Ranges = m5Candles.slice(-60).map(c => getMid(c, 'highPrice') - getMid(c, 'lowPrice'));
  const avgM5Range = recentM5Ranges.reduce((a,b) => a+b, 0) / recentM5Ranges.length;
  if (orRangeSize < 15) return stopWithReason("OR_TOO_SMALL", { rangeSize: Number(orRangeSize.toFixed(0)) });
  if (orRangeSize > avgM5Range * 15) return stopWithReason("OR_TOO_LARGE", { rangeSize: Number(orRangeSize.toFixed(0)) });

  // ============================================================
  // AKTUELLER PREIS + SPREAD
  // ============================================================
  const lastCandle = m5Candles[m5Candles.length - 1];
  const currentClose = getMid(lastCandle, 'closePrice');
  const spread = parseFloat(lastCandle.closePrice?.ask || 0) - parseFloat(lastCandle.closePrice?.bid || 0);
  if (spread > 4) return stopWithReason("SPREAD_HIGH", { spread: Number(spread.toFixed(1)) });

  // ============================================================
  // ADX-FILTER
  // ============================================================
  const currentADX = calcADX(m5Candles, 14);
  if (CONFIG.ADX_MIN > 0 && currentADX < CONFIG.ADX_MIN) {
    return stopWithReason("ADX_TOO_LOW", { adx: Number(currentADX.toFixed(1)), threshold: CONFIG.ADX_MIN });
  }

  // ============================================================
  // H1-TREND
  // ============================================================
  const h1Closes = h1Candles.map(c => getMid(c, 'closePrice'));
  const h1_ema9  = calcEMA(h1Closes, 9);
  const h1_ema21 = calcEMA(h1Closes, 21);
  const h1_ema50 = calcEMA(h1Closes, 50);
  const h1Bull = h1_ema9 > h1_ema50;
  const h1Bear = h1_ema9 < h1_ema50;
  const h1Trend = h1Bull ? "UP" : (h1Bear ? "DOWN" : "NEUTRAL");

  // ============================================================
  // VWAP
  // ============================================================
  const todayCandles = m5Candles.filter(c => {
    const bt = getBerlinFromUTCString(c.snapshotTimeUTC);
    return bt && bt.date === todayBerlin;
  });
  let cumPV = 0, cumVol = 0;
  for (const c of todayCandles) {
    const typical = (getMid(c, 'highPrice') + getMid(c, 'lowPrice') + getMid(c, 'closePrice')) / 3;
    const vol = parseFloat(c.lastTradedVolume || 1);
    cumPV += typical * vol;
    cumVol += vol;
  }
  const vwap = cumVol > 0 ? cumPV / cumVol : currentClose;

  // ============================================================
  // VOLUME PROFILE ENGINE v3.4
  //   - Feste Bin-Größe in Punkten (CONFIG.BIN_SIZE), 3er-Glättung
  //   - LVN = echtes Volumen-Tal: lokales Minimum, Tiefe = Volumen /
  //     min(linker Peak, rechter Peak) innerhalb ±PEAK_WINDOW_PTS
  //   - HVN = lokales Maximum (±PEAK_WINDOW_PTS) mit Volumen ≥ Ø-Bin
  //   - POC / VAH / VAL wie bisher (für Confluence + Output)
  // ============================================================
  function buildVolumeProfile(candles, binSize) {
    if (!candles || candles.length < 5) return null;
    const highs = candles.map(c => getMid(c, 'highPrice'));
    const lows  = candles.map(c => getMid(c, 'lowPrice'));
    const priceMin = Math.min(...lows);
    const priceMax = Math.max(...highs);
    const priceRange = priceMax - priceMin;
    if (priceRange < binSize * 5) return null;
    const binCount = Math.ceil(priceRange / binSize) + 1;
    const bins = new Array(binCount).fill(0);
    for (const c of candles) {
      const high = getMid(c, 'highPrice');
      const low  = getMid(c, 'lowPrice');
      const vol  = parseFloat(c.lastTradedVolume || 1);
      const startIdx = Math.max(0, Math.floor((low - priceMin) / binSize));
      const endIdx = Math.min(binCount - 1, Math.floor((high - priceMin) / binSize));
      const span = endIdx - startIdx + 1;
      for (let i = startIdx; i <= endIdx; i++) bins[i] += vol / span;
    }
    // Glättung (3er-Mittel)
    const sm = bins.map((v, i) => {
      const a = bins[Math.max(0, i - 1)], b = v, c = bins[Math.min(binCount - 1, i + 1)];
      return (a + b + c) / 3;
    });
    const totalVol = bins.reduce((a, b) => a + b, 0);
    const avgBinVol = totalVol / binCount;

    // POC + Value Area (70 %)
    let pocIdx = 0;
    for (let i = 1; i < binCount; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;
    let vaVol = bins[pocIdx], vaLow = pocIdx, vaHigh = pocIdx;
    while (vaVol < totalVol * 0.7 && (vaLow > 0 || vaHigh < binCount - 1)) {
      const up = vaHigh < binCount - 1 ? bins[vaHigh + 1] : -1;
      const dn = vaLow > 0 ? bins[vaLow - 1] : -1;
      if (up >= dn) { vaHigh++; vaVol += bins[vaHigh]; } else { vaLow--; vaVol += bins[vaLow]; }
    }
    const idxLow  = i => priceMin + i * binSize;
    const idxHigh = i => priceMin + (i + 1) * binSize;

    // Täler + Spitzen
    const W = Math.max(2, Math.round(CONFIG.PEAK_WINDOW_PTS / binSize));
    const minima = [];
    const maxima = [];
    for (let i = 1; i < binCount - 1; i++) {
      const left  = sm.slice(Math.max(0, i - W), i);
      const right = sm.slice(i + 1, Math.min(binCount, i + 1 + W));
      if (!left.length || !right.length) continue;
      const lPeak = Math.max(...left), rPeak = Math.max(...right);
      if (sm[i] <= sm[i - 1] && sm[i] <= sm[i + 1] && sm[i] < lPeak && sm[i] < rPeak) {
        minima.push({ idx: i, depth: sm[i] / Math.min(lPeak, rPeak), vol: sm[i] });
      }
      if (sm[i] >= lPeak && sm[i] >= rPeak && sm[i] >= avgBinVol) {
        maxima.push({ idx: i, vol: sm[i] });
      }
    }
    // Benachbarte Indizes zu Zonen gruppieren
    function group(points, pick) {
      const zones = [];
      for (const p of points) {
        const last = zones[zones.length - 1];
        if (last && p.idx <= last.toIdx + 1) { last.toIdx = p.idx; last.members.push(p); }
        else zones.push({ fromIdx: p.idx, toIdx: p.idx, members: [p] });
      }
      return zones.map(z => {
        const best = z.members.reduce(pick);
        return {
          low: idxLow(z.fromIdx), high: idxHigh(z.toIdx),
          center: (idxLow(z.fromIdx) + idxHigh(z.toIdx)) / 2,
          depth: best.depth, volume: best.vol
        };
      });
    }
    const lvnZones = group(minima, (a, b) => (b.depth < a.depth ? b : a));
    const hvnZones = group(maxima, (a, b) => (b.vol > a.vol ? b : a));

    return {
      poc: priceMin + (pocIdx + 0.5) * binSize,
      vah: idxHigh(vaHigh), val: idxLow(vaLow),
      priceMin, priceMax, binSize, totalVol, avgBinVol,
      lvnZones, hvnZones
    };
  }

  function subtractBusinessDays(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00Z');
    let remaining = days;
    while (remaining > 0) {
      d.setUTCDate(d.getUTCDate() - 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) remaining--;
    }
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  const inXetra = bt => bt.totalMin >= 9*60 && bt.totalMin < 17*60 + 30;

  // Vortagesprofil — nur Xetra-Session (09:00–17:30 Berlin)
  const priorBusinessDay = subtractBusinessDays(todayBerlin, 1);
  const priorDayM15 = m15Candles.filter(c => {
    const bt = getBerlinFromUTCString(c.snapshotTimeUTC);
    return bt && bt.date === priorBusinessDay && inXetra(bt);
  });
  const priorDayProfile = buildVolumeProfile(priorDayM15, CONFIG.BIN_SIZE);
  if (!priorDayProfile) {
    return stopWithReason("VP_INSUFFICIENT_DATA", {
      priorBusinessDay,
      m15CandlesForYesterday: priorDayM15.length
    });
  }

  // Wochenprofil (H1, Xetra-Session) — nur Confluence
  const weekAgoDate = subtractBusinessDays(todayBerlin, 5);
  const weeklyH1 = h1Candles.filter(c => {
    const bt = getBerlinFromUTCString(c.snapshotTimeUTC);
    if (!bt) return false;
    if (bt.date < weekAgoDate || bt.date >= todayBerlin) return false;
    return inXetra(bt);
  });
  const weeklyProfile = buildVolumeProfile(weeklyH1, CONFIG.BIN_SIZE);

  // Laufendes Tagesprofil (M5, heute ab 09:00) — Fallback-Quelle
  const todaySessionM5 = m5Candles.filter(c => {
    const bt = getBerlinFromUTCString(c.snapshotTimeUTC);
    return bt && bt.date === todayBerlin && inXetra(bt);
  });

  // ============================================================
  // SIGNAL-LOGIC: LVN-Retest in H1-Trend-Richtung
  // ============================================================
  if (h1Trend === "NEUTRAL") {
    return stopWithReason("H1_TREND_NEUTRAL", {
      h1_ema9: Number(h1_ema9.toFixed(1)),
      h1_ema50: Number(h1_ema50.toFixed(1))
    });
  }
  const isLong = h1Trend === "UP";
  const direction = isLong ? "LONG" : "SHORT";

  function evaluateProfile(profile, source) {
    const dist = z => isLong ? currentClose - z.center : z.center - currentClose;
    const sideLVNs = profile.lvnZones.filter(z => isLong ? z.high < currentClose : z.low > currentClose);
    if (!sideLVNs.length) {
      return { ok: false, reason: "NO_LVN_FOUND", extra: { source, direction, totalLVNs: profile.lvnZones.length } };
    }
    const inWindow = sideLVNs.filter(z => dist(z) >= CONFIG.DISTANCE_TO_LVN_MIN && dist(z) <= CONFIG.DISTANCE_TO_LVN_MAX);
    if (!inWindow.length) {
      return { ok: false, reason: "DISTANCE_TO_LVN", extra: {
        source, direction,
        nearestLVNDist: Number(Math.min(...sideLVNs.map(dist)).toFixed(0)),
        min: CONFIG.DISTANCE_TO_LVN_MIN, max: CONFIG.DISTANCE_TO_LVN_MAX } };
    }
    const deep = inWindow.filter(z => z.depth < CONFIG.LVN_QUALITY_MAX).sort((a, b) => dist(a) - dist(b));
    if (!deep.length) {
      return { ok: false, reason: "LVN_QUALITY", extra: {
        source, direction,
        bestDepth: Number(Math.min(...inWindow.map(z => z.depth)).toFixed(2)),
        required: CONFIG.LVN_QUALITY_MAX } };
    }
    let fail = null;
    for (const lvn of deep) {
      const targets = profile.hvnZones
        .filter(z => isLong ? z.low > lvn.high : z.high < lvn.low)
        .sort((a, b) => isLong ? a.center - b.center : b.center - a.center)
        .slice(0, 2);
      if (!targets.length) {
        fail = fail || { ok: false, reason: "NO_HVN_TARGET", extra: { source, direction, entryLVN: Number(lvn.center.toFixed(1)) } };
        continue;
      }
      const limit = lvn.center;
      let stop = isLong ? lvn.low - CONFIG.SL_PUFFER : lvn.high + CONFIG.SL_PUFFER;
      if (Math.abs(limit - stop) < CONFIG.SL_MIN) stop = isLong ? limit - CONFIG.SL_MIN : limit + CONFIG.SL_MIN;
      for (const hvn of targets) {
        const slDist = Math.abs(limit - stop);
        const tpDist = Math.abs(hvn.center - limit);
        const rr = slDist > 0 ? tpDist / slDist : 0;
        if (rr >= CONFIG.HVN_TARGET_MIN_RR) {
          return { ok: true, source, entryLVN: lvn, targetHVN: hvn,
                   limitLevel: limit, stopLevel: stop, profitLevel: hvn.center,
                   referenceLevel: isLong ? lvn.low : lvn.high };
        }
        fail = { ok: false, reason: "HVN_TARGET_DISTANCE", extra: {
          source, direction, rr: Number(rr.toFixed(2)), required: CONFIG.HVN_TARGET_MIN_RR,
          entryLVN: Number(limit.toFixed(1)), targetHVN: Number(hvn.center.toFixed(1)) } };
      }
    }
    return fail;
  }

  let chosen = evaluateProfile(priorDayProfile, "PRIOR_DAY");
  const priorReason = chosen.ok ? null : chosen.reason;
  if (!chosen.ok && CONFIG.USE_INTRADAY_PROFILE && todaySessionM5.length >= 12) {
    const todayProfile = buildVolumeProfile(todaySessionM5, CONFIG.BIN_SIZE);
    if (todayProfile) {
      const ev = evaluateProfile(todayProfile, "TODAY");
      if (ev.ok) chosen = ev;
      else chosen = { ...ev, extra: { ...ev.extra, priorReason } };
    }
  }
  if (!chosen.ok) {
    return stopWithReason(chosen.reason, chosen.extra);
  }

  const signal = isLong ? "BUY" : "SELL";
  const { entryLVN, targetHVN, limitLevel, stopLevel, profitLevel, referenceLevel } = chosen;
  const lvnSource = chosen.source;

  // ============================================================
  // CONFLUENCE-SYSTEM
  // ============================================================
  let confluenceScore = 0;
  let confluenceDetails = [];
  if (signal === "BUY" && currentClose > vwap) { confluenceScore++; confluenceDetails.push("Über VWAP"); }
  if (signal === "SELL" && currentClose < vwap) { confluenceScore++; confluenceDetails.push("Unter VWAP"); }
  if (signal === "BUY" && h1_ema9 > h1_ema21 && h1_ema21 > h1_ema50) {
    confluenceScore++; confluenceDetails.push("H1 Full-Bull-Stack");
  }
  if (signal === "SELL" && h1_ema9 < h1_ema21 && h1_ema21 < h1_ema50) {
    confluenceScore++; confluenceDetails.push("H1 Full-Bear-Stack");
  }
  if (weeklyProfile) {
    if (signal === "BUY" && weeklyProfile.poc > limitLevel) {
      confluenceScore++; confluenceDetails.push("Weekly POC über Entry");
    }
    if (signal === "SELL" && weeklyProfile.poc < limitLevel) {
      confluenceScore++; confluenceDetails.push("Weekly POC unter Entry");
    }
  }
  if (signal === "BUY" && profitLevel >= priorDayProfile.poc) {
    confluenceScore++; confluenceDetails.push("TP ≥ Prior-Day POC");
  }
  if (signal === "SELL" && profitLevel <= priorDayProfile.poc) {
    confluenceScore++; confluenceDetails.push("TP ≤ Prior-Day POC");
  }
  if (currentADX > 28) { confluenceScore++; confluenceDetails.push(`ADX stark (${currentADX.toFixed(0)})`); }

  if (confluenceScore < CONFIG.CONFLUENCE_MIN) {
    return stopWithReason(signal === "BUY" ? "CONFLUENCE_LOW_LONG" : "CONFLUENCE_LOW_SHORT", {
      confluenceScore, required: CONFIG.CONFLUENCE_MIN,
      details: confluenceDetails.join(', ')
    });
  }

  // ============================================================
  // SETUP-FINGERPRINT (verhindert Doppel-Orders — pro Bot)
  // ============================================================
  const setupFP = `${BOT_ID}_${signal}_${Math.round(limitLevel)}_${todayBerlin}`;
  if (staticData[setupsKey][setupFP]) {
    return stopWithReason("SETUP_ALREADY_PLACED", {
      setupFP,
      firstSeenMinAgo: Number(((nowMs - staticData[setupsKey][setupFP]) / 60000).toFixed(1))
    });
  }

  // ============================================================
  // POSITION SIZING
  // ============================================================
  const slDistance = Math.abs(limitLevel - stopLevel);
  const tpDistance = Math.abs(profitLevel - limitLevel);
  const rr = slDistance > 0 ? tpDistance / slDistance : 0;
  const riskAmount = botBalance * RISK_PCT;
  const rawSize = riskAmount / slDistance;
  const size = Math.max(0.001, Math.round(rawSize * 1000) / 1000);

  staticData[setupsKey][setupFP] = nowMs;
  trackStop(signal === "BUY" ? "SIGNAL_BUY" : "SIGNAL_SELL");
  const dailySummary = maybeGenerateDailySummary();

  // Order-Gültigkeit: heute 19:00 Berlin. Capital.com liest goodTillDate als UTC
  // (geprüft: gesendet 10:05:07 → goodTillDateUTC 10:05:07, goodTillDate 12:05:07)
  const GTD_BERLIN_HOUR = 19;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(nowMs));
  const guessMs = Date.parse(`${ymd}T${String(GTD_BERLIN_HOUR).padStart(2, '0')}:00:00Z`);
  const hourAtGuess = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(guessMs)));
  const gtdMs = guessMs - (hourAtGuess - GTD_BERLIN_HOUR) * 3600000;
  const gtd = new Date(Math.max(gtdMs, nowMs + 30 * 60000)); // mind. 30 Min Laufzeit
  const goodTillDate = gtd.toISOString().replace(/\.\d{3}Z$/, '');

  console.log(`[${BOT_ID}] ${berlinTimeStr} Berlin | Signal: ${signal} | Phase: ${phase} | Close: ${currentClose.toFixed(1)} | LVN-Entry: ${limitLevel.toFixed(1)} | HVN-Target: ${profitLevel.toFixed(1)} | SL: ${stopLevel.toFixed(1)} (${slDistance.toFixed(0)}pt) | RR: 1:${rr.toFixed(2)} | ADX: ${currentADX.toFixed(1)} | H1: ${h1Trend} | Confluence: ${confluenceScore}/5 [${confluenceDetails.join(', ')}] | Size: ${size}`);

  const output = {
    signal,
    orderType: "LIMIT",
    botId: BOT_ID,
    Bot: BOT_NAME,
    berlinTime: berlinTimeStr,
    currentPrice: Number(currentClose.toFixed(1)),
    limitLevel: Number(limitLevel.toFixed(1)),
    stopLevel: Number(stopLevel.toFixed(1)),
    profitLevel: Number(profitLevel.toFixed(1)),
    referenceLevel: Number(referenceLevel.toFixed(1)),
    size,
    goodTillDate,
    epic: "DE40",
    entryLVN: {
      low: Number(entryLVN.low.toFixed(1)),
      high: Number(entryLVN.high.toFixed(1)),
      center: Number(entryLVN.center.toFixed(1)),
      volume: Number(entryLVN.volume.toFixed(0)),
      depth: Number(entryLVN.depth.toFixed(2))
    },
    lvnSource,
    targetHVN: {
      low: Number(targetHVN.low.toFixed(1)),
      high: Number(targetHVN.high.toFixed(1)),
      center: Number(targetHVN.center.toFixed(1)),
      volume: Number(targetHVN.volume.toFixed(0))
    },
    priorDayPOC: Number(priorDayProfile.poc.toFixed(1)),
    priorDayVAH: Number(priorDayProfile.vah.toFixed(1)),
    priorDayVAL: Number(priorDayProfile.val.toFixed(1)),
    weeklyPOC: weeklyProfile ? Number(weeklyProfile.poc.toFixed(1)) : null,
    adx: Number(currentADX.toFixed(1)),
    h1Trend,
    vwap: Number(vwap.toFixed(1)),
    confluenceScore,
    confluenceDetails: confluenceDetails.join(', '),
    rr: Number(rr.toFixed(2)),
    slDistance: Number(slDistance.toFixed(1)),
    tpDistance: Number(tpDistance.toFixed(1)),
    phase,
    setupFP,
    dailyFilterStats: { ...stats.counters }
  };
  if (dailySummary) output.dailySummary = dailySummary;

  return [{ json: output }];

} catch (error) {
  return [{ json: {
    signal: "NONE",
    error: error.message,
    stack: error.stack,
    size: 0,
    currentPrice: 0,
    limitLevel: 0,
    stopLevel: 0,
    profitLevel: 0,
    referenceLevel: 0,
    goodTillDate: "",
    epic: "DE40",
    botId: typeof BOT_ID !== 'undefined' ? BOT_ID : "unknown",
    Bot: typeof BOT_NAME !== 'undefined' ? BOT_NAME : "unknown"
  } }];
}