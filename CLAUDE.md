# CLAUDE.md – backtest-lab

Backtest- und Analyse-Engine für Dominiques n8n-Trading-Bots (Capital.com, FTMO via cTrader-Bridge).
Ziel: **Backtests, denen man trauen kann** – deshalb dieselbe JavaScript-Logik wie live, Validierung gegen echte
Live-Trades und Empfehlungen, die gegen Overfitting abgesichert sind.

Sprache: Ausgaben, Reports, Kommentare und Commit-Messages auf **Deutsch**.

## Zwei Engines

1. **Live-Code-Engine (`src/live/`, CLI `bin/live.js`) – Standard für alle Bots.** Führt den *Originaltext* der
   n8n-Code-Nodes aus `strategies-live/` aus. `Date`, `$input`, `$getWorkflowStaticData`, `Intl` und `console` werden
   auf die Simulation umgelenkt (`sandbox.js`). Kerzen bekommt der Code so, wie der Broker sie zu T liefert
   (`candles.js`: Capital inkl. laufender Kerze, FTMO-Bridge nur abgeschlossene). Die Order-Prüfung der Workflows
   (Combined Check NAS v8 / DAX v3, Position Check EURUSD, FTMO-Schutz + Freitag-Glattstellung) ist in `runner.js`
   portiert. Varianten = Originaltext + benannte Patches (`variants.js`, Patches prüfen ihre Fundstellen).
2. **Portierte Engine (`src/core/engine.js`, CLI `bin/bt.js`)** – für Strategien, die als Modul in `src/strategies/`
   nachgebaut sind (DE40 ORB60/NoiseB aus dem Forward-Test). Market-Orders, Ausführung zum nächsten Open.

## Befehle (Live-Code)

```bash
node tools/audit-data.js data/raw                 # Datenprüfung: Lücken, Zeitraum vs. Dateiname, Bid/Ask, M5↔M15/H4
node bin/live.js list                             # alle Varianten (Gruppen)
node bin/live.js run --variants nas-fib61-lb2     # einzelne Variante(n), Komma-getrennt
node bin/live.js run --variants group:FTMO        # Gruppe (Teilstring des Gruppennamens) | all
node bin/live.js combo --base ftmo-basis --cfg '{"fresh":true}' --opts '{"cancelWithoutSignal":true}' --id ftmo-combo --name "Kombi"
node bin/live.js compare                          # out/live/vergleich.html + vergleich.md
```

Kerzendaten: `data/raw/<symbol>/capital_<SYMBOL>_MINUTE_5_*.csv` (Capital-Export mit Bid/Ask). Höhere Zeitebenen
werden aus M5 gebaut (geprüft: identisch mit Capital-M15/H4). Live-Läufe brauchen ~10–70 s je Variante.

## Befehle (portierte Engine)

```bash
npm test                                   # Unit-Tests inkl. Echtdaten-Abgleich (muss immer grün sein)
node bin/bt.js list                        # Strategien
node bin/bt.js clean --config config/de40-orb60.json            # nur Datenqualität prüfen
node bin/bt.js run --config config/de40-orb60.json              # Backtest + Analyse + Report
node bin/bt.js run --config ... --param tpR=2 --set riskPercent=0.5 --from 2025-01-01
node bin/bt.js optimize --config ... [--grid '{"tpR":[null,2,3]}']   # Raster + IS/OOS + Walk-Forward
npm run demo                               # synthetische Daten erzeugen + Demo-Report
```

Ausgabe je Lauf in `out/<name>/`: `report.html` (für Menschen), `summary.md` (kurz, für Telegram/Claude),
`result.json` (alles maschinenlesbar), `trades.csv`, `clean-report.json`.

## Architektur (Live-Code)

```
strategies-live/capital/*.js   Code-Nodes aus d_ilikebigbots (NAS Fib ×5 + F618ATR, DE40 LVN ×6, EURUSD C1–C6) – NICHT editieren
strategies-live/ftmo/*.js      Code-Node aus d_ftmo (NAS F618ATR FTMO)
src/live/sandbox.js            führt Code-Node-Text aus, Shims für Date/Intl/$input/staticData/console
src/live/candles.js            Zeitebenen aus M5, Broker-Sicht zu T (laufende Kerze), Capital-/Bridge-Format
src/live/runner.js             Cron, Order-Prüfung je Familie, Broker (Limit/GTD/Löschen/Market, SL/TP 24/7), FTMO-Regeln
src/live/variants.js           Katalog: Live-Varianten + Test-Varianten (Konstanten, Lookback, Setup-Bedingungen V2–V5)
src/report/compare.js          Gesamtvergleich, Δ zur Basis in beiden Zeithälften
tools/audit-data.js            Datenprüfung
```

## Architektur (portierte Engine)

```
src/core/time.js        Europe/Berlin <-> UTC, DST-sicher, gleiche Semantik wie berlin()/hmList()/utcFor() im Bot
src/core/engine.js      Kerze-für-Kerze-Engine (Ausführungsmodell siehe unten), generische Einstiegsfilter
src/core/context.js     Tagesmerkmale ohne Lookahead (ATR14, Gap, Vortag, 5-Tage-Trend) -> hängen an jedem Trade
src/data/load.js        Capital.com /prices JSON, CSV, flache JSON-Zeilen (n8n Data Table), ZIP, Ordner
src/data/clean.js       Bereinigung: kaputtes entfernen, verdächtiges markieren, Lücken je Tag, Qualitätsbericht
src/strategies/*.js     Strategie-Module (1:1 aus n8n-Code-Nodes); index.js = Registry; _template.js = Vorlage
src/analysis/metrics.js Kennzahlen in R und EUR/%, t-Test, Bootstrap-CI, Tagesverluste
src/analysis/patterns.js Stärken/Schwächen: Segmente (Richtung, Wochentag, Stunde, Umfeld, Strategie-Features),
                        Welch-Test, Benjamini-Hochberg, Konsistenz über 3 Zeitdrittel
src/analysis/exits.js   Was-wäre-wenn-Ausstiege auf denselben Einstiegen (TP, Einstand, engerer SL, Zeit-Exit)
src/analysis/robustness.js Stabilität, Monte-Carlo-Drawdown, FTMO-Challenge-Simulation, Risiko-Vorschlag
src/analysis/optimize.js Raster, IS/OOS, Spearman IS↔OOS, Plateau-Check, verankerter Walk-Forward
src/analysis/compare.js Abgleich Backtest vs. Live (ft_trades, d_tradelog, trades)
src/analysis/recommend.js Pipeline + Empfehlungen; Filter-Empfehlungen werden als echter Backtest nachgerechnet
src/report/html.js|markdown.js Reports
bin/bt.js               CLI
tools/gen-synthetic.js  synthetische Testdaten (nur Pipeline-Test, keine Aussagekraft!)
```

## Ausführungsmodell (nicht ohne Grund ändern)

Entspricht dem Live-Bot, der ~10 s nach Kerzenschluss läuft (Cron `10 */5 ...`):

