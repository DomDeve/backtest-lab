#!/usr/bin/env python3
"""Phase 0 – Engine-Validierung: Live-Trades (n8n d_tradelog) gegen den Backtest im selben Zeitraum.

Aufruf:  python3 tools/phase0.py [data/live/d_tradelog.json|.csv]   -> out/analyse/phase0.json + phase0.html
Vorher: Kerzendaten bis zum Ende des Live-Zeitraums nach data/raw/<symbol>/ legen und die Live-Varianten neu rechnen
(node bin/live.js run --variants group:...), damit out/live/<id>/result.json den Zeitraum abdeckt.

Abgleich je gefülltem Live-Trade (WIN/LOSS): gleiche Variante, gleiche Richtung, Backtest-Einstieg innerhalb ±30 min.
Ausgabe: Anteil gematchter Trades, Abweichung Einstieg/Ausstieg (Punkte/Pips), nur live / nur Backtest, Δ R.
Ziel: >= 90 % Match. Zeitstempel ohne Zone werden als UTC gelesen (Capital-API).
"""
import json, csv, os, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = os.environ.get('PHASE0_BT') or os.path.join(ROOT, 'out', 'live')  # PHASE0_BT=out/live-de40feed für den Abgleich mit Live-Datenfehler
OUT = os.path.join(ROOT, 'out', 'analyse')
WINDOW_MIN = 30
PRICE_WINDOW_H = 4
# Bot-Name bzw. bot_id im d_tradelog -> Varianten-ID im Katalog
MAP = {
    'F618ATR': 'nas-f618atr', 'NAS F618ATR': 'nas-f618atr', 'LB2F50': 'nas-fib50-lb2', 'NAS Fib50 LB2': 'nas-fib50-lb2',
    'LB3F50': 'nas-fib50-lb3', 'NAS Fib50 LB3': 'nas-fib50-lb3', 'LB1F618': 'nas-fib61-lb1', 'NAS Fib61 LB1': 'nas-fib61-lb1',
    'LB2F618': 'nas-fib61-lb2', 'NAS Fib61 LB2': 'nas-fib61-lb2', 'LB3F618': 'nas-fib61-lb3', 'NAS Fib61 LB3': 'nas-fib61-lb3',
    'de40loose': 'de40-basis', 'DAX LVN Loose': 'de40-basis', 'de40confl3': 'de40-confl3', 'DAX LVN Confluence 3': 'de40-confl3',
    'de4dist150': 'de40-dist150', 'DAX LVN Distance 150': 'de40-dist150', 'de40lvn07': 'de40-q07', 'DAX LVN Quality 0.7': 'de40-q07',
    'de40adx25': 'de40-adx25', 'DAX LVN ADX 25': 'de40-adx25', 'de40combo': 'de40-combo', 'DAX LVN Combo': 'de40-combo',
    'EUC1LEGTP1': 'eu-c1', 'EU C1 Legacy TP1': 'eu-c1', 'EUC2PBTP1': 'eu-c2', 'EU C2 Pullback TP1': 'eu-c2',
    'EUC3PBTP15': 'eu-c3', 'EU C3 Pullback TP1.5': 'eu-c3', 'EUC4BRMTP15': 'eu-c4', 'EU C4 B&R Market TP1.5': 'eu-c4',
    'EUC5BRLTP15': 'eu-c5', 'EU C5 B&R Limit TP1.5': 'eu-c5', 'EUC6BRMTP1': 'eu-c6', 'EU C6 B&R Market TP1': 'eu-c6',
}

def parse_ts(s):
    if not s: return None
    s = s.replace('Z', '+00:00')
    d = datetime.datetime.fromisoformat(s)
    if d.tzinfo is None: d = d.replace(tzinfo=datetime.timezone.utc)
    return int(d.timestamp() * 1000)

