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
- Laufende Kerze zu T = erster Kurs der neuen M5-Kerze (Capital liefert sie ~Sekunden alt), Volumen 1.
- Limit-Füllung bei Berührung (kein Queue-/Teilfüllungsmodell). In der Füllkerze: SL ja, TP nur bei Schluss jenseits TP.
- Kein Trailing/Breakeven/Partial (im Workflow nicht aktiv, nur `trailingConfig` im Output). Kein Swap/Financing.
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