1. `strategy.onBar(ctx)` wird **nach Abschluss** einer M5-Kerze aufgerufen; ctx enthält nur abgeschlossene Kerzen.
2. ENTER/EXIT wird zum **Open der nächsten Kerze** ausgeführt: Kauf am Ask, Verkauf am Bid, plus Slippage.
3. SL/TP intrabar gegen High/Low der passenden Seite (Long: Bid, Short: Ask). Einstiegskerze zählt mit.
4. Gap über den SL (nicht Einstiegskerze) -> Fill zum Open (schlechter als SL), Grund `SL_GAP`.
5. SL und TP in einer Kerze -> `conflictMode` (Default pessimistisch = SL), Trade `conflict: true`.
6. Positionsgröße: `riskPercent` vom (aktuellen) Konto / Abstand(refPrice, SL), 3 Nachkommastellen, max 50 – wie live.
7. Offene EXIT-Order über Tagesgrenze -> Schluss zum letzten Kurs des Vortags (`<grund>_EOD`).

Signalpreise der DE40-Bots: **Bid + HALF_SPREAD (0,9)**, Rundung SL auf 0,1 mit `+1e-6` (Gleitkomma wie live).

## Arbeitsweise / Regeln

- **Erst validieren, dann optimieren.** Neue oder geänderte Strategie -> `run` mit `live`-Datei, Übereinstimmung
  ≥ 90 % (Richtung, Einstiegskerze, Ausstiegsgrund, Ausstiegskerze). Abweichungen erklären, bevor irgendetwas getunt wird.
- Strategie-Logik **1:1 aus dem n8n-Code-Node** übernehmen (Workflow per n8n-MCP lesen: `get_workflow_details`).
  Keine „Verbesserungen“ beim Portieren. Varianten nur über Parameter, Default = live-identisch.
- Kein Lookahead: Strategie darf nur `ctx` benutzen. Tagesmerkmale nur aus Vortagen (`context.js`).
- Empfehlungen gelten erst als „empfohlen“, wenn sie als echter Backtest in **beiden Zeithälften** besser sind
  und in allen Zeitdritteln dieselbe Richtung zeigen. Nichts automatisch live übernehmen – erst Forward-Test
  (Schatten-Zwilling wie `Schatten_TP2R_*` in `ft_trades`).
- Neue Features einer Strategie als `features` am ENTER zurückgeben -> fließen automatisch in die Muster-Analyse.
  Labels in `patterns.js` → `FIELD_LABELS` ergänzen.
- Neue Funktionen mit Test in `test/` absichern. Der Echtdaten-Test (`ECHTE DATEN: ...`) darf nie brechen.
- Keine schweren Abhängigkeiten (aktuell nur `adm-zip`). Node ≥ 20, ESM.

## Neue Strategie hinzufügen (Checkliste)

1. Code-Node des Bots lesen (n8n-MCP oder Export), Regeln als Kommentar oben ins Modul schreiben.
2. `src/strategies/_template.js` kopieren, `onDay`/`onBar` portieren, Signalpreis-Konvention übernehmen.
3. In `src/strategies/index.js` registrieren, Config in `config/` anlegen (Daten, Symbol, Session, Live-Datei).
4. Live-Trades exportieren (`d_tradelog`/`trades`/`ft_trades` als JSON nach `data/live/`) und `run` -> Live-Abgleich.
5. Einen echten Tag als Fixture + Test anlegen (siehe `test/fixtures/` und letzter Test in `engine.test.js`).

## Datenquellen

- **Capital.com-Kerzen-Download v8.3** (n8n, ZIP monatlich) -> ZIP/Ordner direkt nach `data/raw/<symbol>/` legen.
- n8n Data Table `volume_compare` (DE40/US100… M5 seit 28.10.2026, Mid + Spread, `source=capital`) als CSV/JSON-Export.
- Live-Trades: Data Tables `ft_trades` (Forward-Test DE40), `d_tradelog`, `trades` (Live-Bots mit Features).
- Capital-API liefert max. 1000 Kerzen je Abruf; für lange Historie den Download-Workflow nutzen.

## Live-Code: bekannte Vereinfachungen

- Cron-Zeitzone als Europe/Berlin angenommen (n8n-Instanz). Code-Nodes filtern ihre Handelszeit selbst.
- Laufende Kerze zu T = erster Kurs der neuen M5-Kerze, Volumen 1. Live kommt sie nur manchmal mit (Phase 0) -> `--no-tick` als Gegenprobe.
- Kerzen wie geliefert (`asDelivered`): Sonntagabend-Öffnung bleibt in der Historie. `--de40-live` bildet nur den Einzelfall 85038 nach (kein systematischer Feedfehler, siehe Phase 0).
- Limit-Füllung bei Berührung (kein Queue-/Teilfüllungsmodell). In der Füllkerze: SL ja, TP nur bei Schluss jenseits TP.
- Kein Trailing/Breakeven/Partial (im Workflow nicht aktiv, nur `trailingConfig` im Output). Broker-Kosten siehe „Kosten + Coinflip“ (Capital-Swap unbekannt).
- FTMO: Kurse von Capital (Mitte) statt cTrader; News-Sperre (ForexFactory) nicht simuliert; Gewinnziel/Equity-Untergrenze
  nicht als Handelsstopp (sonst endet der 2-Jahres-Test nach dem ersten Ziel), Tagesstopp 4 % und Fr 20:30 schon.
- Live-Abgleich nur möglich, wenn Kerzendaten den Zeitraum der Live-Logs abdecken (aktuelle Uploads enden 13.10.2026).

## Bekannte Grenzen / nächste Schritte

- NoiseB braucht 14 gültige Vortage für das σ-Profil -> Echtdaten-Validierung erst mit ≥ 3 Wochen Historie.
- M5-Daten können SL/TP-Reihenfolge in einer Kerze nicht klären -> bei vielen Konflikten M1 nachladen.
- Keine Finanzierungskosten (alle Strategien intraday). Für Swing-Bots `commissionPerTrade`/Overnight ergänzen.
- Nächste Module: NAS100 Fibonacci, EURUSD/GBPUSD SMC, DAX ORB (Live-Bot) – jeweils mit Live-Abgleich.
- Portfolio-Sicht (mehrere Strategien, gemeinsames Konto, FTMO-Tageslimit über alle Bots) noch offen.

## Stand der Ergebnisse (Lauf 03./04.11.2026, Daten bis 13.10.2026)

Gesamtvergleich: `out/live/vergleich.html` (+ CSV-Exporte), Einzelreports `out/live/<id>/report.html`.
- NAS F618ATR (Capital und FTMO-Basis) sind die einzigen belastbar positiven Live-Varianten (Ø ≈ +0,24 bis +0,27R).
- Backtest-Auftrag F618ATR (V1–V6): keine Variante schlägt die FTMO-Basis in beiden Zeithälften; V2, V4, V6 klar schlechter.
- Muster-Analyse: SL_MAX 80 statt 200 (FTMO) → Ø +0,38R, Plateau 60–120. In-Sample gefunden → erst Forward-Test.
- DE40 LVN (6 Varianten) und EURUSD C1–C6 durchgehend negativ.
- EURUSD Sweep→BOS→FVG→Fib 0,618–0,75 (`eu-sbf*`, 04.11.2026, Basis-Template C4): TP 1,5R Ø −0,04R (117 Trades), ohne Trendfilter Ø −0,10R,
  TP am Impuls-Extrem Ø −0,09R; **TP 0,75R Ø +0,08R, beide Hälften +0,07/+0,09R, p = 0,31** – bester EURUSD-Ansatz, aber nicht belegt.
