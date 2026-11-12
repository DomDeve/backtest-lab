// Broker-Kosten je Trade (Kommission, Swap, Zusatz-Slippage) aus config/kosten_broker.json.
// Der Spread steckt bereits in den Kursen (Kauf Ask / Verkauf Bid) und wird hier NICHT noch einmal abgezogen.
// Ergebnis in Kontowährung und in R (Kosten / Risikobetrag des Trades).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'kosten_broker.json');
let cache = null;
export function loadCosts(file = FILE) { if (!cache || file !== FILE) { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (file !== FILE) return c; cache = c; } return cache; }

/** Profil zum Variantentyp: FTMO-Familie -> ftmo, sonst capital. */
export const profileName = (variant) => (variant?.family === 'NAS_FTMO' || variant?.opts?.ftmo ? 'ftmo' : 'capital');

const dateFmt = new Map();
function ymdIn(t, tz) {
  let f = dateFmt.get(tz); if (!f) dateFmt.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f.format(new Date(t));
}

/**
 * Swap-Nächte zwischen entryT und exitT (ms UTC). Rollover täglich um rolloverHour (Ortszeit tz).
 * weekendDaily = true: jede Kalendernacht zählt (Capital-Indizes, auch Sa/So).
 * sonst: nur Rollover, die einen Werktag (Mo–Fr) abschließen; am Dreifach-Wochentag zählt er 3.
 * Rückgabe { nights (Anzahl Rollover), charged (berechnete Tage) }.
 */
export function swapNights(entryT, exitT, tz, tripleWeekday, { rolloverHour = 0, weekendDaily = false } = {}) {
  const shift = ((24 - rolloverHour) % 24) * 3600000; // ab rolloverHour gehört die Zeit zum nächsten Handelstag
  let nights = 0, charged = 0;
  let d = ymdIn(entryT + shift, tz);
  const end = ymdIn(exitT + shift, tz);
  while (d < end) { // Handelstag d endet zwischen Ein- und Ausstieg
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (weekendDaily) { nights++; charged++; }
    else if (wd >= 1 && wd <= 5) { nights++; charged += wd === tripleWeekday ? 3 : 1; }
    const n = new Date(Date.parse(d + 'T12:00:00Z') + 86400000); d = n.toISOString().slice(0, 10);
  }
  return { nights, charged };
}

/**
 * Kosten eines geschlossenen Trades.
 * t = { dir, entry (Preis), entryT, exitT, size (Einheiten wie im Runner: pnl = pts * size * pointValue), pointValue, riskMoney,
 *       fill ('LIMIT'|'MARKET'|'GAP'), reason }
 * Swap: swap_mode 'points' = Punkte je Lot und Nacht (× swap_point), 'pct' = % vom Positionswert je Nacht (negativ = Belastung).
 * Slippage: slippage_stop_pts bei Stop-/Zwangsausstiegen (SL, SL_GAP, Freitag, FTMO-Stopp, Datenende), slippage_market_pts bei Markt-Einstiegen.
 */
export function tradeCosts(t, epic, profile = 'capital', opts = {}) {
  const C = opts.config || loadCosts(); const P = C.profile[profile]; const e = P?.epics?.[epic];
  if (!e) return { commission: 0, swap: 0, slippage: 0, nights: 0, charged: 0, swapKnown: false, total: 0, costR: 0 };
  const units = t.size * (t.pointValue || 1); const lots = units / e.contract_size;
  const comm = (opts.commissionOverride ?? e.commission_per_lot_rt) * lots;
  const { nights, charged } = swapNights(t.entryT, t.exitT, P.rollover_tz, e.triple_weekday, { rolloverHour: P.rollover_hour || 0, weekendDaily: !!e.weekend_daily });
  const rate = t.dir === 'BUY' ? e.swap_long : e.swap_short; const swapKnown = rate !== null && rate !== undefined;
  let swap = 0;
  // Punkte-Swap gilt für das heutige Kursniveau (swap_ref_price) -> mit Einstiegskurs / Referenzkurs skalieren (Finanzierung ∝ Positionswert)
  const lvl = e.swap_ref_price && t.entry ? t.entry / e.swap_ref_price : 1;
  if (swapKnown) swap = e.swap_mode === 'pct' ? -(rate / 100) * t.entry * units * charged : -rate * e.swap_point * e.contract_size * lots * charged * lvl; // + = Kosten
  const stopExit = /^(SL|FREITAG|FTMO|END|DATENLUECKE)/.test(t.reason || '') || /_EOD$/.test(t.reason || '');
  const slipStop = opts.slippageOverride ?? e.slippage_stop_pts ?? 0, slipMkt = opts.slippageOverride ?? e.slippage_market_pts ?? 0;
  const slipLvl = e.slippage_ref_price && t.entry ? t.entry / e.slippage_ref_price : 1; // gemessen auf heutigem Kursniveau -> skalieren
  const slippage = ((stopExit ? slipStop : 0) + (t.fill === 'MARKET' || t.fill === 'GAP' ? slipMkt : 0)) * units * slipLvl;
  // Empfindlichkeit --spread capital: Spread-Unterschied Capital − Dukascopy zur Einstiegsstunde (gemessener Median, config/spread_profil.json)
  let spreadAdj = 0;
  if (opts.spreadProfile) { const h = String(new Date(t.entryT).getUTCHours()).padStart(2, '0'); const d = opts.spreadProfile[epic]?.[h]?.diff; if (Number.isFinite(d)) spreadAdj = d * units; }
  const total = comm + swap + slippage + spreadAdj;
  return { commission: comm, swap, slippage, spreadAdj, nights, charged, swapKnown, total, costR: t.riskMoney ? total / t.riskMoney : 0 };
}
