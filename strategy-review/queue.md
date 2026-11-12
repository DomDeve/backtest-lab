# Ideen-Queue FTMO-Review (priorisiert)

Regeln: eine Änderung je Experiment, Suche nur auf Entwicklungsdaten (Dukascopy ohne Tresor-Jahre), vorher
`experiments.jsonl` + `archiv/` prüfen. Ideen, die Risikomanagement berühren, nur notieren (unten).

## Offen

1. **DE40 Confluence 3 ins Lab holen** (läuft in d_ftmo, fehlt im Lab) – Code-Node per `tools/export-code-nodes.py` nach
   `strategies-live/ftmo/`, DAX Combined Check (d_ftmo) in `runner.js` portieren, Familie `DE40_FTMO`. Ohne das ist die
   FTMO-Kontosimulation unvollständig. Achtung: DE40 auf Dukascopy nur eingeschränkt testbar, wenn der Code Volumen nutzt.
2. **Stundenfenster um die US-Eröffnung** – Plateau-Nachbarn von `ftmo-rv-h15` (ohne 14+15 bzw. 15+16 Uhr) waren besser
   (+0,121 / +0,115R). Nur als neues Experiment mit eigenem Grund, nicht als Nachjustierung von h15.
3. **ATR-Pause (ATR_MIN_PCT 1,6 %) auf langer Historie** – legt ganze Monate still (06/2024, 07–09/2025, 01/2026, 09/2026).
   Capital-Raster 1,2–2,0 % existiert (`nas-atr-*`), lange Historie fehlt.
4. **Wochentag-Muster auf Dukascopy-Entwicklungsjahren** (nicht Capital) – Muster-Analyse auf dem langen Lauf.
5. **Ausstieg**: TP-Extension (FIB_EXTENSION) auf langer Historie – Trailing war schlechter, TP-Lage noch nicht geprüft.
6. **Zweites Instrument für das Konto** (Realitätscheck: ein Bot liefert ~2R/Monat) – nur mit Live-Code-Variante im Lab.

## Nur notiert (gesperrt – Risikomanagement)

- Tageslimit „2 gefüllte Trades/Tag“ (seit 10.11.2026 live): Backtest Capital 2024–26 Ø +0,152R (427 Tr.) gegenüber
  +0,193R (358 Tr.) mit altem Zählen; Dukascopy +0,048R vs. +0,064R. Σ R ähnlich (64,7 vs. 69,1R Capital). Entscheidung liegt bei Dominique.