- EURUSD-Muster über C1–C6 + eu-sbf (04.11.2026, echte Re-Runs mit Filter): **kein Handel Mi + Fr** verbessert alle 7 Varianten in beiden
  Hälften und allen Dritteln um +0,07 bis +0,11R (C3 → +0,02R, C4 −0,01R). Zusätzlich ADX 30–35 raus: C4/C5/C6 ≈ +0,03 bis +0,04R, eu-sbf +0,24R
  (54 Trades). ADX 30–35 allein nicht robust. Nichts davon signifikant; Varianten teilen viele Signale -> nicht unabhängig.
  Als Code-Patch im Katalog (Gruppe `Muster-Filter`, `euDayAdxPatch`): C4 Ø +0,08R (333 Tr., H 0/+0,15), C6 +0,05R, C5 ±0, C3 ±0,
  eu-sbf +0,16R (66 Tr.), eu-sbf-tp075 +0,08R. Alle besser als ihre Basis in beiden Hälften, keine signifikant (p ≥ 0,22).
- Muster DE40 LVN + NAS100 (04.11.2026, Übersicht `out/live/muster-swing.html`, Engine-Filter-Re-Runs auf allen 6+6 Varianten):
  DE40: ADX ≥ 30 (Plateau 30–35), ohne Montag, LVN-Tiefe nicht 0,20–0,35 verbessern alle 6 in beiden Hälften; kombiniert +0,29 … +0,42R.
  NAS: ohne Signale 15 Uhr (US-Open) → 5/6 besser (meist +0,02–0,04R). **Achtung: `ctx_gapRel` ist für US100 (Sitzung ab 15:30) bei
  Signalen vor 15:30 Lookahead** – Gap-Filter für NAS ungültig. DE40 nicht betroffen (Gap um 09:00 bekannt).
  Als Code-Patch im Katalog (Gruppen `DE40 LVN Muster-Filter`, `NAS Muster + Swing`): LVN *-mf (ADX_MIN 30, ohne Mo, LVN-Tiefe ≠ 0,20–0,35)
  alle 6 positiv +0,15 … +0,33R (Basis +0,33R, p 0,07); ADX 30 allein als Code-Patch nur +0,08 / ±0R. F618ATR L2/R1 + Extrem ohne 15 Uhr
  +0,31R (p 0,003, DD 10,7R); Fib50 LB2 ohne 15 Uhr + Mo +0,18R (p 0,017).
- NAS-Swing-Erkennung (`nasSwingPatch`, Gruppe `NAS Swing-Methoden`): Original-Fraktal fast optimal; Zigzag/größere Fraktale schlechter.
  Leicht besser: BOS per Schlusskurs + echtes Extrem (F618ATR +0,28R). Bester Einzelwert Fraktal L2/R1 + echtes Extrem +0,29R (schmale Spitze).
  Abstand sh2 → sh1 (`minBos`/`minBosAtr`/`minBars`, `maxBos`/`maxBosAtr`, je mit BOS per Schlusskurs, Lookback 1/1–3/3) bringt keine
  verlässliche Verbesserung: F618ATR wird mit jedem Mindestabstand schlechter (≥20 Pkt +0,17R, ≥40 +0,04R), Höchstabstände streuen ohne Muster.
  Zusätzlicher Kontext über N Kerzen (`hiWin`/`winN`/`anchorN`, N = 30/50/100, Original-Lookbacks bleiben): sh1 als N-Kerzen-Extrem macht
  F618ATR schlechter (+0,24 → +0,20/+0,16/+0,11R), Fenster wirkungslos (Swings liegen ohnehin in den letzten 50 Kerzen),
  N-Kerzen-Anker zerstört F618ATR (SL zu groß, −0,08 … −0,56R). Kein Plateau bei Fib61/Fib50 -> nicht übernehmen.
- Chop vermeiden (05.11.2026, Übersicht `out/live/nas-chop.html`, `nasQualityPatch`/`nasEntryPatch`): Stärkster Hebel ist die MA-Regel
  „Fib-Level jenseits SMA50 und SMA200“ (`USE_MA_DISTANCE_FILTER = true`, `MA_DIST_MIN = 0`): 6/6 NAS-Varianten besser in beiden Hälften,
  Plateau mit Optimum bei 0. Kombi MA0 + Effizienz ≥ 0,4 (F618ATR +0,31R, t 3,2) bzw. MA0 + ohne 15 Uhr (Fib61 LB1 +0,18R).
  CHOP, ADX, EMA-Steigung, SMA-Abstand, Impuls-Tempo einzeln ohne stabiles Muster. Live (d_tradelog 23.10.–05.11.): 70 NAS-Trades −11,1R.
  Im Katalog (Gruppe `NAS Chop-Filter`): nas-<bot>-ma0 für alle 6 + beste Kombi je Bot; alle besser als ihre Basis,
  F618ATR MA0 + Effizienz 0,4 +0,31R (p 0,002, beide Hälften +0,07R), Fib61 LB1 MA0 + ohne 15 Uhr +0,18R (p 0,017).

- Konfluenz-Analyse (06.11.2026, `tools/konfluenz.py` + `tools/konfluenz_report.py` -> `out/konfluenz/report.html`, Archiv `archiv.html`):
  K1 MA-Band, K2 Retest gebrochener Swing, K3 Impuls (M15, ohne Lookahead) + Z1 H1/H4, Z2 Volumen, Z3 Abstand; 419 Filter auf 19 Strategien,
  Zufallskontrolle 1000×, IS/OOS 70/30. Nur DE40 LVN Basis „K3 Impuls ≥ 2 ATR“ erfüllt alle Kriterien (OOS +0,09R, Plateau 1,0→2,0 ATR,
  Expectancy danach nur +0,03R; bei 419 Tests auch Zufall möglich). Konfluenz-Score ohne monotone Wirkung. H4-EMA50-Richtung bei allen
  6 DE40 IS +0,10…+0,21R, OOS −0,04…+0,03R -> nur in-sample. Alle NAS-/EURUSD-Varianten: kein Filter übernommen.

## Analyse-Framework (Trade-Log + Module, seit 06.11.2026)

Analysen lesen nur das Trade-Log und ändern die Engine nicht. Reihenfolge: Engine-Läufe (`bin/live.js`) -> `npm run analyse`.

