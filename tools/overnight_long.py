#!/usr/bin/env python3
"""Overnight-Drift auf langer Tageshistorie (Kassa-Indizes, data/daily/*.csv aus tools/yahoo_daily.py).

  python3 -I tools/overnight_long.py   -> out/kandidaten/overnight/langfrist.md + langfrist.json

Je Handelstag t (nur mit brauchbarer Eröffnung):  Overnight r_on = O_t / C_{t-1} - 1,  Intraday r_id = C_t / O_t - 1.
Varianten (vorab festgelegt, wie bin/overnight.js): ON jede Nacht, ON-WT nur 1-Kalendernacht-Lücken (kein Wochenende/Feiertag),
ON-SMA nur wenn C_{t-1} > SMA200 der Schlusskurse bis t-1. Kontrollen: ID (Intraday-Long), BH (Buy-and-Hold Schluss -> Schluss).
Kosten: Spread je Round-Turn wie im CFD gemessen (US100 0,008 %, DE40 0,007 %, 2024-26), Empfindlichkeit × 3 für ältere Jahre.
Finanzierung je Kalendernacht: feste Sätze 0/3/5/7 % p. a. und "historisch" = Leitzins-Jahresmittel (Näherung) + 2,5 % Aufschlag.
BH zahlt dieselbe Finanzierung je Nacht wie ON (beide halten jede Nacht) -> fairer Vergleich.
Abgleich mit dem CFD (Capital M5, 2024-26): Overnight aus Session-Schluss/-Eröffnung (Mitte) vs. Kassa-Index je Tag.
"""
import os, sys, csv, json, math, glob, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sessions as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'kandidaten', 'overnight')
IDX = {  # Kassa-Index -> CFD-Epic, Spread-Kosten % je Round-Turn (gemessen), Leitzins-Währung
    'NDX': dict(epic='US100', cost=0.008, ccy='USD'),
    'DAX': dict(epic='DE40', cost=0.007, ccy='EUR'),
    'SPX': dict(epic=None, cost=0.008, ccy='USD'),
}
MARKUP = 2.5
# Leitzins-Jahresmittel in % (Näherung aus dem Gedächtnis: Fed Funds effektiv bzw. EONIA/€STR; 2026 geschätzt) – nur für das Szenario "historisch"
RATE = {
    'USD': {1994: 4.2, 1995: 5.8, 1996: 5.3, 1997: 5.5, 1998: 5.4, 1999: 5.0, 2000: 6.2, 2001: 3.9, 2002: 1.7, 2003: 1.1, 2004: 1.35, 2005: 3.2, 2006: 5.0,
            2007: 5.0, 2008: 1.9, 2009: 0.16, 2010: 0.18, 2011: 0.1, 2012: 0.14, 2013: 0.11, 2014: 0.09, 2015: 0.13, 2016: 0.4, 2017: 1.0, 2018: 1.8,
            2019: 2.2, 2020: 0.4, 2021: 0.08, 2022: 1.7, 2023: 5.0, 2024: 5.1, 2025: 4.2, 2026: 3.7},
    'EUR': {1994: 5.3, 1995: 4.5, 1996: 3.3, 1997: 3.2, 1998: 3.4, 1999: 2.7, 2000: 4.1, 2001: 4.4, 2002: 3.3, 2003: 2.3, 2004: 2.05, 2005: 2.1, 2006: 2.8,
            2007: 3.9, 2008: 3.9, 2009: 0.7, 2010: 0.44, 2011: 0.87, 2012: 0.23, 2013: 0.09, 2014: 0.09, 2015: -0.11, 2016: -0.32, 2017: -0.35,
            2018: -0.36, 2019: -0.39, 2020: -0.47, 2021: -0.57, 2022: 0.0, 2023: 3.2, 2024: 3.6, 2025: 2.2, 2026: 1.9},
}
FIXED = [0, 3, 5, 7]

