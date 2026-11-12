#!/usr/bin/env python3
"""Tageskerzen (Eröffnung/Schluss) der Kassa-Indizes von Yahoo Finance laden -> data/daily/<name>.csv

  python3 -I tools/yahoo_daily.py            # NDX (Nasdaq 100), DAX, SPX
Öffentlicher Chart-Endpunkt, kein Schlüssel. Datum = Börsendatum in der Zeitzone der Börse.
Qualitätsprüfung je Jahr: Eröffnung fehlt / Eröffnung == Vortagesschluss bzw. High == Low (früher bei Yahoo üblich: nur Schluss erfasst).
Ausgabe-Spalten: date,open,high,low,close,open_ok (open_ok = 0, wenn die Eröffnung fehlt oder unbrauchbar ist).
"""
import os, sys, json, datetime, urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'daily')
SYMBOLS = {'NDX': '^NDX', 'DAX': '^GDAXI', 'SPX': '^GSPC'}
URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?period1=0&period2=9999999999&interval=1d'

def fetch(sym):
    req = urllib.request.Request(URL % urllib.request.quote(sym), headers={'User-Agent': 'Mozilla/5.0 (backtest-lab)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)['chart']['result'][0]

def rows_of(res):
    tz = ZoneInfo(res['meta']['exchangeTimezoneName'])
    q = res['indicators']['quote'][0]
    out = []
    for i, t in enumerate(res['timestamp']):
        o, h, l, c = q['open'][i], q['high'][i], q['low'][i], q['close'][i]
        if c is None: continue
        d = datetime.datetime.fromtimestamp(t, tz).date().isoformat()
        out.append([d, o, h, l, c])
    # doppelte Datumswerte (letzter Abruf-Tag) -> letzter gewinnt
    dd = {}
    for r in out: dd[r[0]] = r
    out = [dd[k] for k in sorted(dd)]
    for i, r in enumerate(out):
        prev = out[i - 1][4] if i else None
        bad = (r[1] is None or r[1] <= 0 or (prev is not None and abs(r[1] - prev) <= 1e-9 * prev + 1e-6)
               or r[2] is None or r[3] is None or r[2] == r[3])  # High == Low: nur Schlusskurs erfasst
        r.append(0 if bad else 1)
    return out

def main():
    os.makedirs(OUT, exist_ok=True)
    for name, sym in SYMBOLS.items():
        rows = rows_of(fetch(sym))
        p = os.path.join(OUT, name + '.csv')
        with open(p, 'w') as fh:
            fh.write('date,open,high,low,close,open_ok\n')
            for r in rows: fh.write(','.join('' if v is None else (('%.4f' % v) if isinstance(v, float) else str(v)) for v in r) + '\n')
        by = {}
        for r in rows: b = by.setdefault(r[0][:4], [0, 0]); b[0] += 1; b[1] += 1 - r[5]
        bad_years = [y for y, (n, b) in sorted(by.items()) if b > 0.02 * n]
        print('%s %s: %d Tage %s -> %s, Jahre mit > 2 %% unbrauchbarer Eröffnung: %s' % (name, sym, len(rows), rows[0][0], rows[-1][0], ', '.join(bad_years) or 'keine'))

if __name__ == '__main__':
    main()