```
tools/tradelog.py      Trade-Log out/tradelog/tradelog.sqlite (Tabellen trades, variants, runs): Basis, Ergebnis brutto/netto + Kosten,
                       Exkursion (mfe_r_before_sl bis SL max. 3 Tage), Regime (ATR-Perzentil 250 Tage, vol_regime, ADX M15, H4-Bias),
                       Konfluenz (K1–K3, wick_gap), stopped_then_target_hit (gleicher Tag). Liquiditäts-Spalten swept_before_tp /
                       sweep_entry_r_alt noch leer (Modul C8). is_news_day leer (kein Kalender). Kostenmodell: config/kosten.json.
tools/ftmo_lib.py      Modul B: FTMO 2-Step (Tagesverlust ab Saldo 00:00 Berlin inkl. offener Position über MAE, statischer
                       Gesamtverlust, ≥ 4 Handelstage, rollierend + Block-Bootstrap nach Woche). Tests: test/test_ftmo_lib.py
tools/modul_a.py       Modul A: IS/OOS 70/30, 10 Blöcke, PF ohne beste Trades, Bootstrap-KI, Kostenanteil, Zufallskontrolle vs.
                       Basis, Entscheidungsregel; FTMO je Variante -> out/analyse/robustheit.json; Report tools/modul_a_report.py
                       -> out/analyse/robustheit.html (Reiter Top-10 / Kandidaten / FTMO / Archiv)
tools/phase0.py        Phase 0: Live-Abgleich d_tradelog-Export (data/live/d_tradelog.json|csv) vs. Backtest -> out/analyse/phase0.html
```

Python-Tests: `npm run test:py` (FTMO-Regeln, Phase-0-Abgleich). Python 3.9: keine gleichen Anführungszeichen in verschachtelten f-Strings.
Stand 06.11.2026 (Phase 0, `data/live/d_tradelog.json` = geschlossene Trades aus n8n, `d_tradelog_orders.csv` = Orders ohne Ergebnis /
verfallen / gelöscht, Kerzen bis 03.11.). Ursachen per n8n-Ausführungsdaten nachgewiesen (`tools/trace-live.js`, Original-Code mit Live-Eingängen):
1. **DE40-M5-Abruf: KEIN systematischer Fehler (korrigiert 09.11.2026).** Der Ask-Versatz (Ask aus der Folgekerze, 52/200 Ask < Bid)
   trat nur in EINER Ausführung auf (85038, 28.10. 09:20 UTC, Laufzeit 26 s statt ~8 s – vermutlich gestörte API-Antwort). 7 weitere
   Läufe (84989 = 09:20 Berlin, 85006, 85034, 85042, 85072, 85119, 90908) sind sauber und stimmen zu 199/199 Kerzen mit den
   Backtest-Daten (data/raw) überein. Die frühere Aussage „jeder Ask aus der Folgekerze, muss in n8n behoben werden“ war eine
   Verallgemeinerung aus einem Lauf. `--de40-live` (engine.de40AskShift) bildet nur diesen Einzelfall nach -> nicht verwenden.
   Offen: warum der DE40-Live-Abgleich ohne Versatz nur 25/39 (64 %) erreicht – Ursache noch nicht geklärt.
2. **Laufende Kerze unbestimmt:** Workflow startet um Sekunde 0; Capital liefert die laufende M5-Kerze nur, wenn schon ein Tick da ist
   (mal ja, mal nein). EURUSD C1–C3 entscheiden an dieser Kerze (0,1 Pip kippt „Momentum“/„Pullback“). `--no-tick` (engine.noTick) bildet
   den anderen Fall ab. Ergebnis schwankt stark: F618ATR +0,155R (mit Tick) / +0,206R (ohne), Fib50 LB3 −0,03 / +0,04R, EU C3 −0,08 / −0,13R.
3. **Sonntagabend-Kerzen** (Wochenöffnung) fehlten im Backtest (cleanBars dropWeekends) -> EMA/ATR montags anders. Behoben:
   Live-Engine nutzt `cleanBars({ asDelivered: true })` (Kerzen wie geliefert, Wochenend-/Rumpftage nur nicht im Tagesindex).
Abgleich jetzt: NAS 57–58/63 (90–92 %), EURUSD 61–63/83 (73–76 %), DE40 25/39 (64 %, Ursache offen; die 85 % mit `--de40-live` beruhten auf dem Einzelfall-Versatz). Log-Lücke: viele Orders 21.–23.10. ohne Ergebnis.
Mindeststichprobe 300 OOS-Trades erreichen nur 3 EURUSD-Varianten -> offizielle Top-10 leer. US100-M5 ab 01.01.2024 (Capital liefert nicht früher).

## Session-Zeiten (seit 07.11.2026)

`config/sessions.yaml` ist die **einzige Quelle für Handelszeiten** (Referenz-Eröffnung je Epic, IANA-Zeitzone, Feiertagskalender,
ORB/VWAP-Zulassung). Leser: `src/core/sessions.js` (`sessionUtc`, `sessionHmIn`, `berlinSession`, `cleanSession`, `isTradingDay`) und
`tools/sessions.py` (`session_utc`, `is_trading_day`, `stock_home`; nur zoneinfo). Nie feste Offsets oder Berlin-Uhrzeiten für US-Zeiten
hartkodieren – NY-Eröffnung ist in den DST-Sonderwochen 14:30 Berlin. Ausnahme: `strategies-live/*.js` (Originalcode, nicht editieren).
- `python3 tools/sessions_validate.py` -> `out/sessions/validierung.html|json`, `ausgeschlossen.md`, `config/sessions_no_trading_days.json`
  (Tage mit Volumen < 30 %). Ergebnis 07.11.2026: US100 OK (09:30 NY), DE40 OK (09:00). EURUSD auf gemessene Zeiten umgestellt:
  london 07:00 London (= Frankfurt) -> OK; newyork 08:30 NY (Range-Sprung, US-Daten), Volumen springt erst 09:30 -> Abweichung,
  für ORB/VWAP nur Session london zugelassen (`orb_vwap_sessions`). GBPUSD/USDJPY stehen noch auf den Startwerten 08:00/08:00
  (ungeprüft). Alle anderen Epics ohne Kursdaten -> ungeprüft.
- `tools/capital_hours.py` (Schritt 2, CFD-Handelszeiten über GET /markets/{epic}, Cache 30 Tage) – braucht CAPITAL_API_KEY /
  CAPITAL_IDENTIFIER / CAPITAL_PASSWORD als Umgebungsvariablen; noch nicht gelaufen, Abdeckung bis dahin aus den Kursdaten.
- Fair-Price-Kandidat: DE40-Session „us“ jetzt NY 09:30 in NY-Zeit (vorher fest 15:30 Berlin -> DST-Fehler; Kandidat neu rechnen).

## Hold-out-Test auf vollen M5-Daten (08.11.2026)

