#!/usr/bin/env python3
"""Historische M1-Kerzen (Bid + Ask) von Dukascopy laden und zu M5 im Lab-Format zusammenfassen.

  python3 -I tools/dukascopy_download.py probe                     # erstes Jahr mit Daten je Symbol
  python3 -I tools/dukascopy_download.py fetch [EPIC …] [--from 2013-01-01] [--to 2026-11-06] [--side BID|ASK] [--workers 8]
  python3 -I tools/dukascopy_download.py build [EPIC …]            # Cache -> data/dukascopy/<epic>/dukascopy_<EPIC>_MINUTE_5_<Jahr>.csv

Quelle: https://datafeed.dukascopy.com/datafeed/<SYM>/<JJJJ>/<MM-1>/<TT>/<BID|ASK>_candles_min_1.bi5 (LZMA, je Minute 24 Byte:
Sekunde ab 00:00 UTC, Open, Close, Low, High als int32 × 10^-Stellen, Volumen float32). Monat ist 0-basiert.
Rohdateien werden unter data/dukascopy/cache/ gespeichert (Lauf setzt dort fort). Der Server antwortet oft 503 -> Wiederholung mit Pause.
M5-Kerze nur, wenn in den 5 Minuten Volumen > 0 war (wie Capital: keine Kerze ohne Ticks). Zeitstempel = Kerzenbeginn UTC.
Dukascopy-Kurse sind NICHT Capital-Kurse (anderer Broker, anderer Spread) -> Abgleich mit tools/dukascopy_compare.py.
"""
import os, sys, lzma, struct, time, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, 'data', 'dukascopy')
SYMS = {'DE40': ('DEUIDXEUR', 3), 'US100': ('USATECHIDXUSD', 3), 'EURUSD': ('EURUSD', 5)}
URL = 'https://datafeed.dukascopy.com/datafeed/%s/%04d/%02d/%02d/%s_candles_min_1.bi5'

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

def cache_path(sym, d, side):
    return os.path.join(BASE, 'cache', sym, '%04d' % d.year, '%02d' % d.month, '%02d_%s.bi5' % (d.day, side))

def get(sym, d, side, tries=8):
    """Rohdatei holen (Cache). Rückgabe bytes (b'' = keine Daten an diesem Tag) oder None bei dauerhaftem Fehler."""
    p = cache_path(sym, d, side)
    if os.path.exists(p): return open(p, 'rb').read()
    url = URL % (sym, d.year, d.month - 1, d.day, side)
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (backtest-lab)'}), timeout=120) as r:  # Server antwortet teils erst nach 30–40 s
                b = r.read()
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = '%s.%d.tmp' % (p, os.getpid())
            open(tmp, 'wb').write(b); os.replace(tmp, p)  # atomar: nie halbe Dateien im Cache
            return b
        except urllib.error.HTTPError as e:
            if e.code == 404:
                os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'wb').write(b''); return b''
            time.sleep(min(30, 1.5 * 2 ** k))  # 503: Server überlastet/Drosselung
        except Exception:
            time.sleep(min(30, 1.5 * 2 ** k))
    return None

def decode(b, digits):
    if not b: return []
    try: raw = lzma.decompress(b)
    except lzma.LZMAError: return None
    sc = 10 ** digits
    return [(t, o / sc, h / sc, l / sc, c / sc, v) for t, o, c, l, h, v in (struct.unpack('>5if', raw[i:i + 24]) for i in range(0, len(raw) - 23, 24))]

def days(a, b):
    d = a
    while d <= b:
        if d.weekday() != 5: yield d  # Samstag nie gehandelt
        d += datetime.timedelta(days=1)

def probe():
    for epic, (sym, dg) in SYMS.items():
        first = None
        for y in range(2003, 2027):
            d = datetime.date(y, 3, 4)
            while d.weekday() >= 5: d += datetime.timedelta(days=1)
            rows = decode(get(sym, d, 'BID'), dg) or []
            if any(r[5] > 0 for r in rows): first = y; break
        print('%-6s %-14s erstes Jahr mit Volumen (Stichtag Anfang März): %s' % (epic, sym, first))