def load_live(path):
    if path.endswith('.csv'):
        with open(path, newline='') as fh: rows = list(csv.DictReader(fh))
    else:
        rows = json.load(open(path)); rows = rows.get('rows', rows) if isinstance(rows, dict) else rows
    out, skipped = [], {'ohne_variante': 0, 'nicht_gefuellt': 0, 'ohne_zeit': 0}
    for r in rows:
        vid = MAP.get((r.get('bot_id') or '').strip()) or MAP.get((r.get('bot') or '').strip())
        if not vid: skipped['ohne_variante'] += 1; continue
        if (r.get('result') or '').upper() not in ('WIN', 'LOSS', 'BE', 'BREAKEVEN'): skipped['nicht_gefuellt'] += 1; continue
        t = parse_ts(r.get('opened_at'))
        if not t: skipped['ohne_zeit'] += 1; continue
        e, sl, x = float(r['entry_price']), float(r['stop_loss']), float(r['exit_price'])
        sgn = 1 if r['direction'] == 'BUY' else -1
        out.append(dict(vid=vid, dir=r['direction'], t=t, entry=e, sl=sl, exit=x, R=(x - e) * sgn / abs(e - sl) if e != sl else None, result=r['result'], id=r.get('id')))
    # Dubletten (gleiche Variante, Richtung, Einstieg auf die Minute) entfernen
    seen, uniq = set(), []
    for x in out:
        k = (x['vid'], x['dir'], x['t'] // 60000, round(x['entry'], 5))
        if k not in seen: seen.add(k); uniq.append(x)
    skipped['dubletten'] = len(out) - len(uniq)
    return uniq, skipped

def load_orders(path):
    """Orders aus d_tradelog ohne Abschluss: OFFEN (kein Ergebnis im Log), EXPIRED, CANCELLED. Erklären „nur Backtest“-Fälle."""
    if not path or not os.path.exists(path): return []
    with open(path, newline='') as fh: rows = list(csv.DictReader(fh))
    out = []
    for r in rows:
        vid = MAP.get((r.get('bot_id') or '').strip()) or MAP.get((r.get('bot') or '').strip())
        t = parse_ts(r.get('opened_at'))
        if vid and t: out.append(dict(vid=vid, dir=r['direction'], t=t, entry=float(r['entry_price']), sl=float(r['stop_loss']), status=r['result'], id=r.get('id')))
    return out

def classify_bt(t, orders):
    """Passt ein Backtest-Trade zu einer Live-Order ohne Abschluss? (gleiche Richtung, Preis ± Toleranz, Füllung -30 min … +26 h nach Platzierung)"""
    best = None
    for o in orders:
        if o['dir'] != t['dir']: continue
        tol = max(abs(o['entry']) * 0.00007, 0.05 * abs(o['entry'] - o['sl']))
        dt = t['entryT'] - o['t']
        if abs(t['entry'] - o['entry']) <= tol and -1800000 <= dt <= 26 * 3600000 and (best is None or abs(dt) < best[0]): best = (abs(dt), o)
    return best[1] if best else None

def compare(live, orders=()):
    res = {}
    for vid in sorted({x['vid'] for x in live}):
        L = sorted([x for x in live if x['vid'] == vid], key=lambda x: x['t'])
        p = os.path.join(LIVE, vid, 'result.json')
        if not os.path.exists(p): res[vid] = dict(status='kein Backtest'); continue
        r = json.load(open(p)); bt_to = r['period']['to']
        # Live-Trades nach dem Ende der Kerzendaten kann der Backtest nicht kennen -> nicht werten
        end_ms = int(datetime.datetime.fromisoformat(bt_to).replace(tzinfo=datetime.timezone.utc).timestamp() * 1000) + 86400000
        beyond = [x for x in L if x['t'] >= end_ms]; L = [x for x in L if x['t'] < end_ms]
        if not L: res[vid] = dict(status=f'Kerzendaten enden {bt_to} – kein Live-Trade im Zeitraum', live=0, beyond=len(beyond)); continue
        lo, hi = min(x['t'] for x in L) - 6 * 3600000, end_ms
        live_to = datetime.datetime.fromtimestamp(max(x['t'] for x in L) / 1000, datetime.timezone.utc).date().isoformat()
        B = [t for t in r['trades'] if lo <= t['entryT'] < hi]
        covered = not beyond
        used, pairs, only_live = set(), [], []
        for x in L:
            best = None
            for i, t in enumerate(B):
                if i in used or t['dir'] != x['dir']: continue
                d = abs(t['entryT'] - x['t'])
                if d <= WINDOW_MIN * 60000 and (best is None or d < best[0]): best = (d, i)
            if best: used.add(best[1]); pairs.append((x, B[best[1]]))
            else: only_live.append(x)
        # Stufe 2 (Limit-Orders): gleicher Preis (± max(2 Pkt/Pips-Äquivalent, 5 % SL)) + Richtung innerhalb PRICE_WINDOW_H -> Füllzeit abweichend
        late, rest = [], []
        for x in only_live:
            tol = max(abs(x['entry']) * 0.00007, 0.05 * abs(x['entry'] - x['sl']))
            cand = [(abs(t['entryT'] - x['t']), i) for i, t in enumerate(B) if i not in used and t['dir'] == x['dir']
                    and abs(t['entry'] - x['entry']) <= tol and abs(t['entryT'] - x['t']) <= PRICE_WINDOW_H * 3600000]
            if cand: i = min(cand)[1]; used.add(i); late.append((x, B[i]))
            else: rest.append(x)
        only_live = rest; pairs_all = pairs + late
        only_bt = [t for i, t in enumerate(B) if i not in used]
        O = [o for o in orders if o['vid'] == vid]
        bt_offen, bt_nf, bt_rest = [], [], []
        for t in only_bt:
            o = classify_bt(t, O)
            (bt_rest if not o else bt_offen if o['status'] == 'OFFEN' else bt_nf).append((t, o))
        union = len(pairs_all) + len(only_live) + len(only_bt)
        dev = lambda f: sum(f(a, b) for a, b in pairs_all) / len(pairs_all) if pairs_all else None
        U = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M')
        res[vid] = dict(status='abgedeckt' if covered else f'{len(beyond)} Live-Trades nach Datenende {bt_to} nicht gewertet', live=len(L), backtest=len(B),
                        matched=len(pairs_all), matched_time=len(pairs), matched_late=len(late),
                        match_rate=len(pairs_all) / union if union else None, match_live=len(pairs_all) / len(L) if L else None,
                        only_live=len(only_live), only_backtest=len(only_bt), bt_log_offen=len(bt_offen), bt_live_nicht_gefuellt=len(bt_nf), bt_unerklaert=len(bt_rest),
                        match_bereinigt=(len(pairs_all) + len(bt_offen)) / union if union else None,
                        list_bt_offen=[(U(t['entryT']), t['dir'], t['entry'], round(t['R'], 2), U(o['t'])) for t, o in bt_offen],
                        list_bt_nf=[(U(t['entryT']), t['dir'], t['entry'], round(t['R'], 2), o['status'], U(o['t'])) for t, o in bt_nf],
                        list_only_live=[(U(x['t']), x['dir'], x['entry'], round(x['R'] or 0, 2)) for x in only_live],
                        list_only_bt=[(U(t['entryT']), t['dir'], t['entry'], round(t['R'], 2)) for t, _ in bt_rest],
                        list_late=[(U(a['t']), U(b['entryT']), a['dir'], a['entry'], round(a['R'] or 0, 2), round(b['R'], 2)) for a, b in late],
                        d_entry=dev(lambda a, b: abs(a['entry'] - b['entry'])), d_exit=dev(lambda a, b: abs(a['exit'] - (b.get('exit') or a['exit']))),
                        d_R=dev(lambda a, b: abs((a['R'] or 0) - b['R'])), same_outcome=dev(lambda a, b: 1.0 if (a['R'] or 0) > 0 and b['R'] > 0 or (a['R'] or 0) <= 0 and b['R'] <= 0 else 0.0))
    return res

def report(res, skipped, src):
    os.makedirs(OUT, exist_ok=True)
    json.dump(dict(source=src, created=datetime.datetime.now().isoformat(timespec='seconds'), skipped=skipped, variants=res), open(os.path.join(OUT, 'phase0.json'), 'w'), indent=1)
    fr = lambda x, d=2: '–' if x is None else f'{x:.{d}f}'.replace('.', ',')
    pct = lambda x: '–' if x is None else f'{x * 100:.0f} %'
    rows = ''.join(f"<tr><td>{v}</td><td>{x.get('status')}</td><td class=num>{x.get('live', '–')}</td><td class=num>{x.get('backtest', '–')}</td><td class=num>{x.get('matched', '–')}</td>"
                   f"<td class=num><b>{pct(x.get('match_live'))}</b><br><small>{pct(x.get('match_rate'))} inkl. nur BT</small></td><td class=num><b>{pct(x.get('match_bereinigt'))}</b></td><td class=num>{x.get('only_live', '–')}</td><td class=num>{x.get('only_backtest', '–')}<br><small>Log-Lücke {x.get('bt_log_offen', 0)} · verfallen {x.get('bt_live_nicht_gefuellt', 0)} · offen {x.get('bt_unerklaert', 0)}</small></td>"
                   f"<td class=num>{fr(x.get('d_entry'), 4)}</td><td class=num>{fr(x.get('d_exit'), 4)}</td><td class=num>{fr(x.get('d_R'))}</td></tr>" for v, x in res.items())
    det = ''
    for v, x in res.items():
        items = [('Füllzeit abweichend (gleicher Preis, ≤ 4 h)', [f'live {a} / BT {b}: {d} {e}, R live {f} / BT {g}' for a, b, d, e, f, g in x.get('list_late', [])]),
                 ('nur live', [f'{a} {b} {c} R {d}' for a, b, c, d in x.get('list_only_live', [])]),
                 ('nur Backtest – live als Order im Log, aber ohne Ergebnis (Log-Lücke)', [f'{a} {b} {c} R {d} (Order {e})' for a, b, c, d, e in x.get('list_bt_offen', [])]),
                 ('nur Backtest – live verfallen/gelöscht, im Backtest gefüllt', [f'{a} {b} {c} R {d} ({e}, Order {f})' for a, b, c, d, e, f in x.get('list_bt_nf', [])]),
                 ('nur Backtest – ohne Gegenstück im Log', [f'{a} {b} {c} R {d}' for a, b, c, d in x.get('list_only_bt', [])])]
        det += f'<h3>{v}</h3>' + ''.join(f'<p><b>{t}:</b><br>' + '<br>'.join(l) + '</p>' for t, l in items if l)
    H = f"""<!DOCTYPE html><html lang=de><head><meta charset=utf-8><title>Phase 0 – Live-Abgleich</title><style>body{{font:14px -apple-system,sans-serif;margin:24px;max-width:1200px}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #ddd;padding:5px 8px;text-align:left}}.num{{text-align:right}}</style></head><body>
<h1>Phase 0 – Engine-Validierung gegen d_tradelog</h1><p>Quelle: {src}. Ziel ≥ 90 % Match (Richtung + Einstieg ±{WINDOW_MIN} min, Limit-Orders: gleicher Preis ≤ {PRICE_WINDOW_H} h). „Match bereinigt“ zählt Backtest-Trades als Treffer, die live als Order im Log stehen, aber nie ein Ergebnis bekamen (Log-Lücke). Übersprungen: {skipped}.</p>
<table><tr><th>Variante</th><th>Status</th><th>Live</th><th>Backtest</th><th>gematcht</th><th>Match (Anteil Live)</th><th>Match bereinigt</th><th>nur live</th><th>nur Backtest</th><th>Ø |Δ Einstieg|</th><th>Ø |Δ Ausstieg|</th><th>Ø |Δ R|</th></tr>{rows}</table><h2>Einzelfälle</h2>{det}</body></html>"""
    open(os.path.join(OUT, 'phase0.html'), 'w').write(H)

if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else next((os.path.join(ROOT, 'data', 'live', f) for f in ('d_tradelog.json', 'd_tradelog.csv') if os.path.exists(os.path.join(ROOT, 'data', 'live', f))), None)
    if not src: sys.exit('Kein Export gefunden: bitte d_tradelog als JSON oder CSV nach data/live/d_tradelog.json|.csv legen.')
    live, skipped = load_live(src)
    op = os.path.join(ROOT, 'data', 'live', 'd_tradelog_orders.csv')
    res = compare(live, load_orders(op))
    report(res, skipped, src)
    for v, x in res.items(): print(f"{v:16s} live {x.get('live')} bt {x.get('backtest')} match {x.get('matched')} ({(x.get('match_live') or 0)*100:.0f} % live) nurLive {x.get('only_live')} nurBT {x.get('only_backtest')} [Lücke {x.get('bt_log_offen')}, verfallen {x.get('bt_live_nicht_gefuellt')}, offen {x.get('bt_unerklaert')}] bereinigt {(x.get('match_bereinigt') or 0)*100:.0f} %")