`node bin/live.js run --variants <19 Live-Bots + 26 Varianten> --out out/live-voll`, Auswertung `python3 -I tools/vollauswertung.py`
-> `out/live-voll/hold-out.md|json` (Test `test/test_vollauswertung.py`). Hold-out = nicht zur Variantensuche benutzt: US100/FTMO
02.01.–30.08.2024 + ab 14.10.2026 (8,7 Monate), DE40/EURUSD nur ab 14.10.2026 (≈ 3 Wochen, 3–37 Trades -> nicht auswertbar).
- Lange Tagesdaten (data/daily) sind für die Intraday-Bots nicht nutzbar; „neue Daten“ = US100 Jan–Aug 2024 + Okt/Nov 2026.
- **Legacy NAS im Hold-out schwach:** F618ATR −0,19R (61 Tr., Selektion +0,21R), FTMO-Basis ±0,00R (59), Fib50/61 −0,12 … +0,10R.
  Gesamt 01/2024–11/2026: F618ATR +0,155R (t 1,8), FTMO-Basis +0,20R (t 2,2), übrige NAS ≈ 0, DE40 LVN −0,06 … −0,11R, EURUSD C1–C6 −0,08 … −0,15R.
- **NAS-Varianten gegen Basis im Hold-out:** 9 von 14 besser (Δ +0,01 … +0,18R), aber nur Fib50 LB2 ohne 15 Uhr + Mo (+0,11R, 80 Tr.,
  Δ +0,15), Fib61 LB2 MA0 (+0,12R, 158), Fib61 LB3 MA0 (+0,06R), Fib50 LB3 MA0 (+0,03R), FTMO SL_MAX 80 (+0,04R) absolut positiv.
  Alle F618ATR-Varianten im Hold-out negativ (−0,13 … −0,28R); MA0 + Effizienz 0,4 schlechter als Basis. Nichts signifikant.
- Folgerung: Die Selektionsphase überschätzt (F618ATR, MA0+ER04). Die Filter-Richtung (ohne 15 Uhr, MA-Regel) hält meist, der Vorteil ist klein.

## Engine-Gegenprobe (07.11.2026)

`node tools/engine-check.js [--seeds 20]` -> `out/engine-check/bericht.md|ergebnis.json` (Test `test/engine-check.test.js`, synthetischer Zufallspfad).
Portierte Engine, DE40/US100/EURUSD M5, Zufallseinstiege (SL 3 × ATR14, TP 1R/2R, Zeit-Exit), Orakel mit Trefferquote q, Drift-Tests.
- **Engine unverzerrt:** Zufall ohne Spread (R_bid) DE40 −0,004R, US100 +0,003R, EURUSD −0,013R (t −2,1, Rest = Spread beim Short-Ausstieg);
  Konflikt-Modus egal (≤ 0,4 % Konflikte). Mit Spread ≈ −Kosten: DE40 −0,03R, US100 −0,02R, EURUSD −0,07R (bei SL = 3 × ATR M5).
- **Eingepflanzte Kante wird gezeigt:** q 0,55 -> R_bid +0,07 … +0,09R, q 0,6 -> +0,14 … +0,17R (Theorie ±0,01R).
- **Unabhängige Nachrechnung:** 9240/9240 Trades identisch (Ausstiegskerze, R). Drift-Punkte Engine = direkte Rechnung (Abweichung 0).
- Behoben: Trade-Protokoll der portierten Engine rundete Preise/Punkte auf 2 Stellen (FX unbrauchbar) -> 5 Stellen wie runner.js.
- **Befund Drift:** Long nur über Nacht (Schluss -> Eröffnung) US100 +10 492 Pkt / 707 Nächte (Ø +14,8, 58 % positiv), Intraday −1 195 Pkt;
  DE40 über Nacht +6 289, Intraday +500. Fast der ganze Indexanstieg 2024–26 kam über Nacht. Finanzierungskosten (CFD-Overnight) nicht
  abgezogen, Zeitraum = Bullenmarkt -> als Kandidat geprüft (siehe Kandidaten: Overnight-Drift).

## Kandidaten (nicht im Ranking)

- **Overnight-Drift US100 + DE40**, 07.11.2026 – `bin/overnight.js` -> `out/kandidaten/overnight/bericht.md|ergebnis.json`, Test `test/overnight.test.js`.
  Long zum Session-Schluss, Verkauf zur nächsten Eröffnung (portierte Engine, Spread drin). Vorab festgelegt, kein Raster: ON (jede Nacht),
  ON-WT (ohne Wochenende/Feiertagslücke, FTMO-tauglich), ON-SMA (Schluss > SMA200), Kontrollen Intraday-Long und Short über Nacht.
  Finanzierung als Szenario 0–9 % p. a. je Kalendernacht (echte Sätze Capital/FTMO noch nicht abgefragt). Daten nur 01/2024–11/2026 (Bullenmarkt).
  Ergebnis: Effekt da (Intraday ≈ 0, Short über Nacht −0,06 … −0,09 % je Nacht), aber schwach: vor Finanzierung t 1,6–2,1, bei 7 % p. a. t ≤ 1,3;
  US100 2026 ≈ 0. Break-even-Finanzierung ON US100 17 %, DE40 11 % p. a. Gegen Buy-and-Hold (gleiche Nächte = gleiche Finanzierung) bei 7 %:
  US100 ON Sharpe 0,74 vs. 0,67, DD −22 vs. −27 %; DE40 ON-WT Sharpe 0,77 vs. 0,61, DD −7 vs. −18 % (ON und ON-SMA bei DE40 schlechter).
  Einordnung: kein Alpha, sondern Index-Beta mit weniger Marktzeit.
  **Lange Historie** (`tools/yahoo_daily.py` -> `data/daily/{NDX,DAX,SPX}.csv`, Kassa-Indizes, brauchbare Eröffnung NDX ab 2001, DAX ab 1994,
  SPX ab 2014; `tools/overnight_long.py` -> `out/kandidaten/overnight/langfrist.md|json`, Test `test/test_overnight_long.py`). Abgleich mit
  CFD 2024–26: DAX r 0,95, gleiche Ø; NDX r 1,00, Kassa-Eröffnung unterschätzt Overnight um ≈ 0,014 %/Nacht. Ergebnis:
  vor Finanzierung Overnight positiv (NDX t 2,3, DAX t 4,8, SPX t 2,5), Intraday ≈ 0. Nach CFD-Finanzierung (Leitzins-Näherung + 2,5 %):
  NDX t 0,7, SPX t 0,4 -> weg; DAX +0,016 %/Nacht t 2,3, ON-WT +0,023 % t 3,1 (Drittel alle +), mit 3× Spread ≈ 0. Ohne Broker-Aufschlag
  (≈ Future): DAX ON t 3,7, ON-WT t 4,0, NDX ON-SMA t 3,4. In Bärenmärkten verliert ON mit (kein Schutz, 2008 −26 %, 2022 −14/−26 %).
  Gegen Buy-and-Hold: besser risikobereinigt nur beim DAX (Sharpe 0,40/0,54 vs. 0,25), NDX/SPX schlechter.
  -> Als CFD-Strategie (Capital/FTMO mit Swap) nicht empfohlen; einzig DAX ON-WT bleibt Kandidat, abhängig vom echten Swap-Satz.
  **Entscheidung 08.11.2026: Overnight-Drift verworfen** (auch DAX ON-WT; hängt zu stark an Swap und Spread).