def load(name):
    rows = [r for r in csv.DictReader(open(os.path.join(ROOT, 'data', 'daily', name + '.csv')))]
    for r in rows:
        for k in ('open', 'high', 'low', 'close'): r[k] = float(r[k]) if r[k] else None
        r['open_ok'] = r['open_ok'] == '1'
    # Beginn: erstes Jahr, ab dem jedes Jahr ≤ 2 % unbrauchbare Eröffnungen hat
    by = {}
    for r in rows: b = by.setdefault(r['date'][:4], [0, 0]); b[0] += 1; b[1] += not r['open_ok']
    years = sorted(by); start = years[0]
    for y in years:
        if by[y][1] > 0.02 * by[y][0]: start = str(int(y) + 1)
    return [r for r in rows if r['date'] >= start], start

def nights(d0, d1): return (datetime.date.fromisoformat(d1) - datetime.date.fromisoformat(d0)).days

def series(rows):
    """Tagesdatensätze mit r_on, r_id, r_bh (in %), Nächte, SMA200-Bedingung zum Vortagesschluss."""
    out, closes = [], []
    for i in range(1, len(rows)):
        p, r = rows[i - 1], rows[i]
        closes.append(p['close'])
        sma_ok = len(closes) >= 200 and p['close'] > sum(closes[-200:]) / 200
        if not r['open_ok']: continue
        out.append(dict(date=r['date'], year=int(r['date'][:4]), n=nights(p['date'], r['date']),
                        on=(r['open'] / p['close'] - 1) * 100, id=(r['close'] / r['open'] - 1) * 100, bh=(r['close'] / p['close'] - 1) * 100,
                        sma=sma_ok, close=r['close']))
    return out

def fin_rate(mode, ccy, year):
    base = RATE[ccy].get(year, RATE[ccy][max(RATE[ccy])])
    return base + MARKUP if mode == 'hist' else base if mode == 'rf' else mode  # 'rf' ≈ Future (Basis = Leitzins, kein Broker-Aufschlag)

