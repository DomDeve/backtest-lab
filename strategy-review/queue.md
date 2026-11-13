# Ideen-Queue FTMO-Review (priorisiert)

Regeln: eine Änderung je Experiment, Suche nur auf Entwicklungsdaten (Dukascopy ohne Tresor-Jahre), vorher
`experiments.jsonl` + `archiv/` prüfen. Ideen, die Risikomanagement berühren, nur notieren (unten).

## Offen

1. **DE40 Confluence 3: Entscheidung Dominique** (seit 13.11.2026 im Lab, `ftmo-de40-c3`) – Backtest klar negativ
   (Capital −0,17R, Dukascopy −0,17R t −2,5), senkt P(beide Phasen) des Kontos von 0,88 auf 0,53 (Capital). Frage an Dominique,
   ob ein Vorschlag „Bot in d_ftmo deaktivieren“ ausgearbeitet werden soll. Danach ggf. Varianten (TP 1–1,5R, ohne Confluence) –
   Volumen-Abhängigkeit beachten (cTrader-Tickvolumen ≠ Capital/Dukascopy).
2. **Stundenfenster um die US-Eröffnung** – Plateau-Nachbarn von `ftmo-rv-h15` (ohne 14+15 bzw. 15+16 Uhr) waren besser
   (+0,121 / +0,115R). Nur als neues Experiment mit eigenem Grund, nicht als Nachjustierung von h15.
3. ~~ATR-Pause auf langer Historie~~ – erledigt 13.11.2026 (RV-2026-11-13-01, verworfen).
4. **Wochentag-Muster auf Dukascopy-Entwicklungsjahren** (nicht Capital) – Muster-Analyse auf dem langen Lauf.
5. ~~TP-Extension~~ – erledigt 13.11.2026 (RV-2026-11-13-02, 0,5/0,786/1,0 verworfen). Offen: TP in R statt Fib-Extension.
6. **Zweites Instrument für das Konto** (Realitätscheck: ein Bot liefert ~2R/Monat) – nur mit Live-Code-Variante im Lab.
7. **NAS_FTMO-Familie: Tagesstopp-Reihenfolge** – im Lab wird die NAS-Strategie bei aktivem Tagesstopp noch aufgerufen und erst danach
   blockiert, live läuft sie gar nicht (Befund Port DE40, 13.11.2026). Wirkung vermutlich klein, prüfen.

## Nur notiert (gesperrt – Risikomanagement)

- Tageslimit „2 gefüllte Trades/Tag“ (seit 10.11.2026 live): Backtest Capital 2024–26 Ø +0,152R (427 Tr.) gegenüber
  +0,193R (358 Tr.) mit altem Zählen; Dukascopy +0,048R vs. +0,064R. Σ R ähnlich (64,7 vs. 69,1R Capital). Entscheidung liegt bei Dominique.