- **K2 ORB-Retest / K5 VWAP-EMA-Cross (+ K1 einfacher ORB als Basis)**, 07.11.2026 – `src/candidates/k2k5.js`, `bin/k2k5.js`
  (alle Epics mit Kursdaten, Sessions aus sessions.yaml, EURUSD zusätzlich 08:00/08:00 laut Auftrag; Stammdaten -> `config/epics.json`),
  `tools/k2k5_report.py` -> `out/kandidaten/k2k5/report.html` (+ archiv.html, ergebnis.json). Tests `test/k2k5.test.js`.
  6 Epic-Sessions (DE40, US100, EURUSD ×4), 6348 Kombinationen (K2 96 Basisvarianten × 8 Filtersätze, K5 288 + Gitter 25 je Basis).
  **Ergebnis: 0 bestehen die FDR-Korrektur (kleinstes p 0,005), 0 bestehen alle Kriterien -> verwerfen.** Ø OOS netto K1 −0,05R,
  K2 −0,12R, K5 −0,06R; nur 28 % (K2) bzw. 32 % (K5) der Varianten OOS positiv. K2 erreicht ≤ 178 OOS-Trades (Mindestmaß 150 nur
  ohne Filter). IS-beste Varianten fallen OOS meist auf ≤ 0. Portfolio der IS-Besten: FTMO 100 % über den ganzen Zeitraum, nur OOS ~20 %
  (IS-Verzerrung). Brutto Ø nur ≈ 0 … +0,06R, Kosten machen fast alles negativ; einzige OOS-positive Zelle US100 K2 (Ø +0,09R,
  57 % der Varianten). **Entscheidung 07.11.2026: K1/K2/K5 verworfen**, keine weiteren Epics geladen (würde nur Mehrfachtests erhöhen).
  `tools/capital_download.py` bleibt für spätere Kandidaten.

- **Fair Price (JJ Simon), NAS100 + DE40** – `src/candidates/fairprice.js`, `bin/fairprice.js` (Raster), `tools/fairprice_report.py`
  (IS/OOS 70/30, FTMO 2-Step rollierend + Bootstrap, Vergleich F618ATR FTMO) -> `out/kandidaten/fairprice/report.html`. Stand 06.11.2026:
  **M5-Näherung** (keine M1-Daten; Eröffnungskerze = erste M5-Kerze, die fast immer > 25 Pkt ist -> Setup A praktisch immer SL 50/TP 76),
  **ohne News-Varianten** (kein Kalender), Kosten = Capital-Spread + 0,5 Pkt Slippage, keine Kommission (Annahme).
  FP-Rückkehr nach der 1. Kerze nur 70 % (NAS 09:30) statt behaupteter ~95 %. Keine Variante schlägt die Basis; formal (≥ 100 OOS-Trades)
  keine in IS + OOS positiv. Breit positiv nur: NAS 09:30 Setup A (ohne Bias 12/13 Zellen IS+OOS, Ø OOS +0,09R, ~10 Trades/Monat) und
  NAS 14:00 Setup B1 (11/13, Ø OOS +0,17R, nur ~4 Trades/Monat). Setup B vormittags und DE40 verlieren. Empfehlung: nur diese zwei Zellen
  mit M1 (≥ 3 Jahre) + News-Kalender erneut prüfen, sonst verwerfen.

## Dukascopy-Daten, News-Kalender, Tresor (09.11.2026)

- **Dukascopy M1 → M5** (`tools/dukascopy_download.py fetch|build`, Cache `data/dukascopy/cache`, M5 `data/dukascopy/<epic>/`): DE40 ab 10/2013,
  US100 ab 2012, EURUSD ab 2004, Bid + Ask, vollständig (kein Tag fehlt). Älter gibt es bei Dukascopy nicht (404). 2015–2017 Indizes nur
  07–21 UTC (Nacht fehlt in der Quelle, auch als Ticks), US100 2012/2013 dünn. Abgleich mit Capital 2024–26 (`tools/dukascopy_compare.py`
  -> `out/dukascopy/abgleich.md`): Rendite-Korrelation 0,99/0,99/1,00, Richtung 97–99 %, Spanne ±3 % -> brauchbar. Spread in der
  Handelszeit bei Dukascopy kleiner (US100 1,3–1,5 vs. 1,8; EURUSD 0,3 vs. 0,6 Pip). Engine liest Dukascopy noch nicht (Etappe 2).
- **News-Kalender ForexFactory 2007–2026** (`tools/news_calendar.py build|check` -> `data/news/ff_calendar.csv`, 92 840 Termine, UTC).
  Rohdaten `data/news/ff_raw/<mon>.<jahr>.json` aus der FF-Monatsansicht im Browser (Feld `dateline` = Unix-Zeit; Skript-Abrufe blockt
  Cloudflare – nicht umgehen). Helfer `news_times`/`blocked` (±2 min wie FTMO) / `news_days` je Epic (DE40 EUR, US100 USD, EURUSD beide).
  `exact_time = 0` für ganztägige/vorläufige Termine. Impact = heutiger FF-Stand. Hugging-Face-Abzug unbrauchbar (Zeiten oft 00:00).
  Test `test/test_news_calendar.py`. Noch nicht in die Engine eingebaut.
- **Swap**: FTMO-Sätze am 09.11.2026 von ftmo.com/en/symbols abgelesen (Punkte je Lot/Nacht): US100.cash −655,88 / +20,69,
  GER40.cash −513,99 / −51,87, EURUSD −9,5 / +0,36 (Kommission 5 USD/Lot FX, 0 Indizes). Punktgröße (vermutlich 0,01) ungeprüft.
  Capital: Formel Benchmark (SOFR/€STR) ± Tagesgebühr; echte Sätze nur über API (Zugangsdaten nötig). Historische Sätze gibt es nicht.
  `config/epics.json` steht noch auf `swap_pts_per_night: 0` -> nicht umgesetzt.
- **Tresor** (`config/tresor.json`, `src/core/tresor.js`, `tools/tresor.py`, Tests `test/tresor.test.js`, `test/test_tresor.py`):
  versiegelte Jahre DE40/US100 2014, 2017, 2020, 2023; EURUSD 2005, 2008, 2011, 2014, 2017, 2020, 2023. `bin/live.js` blendet sie
  beim Laden aus; Öffnen nur mit `--tresor "<Begründung>"` -> `config/tresor_protokoll.jsonl`. Ein Kandidat, der im Tresor durchfällt,
  wird verworfen (kein Nachjustieren). Neue Python-Auswertungen auf langen Daten müssen `tresor.drop_sealed` benutzen.
