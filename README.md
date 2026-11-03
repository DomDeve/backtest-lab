# backtest-lab

Backtests für die n8n-Trading-Bots, **mit derselben Logik wie live**, mit Datenbereinigung, Abgleich gegen
echte Live-Trades und einer Analyse, die Stärken und Schwächen zeigt und Verbesserungen nur empfiehlt, wenn sie
Overfitting-Prüfungen bestehen.

## Schnellstart

```bash
npm install
npm test                 # 9 Tests, inkl. Abgleich mit echtem Live-Trade vom 02.11.2026
npm run demo             # Demo auf synthetischen Daten -> out/de40-orb60/report.html
```

## Mit echten Daten

1. Kerzen-Dateien (ZIP/JSON/CSV aus dem n8n-Workflow „Capital.com Kerzen-Download“) nach `data/raw/de40/` legen.
2. Live-Trades als JSON nach `data/live/` (z. B. Export der Data Table `ft_trades`; eine Version liegt schon bei).
3. Ausführen:

```bash
node bin/bt.js clean --config config/de40-orb60.json      # Datenqualität ansehen
node bin/bt.js run   --config config/de40-orb60.json      # Backtest + Analyse + Live-Abgleich
node bin/bt.js optimize --config config/de40-orb60.json   # Parameter-Robustheit + Walk-Forward
```

Ergebnis: `out/de40-orb60/report.html`

## Was der Report enthält

- **Empfehlungen** (sortiert): Warnungen zu Datenqualität/Statistik, Filter gegen Schwächen (echt nachgerechnet,
  in beiden Zeithälften geprüft), bessere Ausstiege, Risiko je Trade für FTMO, Hinweise zur Stabilität
- **Kennzahlen** in R und %: Ø je Trade mit Konfidenzintervall, Profit-Faktor, Drawdown, schlechtester Tag
- **Muster**: Ergebnis nach Wochentag, Stunde, Richtung, Marktumfeld (ATR, Gap, Trend) und Strategie-Merkmalen
- **Ausstiegs-Varianten** auf denselben Einstiegen (TP 1–3R, Einstand-Stop, engerer SL, Zeit-Exit)
- **Risiko & FTMO**: Monte-Carlo-Drawdown je Risikostufe, Challenge-Bestehenschance
- **Live-Abgleich**: Trade für Trade, Backtest vs. live
- **Parameter-Robustheit** (bei `optimize`): IS/OOS, Plateau, Walk-Forward

## Optionen

| Flag | Wirkung |
|---|---|
| `--data pfad[,pfad]` | Datenquelle überschreiben (Datei, ZIP, Ordner) |
| `--live datei` / `--live none` | Live-Abgleich-Datei |
| `--from` / `--to` | Testzeitraum (Historie davor bleibt für Profile sichtbar) |
| `--param name=wert` | Strategie-Parameter, z. B. `--param tpR=2` |
| `--set name=wert` | Engine, z. B. `--set riskPercent=0.5 --set entrySlippagePts=2` |
| `--grid '{...}'` | eigenes Raster für `optimize` |
| `--out ordner` | Ausgabeordner |

Details zur Architektur und zu den Regeln: `CLAUDE.md`.