def fetch(epics):
    """Paralleles Laden (--workers, Standard 8): der Server antwortet langsam (~15 s), verträgt aber mehrere Anfragen gleichzeitig."""
    from concurrent.futures import ThreadPoolExecutor
    a = datetime.date.fromisoformat(arg('--from', '2013-01-01')); b = datetime.date.fromisoformat(arg('--to', datetime.date.today().isoformat()))
    workers = int(arg('--workers', 8))
    for epic in epics:
        sym, dg = SYMS[epic]
        sides = [arg('--side')] if arg('--side') else ['BID', 'ASK']
        jobs = [(d, side) for d in days(a, b) for side in sides if not os.path.exists(cache_path(sym, d, side))]
        t0 = time.time(); fail = 0
        print('%s %s: %d Dateien offen, %d parallel' % (epic, '+'.join(sides), len(jobs), workers), flush=True)
        with ThreadPoolExecutor(workers) as ex:
            for i, ok in enumerate(ex.map(lambda j: get(sym, j[0], j[1]) is not None, jobs)):
                fail += not ok
                if i % 200 == 0:
                    print('%s %s  %d/%d Dateien  %.0f s  Fehler %d' % (epic, '+'.join(sides), i, len(jobs), time.time() - t0, fail), flush=True)
        print('%s %s fertig: %d Dateien, %d dauerhafte Fehler (erneut starten holt sie nach)' % (epic, '+'.join(sides), len(jobs), fail), flush=True)

def build(epics):
    for epic in epics:
        sym, dg = SYMS[epic]
        out_dir = os.path.join(BASE, epic.lower()); os.makedirs(out_dir, exist_ok=True)
        root = os.path.join(BASE, 'cache', sym)
        years = sorted(os.listdir(root)) if os.path.isdir(root) else []
        for y in years:
            bars, bad = [], 0
            for m in sorted(os.listdir(os.path.join(root, y))):
                for fn in sorted(os.listdir(os.path.join(root, y, m))):
                    if not fn.endswith('_BID.bi5'): continue
                    day = datetime.date(int(y), int(m), int(fn[:2]))
                    bid = decode(open(os.path.join(root, y, m, fn), 'rb').read(), dg)
                    ap = os.path.join(root, y, m, fn.replace('_BID', '_ASK'))
                    ask = decode(open(ap, 'rb').read(), dg) if os.path.exists(ap) else None
                    if not bid or not ask or len(bid) != len(ask): bad += bid is None or ask is None; continue
                    t0 = datetime.datetime(day.year, day.month, day.day, tzinfo=datetime.timezone.utc)
                    for k in range(0, len(bid), 5):
                        B, A = bid[k:k + 5], ask[k:k + 5]
                        vol = sum(r[5] for r in B)
                        if vol <= 0: continue
                        live = [j for j in range(len(B)) if B[j][5] > 0]  # nur Minuten mit Ticks
                        Bl, Al = [B[j] for j in live], [A[j] for j in live]
                        ts = (t0 + datetime.timedelta(seconds=B[0][0])).strftime('%Y-%m-%dT%H:%M:%SZ')
                        bars.append((ts, Bl[0][1], max(r[2] for r in Bl), min(r[3] for r in Bl), Bl[-1][4],
                                     Al[0][1], max(r[2] for r in Al), min(r[3] for r in Al), Al[-1][4], round(vol, 4)))
            if not bars: continue
            p = os.path.join(out_dir, 'dukascopy_%s_MINUTE_5_%s.csv' % (epic, y))
            with open(p, 'w') as fh:
                fh.write('timestamp,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,volume\n')
                for r in bars: fh.write(','.join(str(x) for x in r) + '\n')
            print('%s %s: %d M5-Kerzen%s -> %s' % (epic, y, len(bars), (', %d kaputte Tage' % bad) if bad else '', os.path.relpath(p, ROOT)))

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'probe'
    eps = [a for a in sys.argv[2:] if a in SYMS] or list(SYMS)
    {'probe': lambda: probe(), 'fetch': lambda: fetch(eps), 'build': lambda: build(eps)}[cmd]()