- **Indikatoren M5** (10.11.2026, `node tools/indicators.js [EPIC…]` ≈ 50 s, Test `test/indicators.test.js` gegen naive Nachrechnung +
  Lookahead-Probe) -> `data/indicators/<epic>/ind_<EPIC>_M5_<Jahr>.csv`, Tresor-Jahre in `…/tresor/` (nicht für die Suche öffnen).
  Mittelkurs (Bid+Ask)/2 der Dukascopy-M5, Werte gelten nach Schluss der Kerze. Spalten: OHLC, Spread, Volumen, EMA 9/20/50/100/200,
  SMA 20/50/100/200, RSI 14/2 (Wilder), Bollinger 20/2 (Mitte/oben/unten/%b/Breite, Population-σ), ATR14, MACD 12/26/9, ADX/+DI/−DI 14,
  Stochastik 14/3/3, CCI20, Donchian 20, Choppiness 14, Efficiency Ratio 10, Session-VWAP + σ, Tages-VWAP, relatives Volumen zur gleichen
  Uhrzeit (20 Tage), H1-EMA50/ATR14, H4-EMA50/RSI14 (nur abgeschlossene Perioden), Vortag H/L/C, Tages-ATR14, Pivot/R1/S1,
  Eröffnungsspanne 30 min (erst nach Ablauf), in_session. Handelstag DE40 Berlin, US100 18–18 Uhr NY, EURUSD 17–17 Uhr NY.
  Abgleich mit Capital 2025 (gleicher Algorithmus): RSI14 Med |Δ| 0,1–0,4 (90 % ≤ 2,3), ADX Med 0,4–0,8 (90 % ≤ 4,6), %b Med ≤ 0,01 ->
  Schwellen (RSI 30/70, ADX 25) kippen gelegentlich. Volumen = Dukascopy-Tickvolumen (nicht Capital) -> VWAP/rvol leicht anders.
- **Indikatoren M15 + H4** (10.11.2026, `node tools/indicators.js --tf M15,H4`, ≈ 30 s) -> `data/indicators/<epic>/m15|h4/ind_<EPIC>_<TF>_<Jahr>.csv`
  (+ `tresor/`). Aus M5 gebaut (UTC-Raster wie candles.js), gleiche Spalten; Zeitstempel = Periodenbeginn, gültig ab Periodenschluss.
  H4: h1_*/h4_*/or30_* leer, Session-VWAP grob. Prüfung: h4_ema50 in M5 = ema50 der letzten abgeschlossenen H4-Kerze (100 %);
  M15 Dukascopy vs. Capital 2025: RSI14 Med |Δ| 0,08–0,35 (90 % ≤ 1,9), ADX Med 0,3–1,0 (90 % ≤ 4,5), EMA200 Indizes Med 4–6 Pkt (≈ 0,03 %).
- **Zeitebenen**: nichts weiter zu laden (M15/H4/H1/D1 exakt aus M5). M1 liegt im Dukascopy-Cache (Bid + Ask) – daraus bei Bedarf M1-CSV bauen (SL/TP-Reihenfolge,
  Limit-Füllkerze: 2/3 aller Bot-Trades sind Limits; SL/TP-Konflikte in derselben M5-Kerze nur 0,16 % von 22 437 Trades). H1/H4/D1 aus M5.

## Kosten + Coinflip-Test (12.11.2026)

- **Kosten** (`src/core/costs.js`, `config/kosten_broker.json` mit Quellen, Test `test/costs.test.js`): `runner.js` zieht je Trade Kommission,
  Swap und Slippage ab; `R` = netto (pnl/Risikobetrag), `Rgross` = vorher, dazu `costR`, `commission`, `swap`, `slippage`, `nights`, `swapKnown`.
  Profil: Familie NAS_FTMO -> `ftmo`, sonst `capital`. Spread steckt weiter in den Kursen. Abschalten: engine `costs: false`.
  Geklärt 12.11.2026: Capital Kommission 0 %, Swap % vom Positionswert (US100 −0,02221/−0,00002, DE40 −0,01802/−0,00420, EURUSD
  −0,00802/−0,00020), Buchung 22:00 UTC = 17:00 NY, Indizes jede Kalendernacht, FX Mittwoch dreifach (capital.com-Marktseiten, Hilfe-Artikel).
  FTMO: Forex 2,50 USD/Lot je Seite = 5 Round-Turn (Trading Update 25.09.2025), Indizes 0; Swap in Punkten (Punkt 0,01 bzw. 0,00001,
  Kurse mit 2/5 Stellen), Dreifach Mi->Do (FTMO-Blog), Rollover 00:00 GMT+2/+3. Slippage bei SL-Ausstieg gemessen (d_tradelog):
  US100 Ø 1,07 Pkt, DE40 0,60, EURUSD 0; FTMO nicht gemessen -> 0. Swap-Sätze = heutige (vom Leitzins abhängig).
  Wirkung (out/live-kosten, 19 Legacy-Bots): NAS −0,02 bis −0,03R (meist Slippage), F618ATR +0,155 -> +0,131R (t 1,5),
  FTMO-Basis +0,199 -> +0,189R (t 2,1), DE40 −0,03R (Slippage), EURUSD ≈ 0.
- **Coinflip** (`node tools/coinflip.js [--run out/live-voll]` -> `out/coinflip/bericht.md|ergebnis.json`, Test `test/coinflip.test.js`):
  gleiche Einstiegskerze/-preis, SL- und TP-Abstand, Richtung per Münzwurf (1000×), einfacher Simulator für beide Seiten (ab Folgekerze,
  SL vor TP, max. 14 Tage). Kalibrierung Sim ≈ Engine (NAS/EURUSD ±0,02R, DE40 Sim ~0,05R besser). Ergebnis (Capital-Daten 2024–26):
  Richtung trägt Information bei **F618ATR Capital p 0,023, FTMO-Basis p 0,013**, SL_MAX 80 p 0,006; alle übrigen Legacy-Bots p 0,16–0,83
  (Fib50/61, DE40 LVN, EURUSD C2–C6), **EURUSD C1 p 0,997 (schlechter als Zufall)**. Gefilterte Varianten (-mf, ohne Mi+Fr, MA0 …) oft
  p < 0,05 – aber in-sample ausgewählt, p dadurch zu klein. Münzwurf-Ø bei NAS +0,00 … +0,05R (Struktur/Drift), DE40/EURUSD −0,06 … −0,15R.
- **Auswahl mittesten** (`node tools/coinflip.js --select [--run out/live]` -> `out/coinflip/auswahl.md|json`; eigener Suchraum
  `--select --name legacy --ids … --run out/live-voll` -> `auswahl-legacy.md`): in jedem Münzwurf-Lauf wird die BESTE Variante des Suchraums
  genommen (max-T nach Westfall-Young), Münze je Markt + Einstiegszeit geteilt (Varianten mit gleichen Signalen bleiben korreliert).
  Suchraum = 113 Läufe in out/live (Untergrenze; Konfluenz-Filter etc. kamen dazu). Ergebnis: US100 beste F618ATR-Varianten p 0,02–0,04
  (beste von 49), FTMO SL_MAX 60/80 p 0,05 (beste von 20), DE40 -mf beste p 0,04, EURUSD beste p 0,08. Legacy (beste der 19 Live-Bots):
  **FTMO-Basis p 0,019**, F618ATR Capital p 0,13 (FTMO-Basis ist fast derselbe Bot), alle übrigen ≥ 0,9.
