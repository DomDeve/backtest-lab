// VORLAGE für ein neues Strategie-Modul.
// Kopieren, umbenennen (z.B. nas100-fib.js), in src/strategies/index.js registrieren.
//
// Wichtig für vertrauenswürdige Backtests:
//   * Logik möglichst 1:1 aus dem n8n-Code-Node übernehmen (gleiche Signalpreise, Rundungen, Zeitfenster).
//   * onBar() wird NACH Abschluss einer Kerze aufgerufen. Was du zurückgibst, wird zum OPEN der
//     nächsten Kerze ausgeführt – genau wie der Bot, der ~10 s nach Kerzenschluss läuft.
//   * Nie auf zukünftige Kerzen zugreifen. ctx enthält nur Abgeschlossenes.
//
// ctx-Felder in onBar():
//   bar        aktuelle (gerade abgeschlossene) Kerze { t, date, hm, wd, bo,bh,bl,bc, ao,ah,al,ac, vol, flags }
//   hm, date   lokale Zeit (Europe/Berlin) dieser Kerze
//   dayBars    alle abgeschlossenen Kerzen des Tages bis inkl. bar
//   byHm       dieselben Kerzen als Map 'HH:MM' -> Kerze
//   prevDays   Kerzen-Arrays der Vortage (Anzahl = historyDays), ältester zuerst
//   dayContext Tagesmerkmale (ctx_atr14, ctx_gapRel, ...) – nur Vergangenheitsdaten
//   position   null oder { dir, entry, stop, tp, entryHm, features }
//   tradesToday Anzahl Einstiege heute
//   state      dein Speicher (über Kerzen/Tage hinweg)
//   params     defaults + Overrides aus der Config
//
// Rückgabe: Array von Aktionen
//   { type:'ENTER', dir:'BUY'|'SELL', stop, refPrice?, tp? | tpR?, features?:{...} }
//       refPrice = Preis, mit dem der Bot die Größe berechnet (sonst Fill-Preis)
//       features = Merkmale zum Zeitpunkt des Signals -> landen in der Muster-Analyse
//   { type:'EXIT', reason:'TEXT' }             Markt-Ausstieg zur nächsten Kerze
//   { type:'MODIFY', stop?, tp? }              SL/TP sofort ändern (gilt ab nächster Kerze)

export default {
  id: 'template',
  name: 'Vorlage',
  symbol: 'XXX',
  description: 'Beschreibung der Regeln in einem Satz',
  historyDays: 5, // wie viele Vortage in ctx.prevDays gehalten werden
  defaults: {
    halfSpread: 0, // falls der Bot mit Bid + halbem Spread rechnet
    filters: [], // generische Einstiegsfilter (siehe engine.js failsFilters)
  },
  grid: {
    // param: [werte] – für `bt optimize`
  },
  createState() { return {}; },
  onDay({ date, prevDays, state, params }) {
    // Tages-Reset, Profile aus Vortagen berechnen
  },
  onBar(ctx) {
    return [];
  },
};
