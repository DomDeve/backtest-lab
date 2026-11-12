#!/usr/bin/env python3
"""Historischer Wirtschaftskalender aus ForexFactory (2007 bis heute) für News-Sperren und News-Tage im Backtest.

  python3 -I tools/news_calendar.py build    # data/news/ff_raw/<mon>.<jahr>.json -> data/news/ff_calendar.csv + Prüfbericht
  python3 -I tools/news_calendar.py check    # Stichproben bekannter Termine (NFP, FOMC, EZB, CPI) ausgeben

Quelle: ForexFactory-Monatsansicht (https://www.forexfactory.com/calendar?month=jun.2015), Feld `dateline` = Unix-Zeit (UTC),
also unabhängig von der Zeitzone der Anzeige. Rohdaten je Monat (alle Währungen und Impact-Stufen) liegen in data/news/ff_raw/,
abgeholt am 09.11.2026 im Browser (Skript-Abrufe blockt ForexFactory per Cloudflare – nicht umgehen).
Rohzeile: [id, ebaseId, dateline, currency, impactName, prefixedName, actual, forecast, previous, revision, timeLabel, timeMasked]

Hinweise:
- Impact (high/medium/low/holiday) ist der heutige Stand bei ForexFactory; FF stuft Termine gelegentlich nachträglich um.
- Termine ohne feste Uhrzeit ("All Day", "Day 1", "Tentative", leere Zeit bei timeMasked) -> exact_time = 0. Für eine
  Sperre um die Uhrzeit nur exact_time = 1 verwenden; ganztägige Termine (Gipfel, Feiertage) taugen als Tagesmerkmal.
- Der Hugging-Face-Abzug (Tropstan/Forex_Factory_Calendar) ist NICHT brauchbar: viele Termine stehen dort auf 00:00
  (z. B. NFP 05.06.2015) – deshalb direkt von ForexFactory.
"""
import os, sys, csv, json, glob, re, datetime, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'news', 'ff_raw')
OUT = os.path.join(ROOT, 'data', 'news', 'ff_calendar.csv')
TIME_RE = re.compile(r'^\d{1,2}:\d\d[ap]m$')
# Welche Währungen bewegen welchen Markt (Sperre/News-Tag je Epic)
EPIC_CCY = {'DE40': ('EUR',), 'US100': ('USD',), 'EURUSD': ('EUR', 'USD'), 'GBPUSD': ('GBP', 'USD'), 'USDJPY': ('USD', 'JPY')}
COLS = ['utc', 'ts', 'currency', 'impact', 'event', 'actual', 'forecast', 'previous', 'exact_time', 'ff_id']


def rows_from_raw(raw):
    """Rohzeilen eines Monats -> Kalenderzeilen (dict). Leere Zeit = gleiche Uhrzeit wie der Termin davor (FF-Darstellung)."""
    out, last_exact = [], 1
    for r in raw:
        fid, _, ts, cur, imp, name, act, fc, prev, _rev, label, masked = r
        label = (label or '').strip()
        exact = 1 if TIME_RE.match(label) else (last_exact if label == '' else 0)
        if masked: exact = 0
        last_exact = exact
        t = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc)
        out.append(dict(utc=t.strftime('%Y-%m-%dT%H:%M:%SZ'), ts=int(ts), currency=cur, impact=imp, event=name, actual=act or '',
                        forecast=fc or '', previous=prev or '', exact_time=exact, ff_id=fid))
    return out


def build():
    files = sorted(glob.glob(os.path.join(RAW, '*.json')))
    seen, rows = set(), []
    for f in files:
        for r in rows_from_raw(json.load(open(f))):
            if r['ff_id'] in seen: continue  # Monatsgrenzen: gleiche ID kann zweimal erscheinen
            seen.add(r['ff_id']); rows.append(r)
    rows.sort(key=lambda r: (r['ts'], r['currency'], r['event']))
    with open(OUT, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=COLS); w.writeheader(); w.writerows(rows)
    by = collections.defaultdict(collections.Counter)
    for r in rows:
        if r['currency'] in ('USD', 'EUR'): by[r['utc'][:4]][r['currency'] + '_' + r['impact']] += 1
    print('%d Monate, %d Termine -> %s' % (len(files), len(rows), os.path.relpath(OUT, ROOT)))
    print('Jahr  USD high/med  EUR high/med  ohne Uhrzeit (USD/EUR high)')
    for y in sorted(by):
        c = by[y]
        nx = sum(1 for r in rows if r['utc'][:4] == y and r['currency'] in ('USD', 'EUR') and r['impact'] == 'high' and not r['exact_time'])
        print('%s  %4d/%4d     %4d/%4d     %d' % (y, c['USD_high'], c['USD_medium'], c['EUR_high'], c['EUR_medium'], nx))


def load(path=OUT):
    with open(path) as fh:
        return [dict(r, ts=int(r['ts']), exact_time=int(r['exact_time'])) for r in csv.DictReader(fh)]


def news_times(rows, epic, impacts=('high',)):
    """Sortierte Unix-Zeiten der Termine mit fester Uhrzeit, die den Epic betreffen."""
    ccy = EPIC_CCY[epic]
    return sorted({r['ts'] for r in rows if r['currency'] in ccy and r['impact'] in impacts and r['exact_time']})


def blocked(ts, times, before_min=2, after_min=2):
    """True, wenn ts (Unix, UTC) im Fenster [Termin − before, Termin + after] liegt (FTMO-Regel: 2 Minuten davor/danach)."""
    import bisect
    i = bisect.bisect_left(times, ts - after_min * 60)
    return i < len(times) and times[i] <= ts + before_min * 60


def news_days(rows, epic, impacts=('high',)):
    """Menge der Kalendertage (UTC, 'YYYY-MM-DD') mit mindestens einem Termin der Stufe(n) für den Epic (inkl. ganztägig)."""
    ccy = EPIC_CCY[epic]
    return {r['utc'][:10] for r in rows if r['currency'] in ccy and r['impact'] in impacts}


def check():
    rows = load()
    probe = [('US', 'Non-Farm Employment Change'), ('US', 'Federal Funds Rate'), ('EZ', 'Main Refinancing Rate'), ('US', 'CPI m/m')]
    for pre, ev in probe:
        hits = [r for r in rows if r['event'] == pre + ' ' + ev]
        hrs = collections.Counter(r['utc'][11:16] for r in hits)
        print('%-32s %4d Termine, häufigste UTC-Zeiten %s' % (pre + ' ' + ev, len(hits), hrs.most_common(4)))


if __name__ == '__main__':
    {'build': build, 'check': check}[sys.argv[1] if len(sys.argv) > 1 else 'build']()