- **Tagesrenditen** (`python3 -I tools/tagesrendite.py [--run out/live-kosten]` -> `<run>/tagesrendite.md|json`, Test `test/test_tagesrendite.py`):
  Σ R je Werktag (Ausstiegsdatum Berlin, Tage ohne Trade = 0) × riskPercent; Ø, σ, Sharpe p. a., t (Tage), Hälften, Jahre, schlechtester Tag,
  max. DD (additiv), Tage ≤ −4/−5 %. Läufe rechnen ohne Zinseszins. FTMO-Basis t 2,2 (Sharpe 1,3), SL_MAX 80 t 3,2, F618ATR Capital t 1,5.
- **Freigabe-Prüfung** (`python3 -I tools/freigabe.py`, Kriterien + Kandidaten in `config/freigabe.json`) -> `out/freigabe/bericht.md`:
  K1 Coinflip p < 0,05, K2 Auswahl p < 0,05 (Suchraum je Kandidat), K3 **Plateau-Pflicht** (Nachbarwerte jeder getunten Größe als Läufe,
  alle > 0 und ≥ 50 % des Kandidaten), K4 Tage (t ≥ 2, beide Hälften > 0, kein Tag ≤ −4 %), K5 Tresor, K6 Forward-Test (Einträge).
  Stand 12.11.2026: kein Kandidat freigegeben. FTMO-Basis K1–K4 ✅ (Tresor/Forward offen); SL_MAX 80 K2 ❌ (p 0,054); F618ATR Capital K2/K4 ❌.
  Permutationstest auf OHLC bewusst nicht Standard (Tresor ist strenger + billiger) – nur für Kandidaten, die danach noch zweifelhaft sind.

## Etappe 2: Engine auf Dukascopy + Trailing (12.11.2026)

- `bin/live.js run … --data dukascopy [--from --to] [--spread capital] [--engine '{…}']`: Dukascopy-M5 (echte Bid/Ask), Tresor-Jahre
  automatisch ausgeblendet, `data`/`spread` stehen in result.json. `--spread capital` = Spread-Unterschied Capital − Dukascopy je Einstiegsstunde
  (gemessen, `config/spread_profil.json`) als Kosten (Kurse bleiben echt). Datenlücke > 5 Tage (Tresor-Jahr) -> Positionen `DATENLUECKE` zu.
  FTMO-Indexswap und Capital-Slippage (Punkte) skalieren mit Einstiegskurs/Referenzkurs (Stand-Kursniveau, `config/kosten_broker.json`).
- **News-Sperre d_ftmo** (`src/core/news.js`, Test `test/news.test.js`): ±15 Min um High-Impact USD/EUR (ForexFactory) -> Strategie läuft
  nicht, Pending Orders gelöscht (wie Knoten „News-Filter“, live seit 10.11.2026). Nur FTMO-Familie, `engine.newsFilter: false` schaltet ab.
  Wirkung FTMO-Basis 2024–26: 358 statt 383 Trades, Ø +0,191 statt +0,189R. d_ftmo enthält inzwischen auch DE40 Confluence 3 (nicht im Katalog).
- **Kontrolle Dukascopy vs. Capital (gleicher Zeitraum 2024–26, `out/live-duka-kontrolle`)**: gleiche Einstiege NAS/FTMO 73–80 %, EURUSD
  81–84 %, DE40 LVN nur 45–54 % (LVN aus Volumen, Dukascopy-Tickvolumen ≠ Capital -> **DE40 LVN auf Dukascopy nicht testbar**). Bei gleichem
  Einstieg gleicher Ausstiegsgrund 94–99 %. F618ATR +0,131 (Capital) vs. +0,077R, FTMO-Basis +0,189 vs. +0,144R, EURUSD auf Dukascopy besser
  (halber Spread). -> Ergebnisse hängen spürbar an kleinen Kursunterschieden (Swing-/Fib-Level).
- **NAS-Bots mit festen Punkt-Schwellen** (RANGE_MIN 50, SL_MIN 25, SL_MAX 200, SL_BUF 5, MA_DIST_MIN 30) – für NAS 15–28 Tsd. gebaut;
  2012–2019 (NAS 2–9 Tsd.) relativ 3–10× größer -> kaum Trades (2015/16 je 5–40). Lange Historie prüft bei NAS faktisch 2018–2026.
- **Lange Historie** (`out/live-lang`, Entwicklungsjahre, netto; `tools/langauswertung.py` -> `lang.md|json`, Test `test/test_langauswertung.py`):
  EURUSD C1–C6 in 0–2 von 16 Jahren positiv, Ø −0,08 … −0,13R (t −5 … −10) -> **ohne Kante, endgültig**. NAS **vor 2024 (nie zur Suche benutzt)**:
  FTMO-Basis +0,016R (384 Tr., t 0,2), F618ATR +0,010R (t 0,1), SL_MAX 80 −0,017R, F618ATR L2/R1+Extrem ohne 15 Uhr −0,066R, Fib50 LB2/LB3 +0,04R,
  Fib61 −0,04 … −0,11R. 2024–26 dagegen +0,09 … +0,13R. Coinflip über alle Jahre (`out/coinflip-lang`): FTMO-Basis p 0,37, F618ATR p 0,20
  -> **Richtungsinformation hält auf langer Historie nicht.** Einzig Fib50 LB2 ohne 15 Uhr + Mo p 0,04 (Vorteil aber fast nur 2024–26).
- **Trailing** (`engine.trailing` in runner.js: beR, partialR/partialPct, trailR/trailStartR, tp:false; nach trailingConfig der NAS-Bots;
  Wirkung nach Kerzenschluss, neuer SL ab nächster Kerze). Test Capital 2024–26 (`out/trail/*`): jede Form schlechter als feste SL/TP –
  FTMO-Basis +0,191 -> BE +0,046, Bot-Config (BE 1R, 50 % bei 2R, Trail 1R) +0,034, Trail ab 1R +0,013R; F618ATR +0,131 -> +0,02 … +0,07R;
  Fib50 LB2 ≈ unverändert. Plateau (Trail 0,75/1/1,5R) durchgehend schlechter. -> Trailing nicht übernehmen.

## DE40 Confluence 3 FTMO (13.11.2026)

- Code-Node aus d_ftmo (`strategies-live/ftmo/DE40_Confluence_3_FTMO.js`), Familie `DE40_FTMO` in runner.js (DAX Combined Check1:
  Invalidierung SL±8, 30-Min-Sperre, Dublette, Tageslimit 2 gefüllte je Berliner Tag, bei Tagesstopp läuft die Strategie nicht), Variante
  `ftmo-de40-c3`, Test `test/de40-ftmo.test.js`. Bridge-Format liefert `tick_volume` (wie live). Code nutzt Volumen (LVN/HVN/POC/VWAP) ->
  Backtest nur angenähert (cTrader-Tickvolumen live). Ergebnis: Capital 2024–26 204 Tr. Ø −0,168R, Dukascopy ohne Tresor 542 Tr. Ø −0,174R
  (t −2,48). Konto mit NAS kombiniert: P(beide Phasen) Capital 0,88 -> 0,53. Bekannte Abweichung NAS_FTMO: Strategie wird bei Tagesstopp
  im Lab noch aufgerufen (live nicht).
