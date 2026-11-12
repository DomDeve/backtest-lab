#!/usr/bin/env python3
"""Dukascopy-M5 (data/dukascopy/<epic>) gegen Capital-M5 (data/raw/<epic>) im gemeinsamen Zeitraum abgleichen.

  python3 -I tools/dukascopy_compare.py   -> out/dukascopy/abgleich.md + abgleich.json

Je Epic: gemeinsame Kerzen (gleicher Zeitstempel UTC), Abweichung Mittelkurs (Schluss) absolut und in Punkten,
Korrelation der 5-Minuten-Renditen, Anteil Kerzen mit gleicher Richtung, Spread je Stunde (Median), Kerzen-Abdeckung der Session,
mittlere Kerzenspanne (High − Low, Mitte). Bewertung: brauchbar für Strategien, wenn Rendite-Korrelation ≥ 0,9,
Richtung ≥ 85 % gleich und Kerzenspanne ±10 %.
"""
import os, sys, csv, glob, json, math, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sessions as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'dukascopy')
EPICS = ['DE40', 'US100', 'EURUSD']

def load(files):
    d = {}
    for f in files:
        for r in csv.reader(open(f)):
            if not r or r[0] == 'timestamp' or len(r) < 9: continue
            try: v = [float(x) for x in r[1:9]]
            except ValueError: continue
            d[r[0][:16]] = v
    return d

def med(a):
    a = sorted(a); return a[len(a) // 2] if a else None

def corr(x, y):
    n = len(x); mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else None

def main():
    os.makedirs(OUT, exist_ok=True)
    res, md = {}, ['# Dukascopy vs. Capital (M5, gemeinsamer Zeitraum)', '']
    for epic in EPICS:
        cap = load(glob.glob(os.path.join(ROOT, 'data', 'raw', epic.lower(), '*MINUTE_5_*.csv')))
        dk_files = glob.glob(os.path.join(ROOT, 'data', 'dukascopy', epic.lower(), '*MINUTE_5_*.csv'))
        if not dk_files: md.append('## %s: keine Dukascopy-Daten' % epic); continue
        dk = load(dk_files)
        common = sorted(set(cap) & set(dk))
        if len(common) < 1000: md.append('## %s: zu wenig Überlappung (%d)' % (epic, len(common))); continue
        mid = lambda v, i: (v[i] + v[i + 4]) / 2
        diff = [mid(dk[k], 3) - mid(cap[k], 3) for k in common]
        rc, rd, same = [], [], 0
        for a, b in zip(common, common[1:]):
            ta = datetime.datetime.fromisoformat(a); tb = datetime.datetime.fromisoformat(b)
            if (tb - ta).seconds != 300: continue
            x = mid(cap[b], 3) - mid(cap[a], 3); y = mid(dk[b], 3) - mid(dk[a], 3)
            rc.append(x); rd.append(y); same += (x > 0) == (y > 0) if x and y else 0
        nz = sum(1 for x, y in zip(rc, rd) if x and y)
        rng_c = med([(cap[k][1] + cap[k][5]) / 2 - (cap[k][2] + cap[k][6]) / 2 for k in common])
        rng_d = med([(dk[k][1] + dk[k][5]) / 2 - (dk[k][2] + dk[k][6]) / 2 for k in common])
        sp = {}
        for k in common:
            h = k[11:13]; s = sp.setdefault(h, [[], []]); s[0].append(cap[k][7] - cap[k][3]); s[1].append(dk[k][7] - dk[k][3])
        # Session-Abdeckung: Kerzen je Session-Tag (Capital vs. Dukascopy) im gemeinsamen Zeitraum
        a0, a1 = common[0][:10], common[-1][:10]
        cov = []
        d = datetime.date.fromisoformat(a0)
        while d.isoformat() <= a1:
            w = S.session_utc(epic, d)
            if w:
                t, n_c, n_d, n_e = w[0], 0, 0, 0
                while t < w[1]:
                    k = t.strftime('%Y-%m-%dT%H:%M'); n_e += 1; n_c += k in cap; n_d += k in dk; t += datetime.timedelta(minutes=5)
                if n_c > n_e * 0.5: cov.append((n_c / n_e, n_d / n_e))
            d += datetime.timedelta(days=1)
        r = dict(common=len(common), from_=common[0], to=common[-1], diff_median=med(diff), diff_mad=med([abs(x - med(diff)) for x in diff]),
                 ret_corr=corr(rc, rd), same_dir=same / nz if nz else None, range_capital=rng_c, range_dukascopy=rng_d,
                 spread_capital=med([v for s in sp.values() for v in s[0]]), spread_dukascopy=med([v for s in sp.values() for v in s[1]]),
                 coverage_capital=sum(c[0] for c in cov) / len(cov), coverage_dukascopy=sum(c[1] for c in cov) / len(cov),
                 spread_by_hour={h: (med(v[0]), med(v[1])) for h, v in sorted(sp.items())})
        ok = (r['ret_corr'] or 0) >= 0.9 and (r['same_dir'] or 0) >= 0.85 and abs(rng_d / rng_c - 1) <= 0.1
        r['brauchbar'] = ok
        res[epic] = r
        g = lambda x, d=2: ('%.*f' % (d, x)).replace('.', ',') if x is not None else '–'
        dg = 5 if epic == 'EURUSD' else 2
        md += ['## %s (%s → %s, %d gemeinsame Kerzen)' % (epic, common[0][:10], common[-1][:10], len(common)), '',
               '| Kennzahl | Wert |', '|---|---|',
               '| Mittelkurs Dukascopy − Capital (Median, Schluss) | %s (typische Streuung %s) |' % (g(r['diff_median'], dg), g(r['diff_mad'], dg)),
               '| Korrelation 5-Min-Renditen | %s |' % g(r['ret_corr'], 3), '| gleiche Richtung | %s %% |' % g(100 * r['same_dir'], 1),
               '| Kerzenspanne Median Capital / Dukascopy | %s / %s |' % (g(rng_c, dg), g(rng_d, dg)),
               '| Spread Median Capital / Dukascopy | %s / %s |' % (g(r['spread_capital'], dg), g(r['spread_dukascopy'], dg)),
               '| Session-Abdeckung Capital / Dukascopy | %s %% / %s %% |' % (g(100 * r['coverage_capital'], 1), g(100 * r['coverage_dukascopy'], 1)),
               '| **brauchbar** (Korr. ≥ 0,9, Richtung ≥ 85 %%, Spanne ±10 %%) | **%s** |' % ('ja' if ok else 'nein'), '']
        print(epic, 'gemeinsam', len(common), 'Korr %.3f' % r['ret_corr'], 'Richtung %.1f %%' % (100 * r['same_dir']), 'Spanne %.2f/%.2f' % (rng_c, rng_d),
              'Spread %.5f/%.5f' % (r['spread_capital'], r['spread_dukascopy']), 'Diff %.5f' % r['diff_median'], 'brauchbar' if ok else 'NICHT brauchbar')
    json.dump(res, open(os.path.join(OUT, 'abgleich.json'), 'w'), indent=1)
    open(os.path.join(OUT, 'abgleich.md'), 'w').write('\n'.join(md) + '\n')

if __name__ == '__main__':
    main()