def stats(x, dates):
    n = len(x)
    if n < 2: return dict(n=n)
    m = sum(x) / n; s = math.sqrt(sum((v - m) ** 2 for v in x) / (n - 1))
    yrs = max(1e-9, nights(dates[0], dates[-1]) / 365.25)
    eq = pk = dd = 0.0
    for v in x: eq += v; pk = max(pk, eq); dd = min(dd, eq - pk)
    h = n // 2
    thirds = [sum(x[k * n // 3:(k + 1) * n // 3]) / max(1, len(x[k * n // 3:(k + 1) * n // 3])) for k in range(3)]
    return dict(n=n, mean=m, t=m / s * math.sqrt(n) if s else 0, win=sum(v > 0 for v in x) / n, perYear=eq / yrs, sharpe=m / s * math.sqrt(n / yrs) if s else 0,
                maxDD=dd, worst=min(x), h1=sum(x[:h]) / h, h2=sum(x[h:]) / (n - h), thirds=thirds)

def variant(sr, vid, cost, ccy, fmode):
    """Rendite je Trade nach Spread und Finanzierung (nur Long-Varianten halten über Nacht)."""
    xs, ds = [], []
    for d in sr:
        if vid == 'ID': v = d['id'] - cost
        elif vid == 'BH': v = d['bh'] - fin_rate(fmode, ccy, d['year']) * d['n'] / 365  # Spread vernachlässigbar (ein Kauf)
        else:
            if vid == 'ON-WT' and d['n'] != 1: continue
            if vid == 'ON-SMA' and not d['sma']: continue
            v = d['on'] - cost - fin_rate(fmode, ccy, d['year']) * d['n'] / 365
        xs.append(v); ds.append(d['date'])
    return xs, ds

def bear_flags(sr):
    """Bärenmarkt-Tage: Schlusskurs ≥ 20 % unter dem bisherigen Höchststand (zum Vortag bekannt -> nur Einordnung, kein Filter)."""
    pk, flags = 0, []
    for d in sr:
        flags.append(pk > 0 and d['close'] < 0.8 * pk)
        pk = max(pk, d['close'])
    return flags

def cfd_check(name, sr):
    """Overnight aus Capital-M5 (Mitte zur Session-Eröffnung/-Schluss) vs. Kassa-Index, gleiche Tage."""
    epic = IDX[name]['epic']
    if not epic: return None
    files = glob.glob(os.path.join(ROOT, 'data', 'raw', epic.lower(), '*MINUTE_5_*.csv'))
    mid = {}
    for f in files:
        for r in csv.reader(open(f)):
            if r[0] == 'timestamp' or len(r) < 9: continue
            try: mid[r[0][:16]] = (float(r[1]) + float(r[5])) / 2
            except ValueError: pass
    def at(dt): return mid.get(dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M'))
    cfd = {}
    days = sorted({k[:10] for k in mid})
    prev_close = None
    for d in days:
        w = S.session_utc(epic, d)
        if not w: continue
        o, c = at(w[0]), at(w[1])
        if o and prev_close: cfd[d] = (o / prev_close - 1) * 100
        if c: prev_close = c
        else: prev_close = None
    pairs = [(cfd[d['date']], d['on']) for d in sr if d['date'] in cfd]
    if len(pairs) < 50: return None
    a = [p[0] for p in pairs]; b = [p[1] for p in pairs]
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    cov = sum((x - ma) * (y - mb) for x, y in pairs); va = sum((x - ma) ** 2 for x in a); vb = sum((y - mb) ** 2 for y in b)
    return dict(n=len(pairs), cfd_mean=ma, idx_mean=mb, corr=cov / math.sqrt(va * vb), mean_abs_diff=sum(abs(x - y) for x, y in pairs) / len(pairs))

def f(x, d=2):
    return '–' if x is None or (isinstance(x, float) and not math.isfinite(x)) else ('%+.*f' % (d, x)).replace('.', ',')

def main():
    os.makedirs(OUT, exist_ok=True)
    res = dict(created=datetime.date.today().isoformat(), markup=MARKUP, indices={})
    md = ['# Overnight-Drift – lange Historie (Kassa-Indizes)', '',
          'Erstellt %s. Quelle: Yahoo Finance Tageskerzen (`tools/yahoo_daily.py`), nur Tage mit brauchbarer Eröffnung. Renditen in %% je Trade, Hebel 1, ' % res['created'] +
          'Summen additiv. Kosten = CFD-Spread je Round-Turn (gemessen 2024–26). Finanzierung je Kalendernacht; „hist.“ = Leitzins-Jahresmittel (Näherung) + %s %%. ' % str(MARKUP).replace('.', ',') +
          '„nur Leitzins“ ≈ Future/ohne Broker-Aufschlag. Buy-and-Hold zahlt dieselbe Finanzierung je Nacht. Leitzinsen = Jahresmittel aus dem Gedächtnis (Näherung).', '',
          '**Achtung Kassa-Eröffnung:** Der erste Indexwert nutzt für noch nicht eröffnete Aktien den Vortagesschluss -> der Overnight-Anteil wird eher unterschätzt. '
          'Abgleich mit dem CFD unten.', '']
    for name, meta in IDX.items():
        rows, start = load(name)
        sr = series(rows)
        cost, ccy = meta['cost'], meta['ccy']
        R = res['indices'][name] = dict(start=start, end=sr[-1]['date'], days=len(sr), variants={}, years={}, bear={}, cfd=cfd_check(name, sr))
        md += ['## %s (%s → %s, %d Tage)' % (name, sr[0]['date'], sr[-1]['date'], len(sr)), '']
        if R['cfd']:
            c = R['cfd']
            md += ['Abgleich CFD %s (2024–26, %d Nächte): Ø Overnight CFD %s %% vs. Kassa %s %%, Korrelation %s, Ø |Diff| %s %%.' % (
                meta['epic'], c['n'], f(c['cfd_mean'], 3), f(c['idx_mean'], 3), f(c['corr'], 2).lstrip('+'), f(c['mean_abs_diff'], 3).lstrip('+')), '']
        md += ['| Variante | Finanzierung | Trades | Ø % | t | Treffer | Σ %/Jahr | Sharpe | max. DD % | schlechteste | Hälften Ø % | Drittel Ø % |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
        for vid in ['ON', 'ON-WT', 'ON-SMA', 'ID', 'BH']:
            for fm in (FIXED + ['rf', 'hist']) if vid in ('ON', 'BH') else [0, 'rf', 'hist']:
                if vid == 'ID' and fm != 0: continue
                xs, ds = variant(sr, vid, cost, ccy, fm)
                st = stats(xs, ds)
                R['variants']['%s|%s' % (vid, fm)] = st
                md.append('| %s | %s | %d | %s | %s | %d %% | %s | %s | %s | %s | %s · %s | %s |' % (
                    vid, {'hist': 'hist.', 'rf': 'nur Leitzins'}.get(fm, '%s %%' % fm), st['n'], f(st['mean'], 3), f(st['t'], 1), round(100 * st['win']), f(st['perYear'], 1), f(st['sharpe'], 2),
                    f(st['maxDD'], 1), f(st['worst'], 1), f(st['h1'], 3), f(st['h2'], 3), ' · '.join(f(v, 3) for v in st['thirds'])))
        # Spread-Empfindlichkeit
        xs, ds = variant(sr, 'ON', cost * 3, ccy, 'hist'); st3 = stats(xs, ds)
        R['variants']['ON|hist|spread3'] = st3
        md += ['', 'Mit dreifachem Spread (ältere Jahre): ON hist. Ø %s %%, t %s, Σ %s %%/Jahr.' % (f(st3['mean'], 3), f(st3['t'], 1), f(st3['perYear'], 1)), '']
        # je Jahr
        md += ['### Je Jahr (Σ % nach hist. Finanzierung)', '', '| Jahr | Leitzins+Aufschlag | ON | ON-WT | ON-SMA | ID | BH | ON − BH |', '|---|---|---|---|---|---|---|---|']
        yrs = sorted({d['year'] for d in sr})
        per = {vid: variant(sr, vid, cost, ccy, 'hist') for vid in ['ON', 'ON-WT', 'ON-SMA', 'ID', 'BH']}
        pos = {vid: 0 for vid in per}
        for y in yrs:
            row = {}
            for vid, (xs, ds) in per.items():
                row[vid] = sum(v for v, d in zip(xs, ds) if d[:4] == str(y))
                pos[vid] += row[vid] > 0
            R['years'][y] = row
            md.append('| %d | %s %% | %s | %s | %s | %s | %s | %s |' % (y, f(fin_rate('hist', ccy, y), 1).lstrip('+'), *(f(row[v], 1) for v in ['ON', 'ON-WT', 'ON-SMA', 'ID', 'BH']), f(row['ON'] - row['BH'], 1)))
        md += ['', 'Positive Jahre: ' + ', '.join('%s %d/%d' % (v, pos[v], len(yrs)) for v in pos) + '.', '']
        # Bärenmärkte
        flags = bear_flags(sr)
        md += ['### Bärenmarkt (Schluss ≥ 20 % unter Hoch) vs. sonst – Ø % je Tag, hist. Finanzierung', '', '| Variante | Bär: Tage | Bär: Ø % | Bär: t | sonst: Ø % | sonst: t |', '|---|---|---|---|---|---|']
        for vid in ['ON', 'ON-WT', 'ON-SMA', 'ID', 'BH']:
            xs, ds = variant(sr, vid, cost, ccy, 'hist')
            fl = {d['date']: b for d, b in zip(sr, flags)}
            a = [v for v, d in zip(xs, ds) if fl[d]]; b = [v for v, d in zip(xs, ds) if not fl[d]]
            sa, sb = stats(a, [d for d in ds if fl[d]]) if len(a) > 1 else dict(n=len(a)), stats(b, [d for d in ds if not fl[d]])
            R['bear'][vid] = dict(bear=sa, other=sb)
            md.append('| %s | %d | %s | %s | %s | %s |' % (vid, sa['n'], f(sa.get('mean'), 3), f(sa.get('t'), 1), f(sb['mean'], 3), f(sb['t'], 1)))
        md.append('')
        on = R['variants']['ON|hist']; bh = R['variants']['BH|hist']
        print('%s %s→%s: ON hist Ø %.3f %% t %.1f Sharpe %.2f DD %.0f | BH Sharpe %.2f DD %.0f%s' % (name, sr[0]['date'], sr[-1]['date'], on['mean'], on['t'], on['sharpe'], on['maxDD'], bh['sharpe'], bh['maxDD'],
              (' | CFD-Abgleich r=%.2f' % R['cfd']['corr']) if R['cfd'] else ''))
    json.dump(res, open(os.path.join(OUT, 'langfrist.json'), 'w'), indent=1)
    open(os.path.join(OUT, 'langfrist.md'), 'w').write('\n'.join(md))

if __name__ == '__main__':
    main()
