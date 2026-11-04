# strategies-live

**Unveränderte Kopien der n8n-Code-Nodes** (Stand Export 03.11.2026).
Die Live-Code-Engine (`src/live/`) führt genau diesen Text aus – nichts wurde übersetzt oder umgeschrieben.

- `capital/` – Workflow `d_ilikebigbots` (Capital.com): NAS Fib (5) + F618ATR, DE40 LVN (6), EURUSD C1–C6
- `ftmo/` – Workflow `d_ftmo` (cTrader-Bridge): NAS F618ATR FTMO

Aktualisieren: Workflow per n8n-MCP lesen und die Code-Nodes hier 1:1 überschreiben (`tools/export-code-nodes.py`).
Varianten aus Backtest-Aufträgen werden NICHT hier abgelegt, sondern als Patch in `src/live/variants.js` beschrieben.
